"""执行登记：发起时写一行、结束时回填（判据 1 的排查线）。

产品模型是"发起会话就跑任务"，没有队列
--------------------------------------
所以在执行侧要做的不是"领取待办"，而是在两个时刻各留一个痕迹：**开始**与**结束**。
多个会话天然并行，每个 session 下可以有多条 run，互不排队、互不抢资源。

不这么做会怎样：执行器没启动、浏览器崩了、会话被关掉——这三种情况在库里都是"什么都
没有"，排查时只能去那台机器上翻 `output/runs/` 目录，而且"没发起"与"发起了但死了"
无法区分。

四条边界
--------
1. **先验件、后登记**。manifest 是 run 的身份（`create-run` 写的），执行侧只追加事实。
   缺 manifest 就不 `start`：否则库里留下一条永远 running 的记录，而根因是派发链路
   缺件——把链路问题伪装成"执行卡住"，比不登记更难查。
2. **manifest 的 run_id 必须等于要登记的 run_id**。不一致就拒绝，一个请求都不发：
   服务端按 facts.run_id 登记，交一条对不上的会凭空多出一次没人发起过的运行。
3. **指纹在执行之后算**。执行可能追加事实（exec IR、基线），先算再跑，交上去的指纹
   描述的是"跑之前的样子"，而服务端用它判断 manifest 有没有变。
4. **执行抛错不补 finish**。异常一律上抛，run 留在 `running`，读时按阈值标 `stalled`
   （疑似中断），由人重跑。**不自动重跑**：真机上有写操作（建用户、注销），自动续跑
   等于重复执行。也不写"失败结论"——执行侧无权把"我没跑起来"记成"用例失败"。
"""
from __future__ import annotations

import hashlib
import json
import os
import urllib.error
import urllib.request
from typing import Any, Callable, Mapping

__all__ = [
    "RunTraceError",
    "ManifestMissing",
    "RunIdentityMismatch",
    "RunTrace",
    "manifest_facts",
    "manifest_sha256",
    "recorded_run",
]


class RunTraceError(RuntimeError):
    """登记调用失败（网络/协议/服务端拒绝）。"""


class ManifestMissing(RuntimeError):
    """run 目录里没有 manifest：不是执行失败，是派发链路缺件。"""


class RunIdentityMismatch(RuntimeError):
    """manifest 的 run_id 与要登记的 run_id 不一致：拒绝登记，避免凭空多一条运行。"""


def manifest_sha256(path: str | os.PathLike[str]) -> str:
    with open(path, "rb") as handle:
        return "sha256:" + hashlib.sha256(handle.read()).hexdigest()


def manifest_facts(path: str | os.PathLike[str]) -> dict:
    """从 manifest 读出平台登记需要的几个字段。缺字段派生为 None，不猜。"""
    with open(path, encoding="utf-8") as handle:
        raw = json.load(handle)
    if not isinstance(raw, dict):
        raise RunTraceError("manifest 不是 JSON 对象")
    version = raw.get("manifest_version")
    baseline = raw.get("baseline_hash")
    if baseline is None and isinstance(raw.get("baseline"), dict):
        baseline = raw["baseline"].get("hash")
    return {
        "runId": raw.get("run_id"),
        "status": raw.get("status"),
        "manifestVersion": int(version) if isinstance(version, (int, float)) else None,
        "resourcePool": raw.get("resource_pool"),
        "sutVersion": raw.get("sut_version"),
        "baselineHash": baseline,
    }


class RunTrace:
    """两个动作的 HTTP 客户端。写操作不自动重试。

    超时后重发 start 会得到 409（run_id 已存在），重发 finish 会得到 409（已结束）——
    这两条都是**故意**的：不确定时让人看见，比让机器猜"这次是不是同一次"更安全。
    """

    def __init__(self, base_url: str, token: str, project_id: str, *, timeout: float = 15.0):
        self.base_url = base_url.rstrip("/")
        self.token = token
        self.project_id = project_id
        self.timeout = timeout

    def _post(self, path: str, payload: Mapping[str, Any]) -> dict | None:
        body = json.dumps(dict(payload), ensure_ascii=False).encode("utf-8")
        request = urllib.request.Request(
            f"{self.base_url}/api/projects/{self.project_id}{path}",
            data=body,
            method="POST",
            headers={"content-type": "application/json", "authorization": f"Bearer {self.token}"},
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                raw = response.read()
                return json.loads(raw.decode("utf-8")) if raw else None
        except urllib.error.HTTPError as error:
            detail = error.read().decode("utf-8", "replace")[:400]
            raise RunTraceError(f"HTTP {error.code} {path}: {detail}") from error
        except urllib.error.URLError as error:
            raise RunTraceError(f"无法连接平台 {self.base_url}: {error.reason}") from error

    def start(self, session_id: str, run_id: str, *, dispatch: Mapping[str, Any],
              env: str | None = None, kind: str | None = None,
              resource_pool: str | None = None) -> dict:
        payload: dict[str, Any] = {"runId": run_id, "dispatch": dict(dispatch)}
        if env is not None:
            payload["env"] = env
        if kind is not None:
            payload["kind"] = kind
        if resource_pool is not None:
            payload["resourcePool"] = resource_pool
        return (self._post(f"/qa/task-records/{session_id}/runs", payload) or {}).get("run", {})

    def finish(self, session_id: str, run_id: str, *, facts: Mapping[str, Any],
               manifest_path: str, sha256: str,
               counts: Mapping[str, int] | None = None) -> dict:
        payload = {
            "facts": dict(facts),
            "manifestPath": manifest_path,
            "manifestSha256": sha256,
            "counts": dict(counts or {}),
        }
        return (self._post(f"/qa/task-records/{session_id}/runs/{run_id}/finish", payload) or {}).get("run", {})


def recorded_run(trace: RunTrace, *, session_id: str, run_id: str, run_dir: str,
                 executor: Callable[[str], dict],
                 dispatch: Mapping[str, Any] | None = None,
                 env: str | None = None, kind: str | None = None,
                 resource_pool: str | None = None,
                 counts_from: Callable[[dict], Mapping[str, int]] | None = None) -> dict:
    """登记一次执行：验件 → start → 执行 → finish。返回结果摘要。

    `executor(run_dir)` 由调用方注入：只有它知道这份计划该用 WebEngine 还是 ApiEngine、
    授权从哪来。返回值必须含 `verdict`（pass/fail/blocked/error），本层只用它拼摘要，
    不重新判定。
    """
    manifest_path = os.path.join(run_dir, "manifest.json")
    if not os.path.exists(manifest_path):
        # 先验件、后登记：不留一条永远 running 的假记录。
        raise ManifestMissing(f"{manifest_path} 不存在：派发链路缺件，不登记本次执行")

    facts = manifest_facts(manifest_path)
    if facts.get("runId") != run_id:
        raise RunIdentityMismatch(f"manifest run_id={facts.get('runId')} 与要登记的 {run_id} 不一致")

    started = trace.start(
        session_id,
        run_id,
        dispatch=dispatch or {"run_dir": run_dir},
        env=env,
        kind=kind,
        resource_pool=resource_pool,
    )

    result = executor(run_dir)                      # 抛错即上抛：run 留在 running，标 stalled

    # 执行可能追加了事实（exec IR、基线），指纹在跑完之后算。
    finished = trace.finish(
        session_id,
        run_id,
        facts=facts,
        manifest_path=manifest_path,
        sha256=manifest_sha256(manifest_path),
        counts=counts_from(result) if counts_from else None,
    )
    return {
        "run_id": run_id,
        "started_status": started.get("status"),
        "verdict": result.get("verdict"),
        "run_status": finished.get("status"),
        "counts": finished.get("counts") or {},
    }
