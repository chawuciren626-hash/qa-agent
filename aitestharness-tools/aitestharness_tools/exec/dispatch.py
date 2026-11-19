"""从平台队列领取一次运行、执行、交回结果（判据 1 的执行侧半程）。

为什么执行侧要主动拉
--------------------
执行发生在用户的机器上（本地浏览器执行器），服务端既不能 spawn 它，也不能假定它在
线。于是队列只能反过来被消费：执行器轮询 → 领取租约 → 执行 → 交回。这一层就是那个
消费端；它只做三件事，不替平台判断"该不该跑"。

四条边界（都是"看起来能跑通、实际会制造假事实"的地方）
------------------------------------------------------
1. **没有 manifest 就不执行**。manifest 是 run 的身份（`create-run` 写的），执行侧
   只追加事实。自己造一份会得到没有 `directory_context` 的假 run，而它长得跟真的一模一样
   ——（`manifest.py` 的同一条规则，这里必须同样遵守）。缺 manifest 交回队列并记原因，
   不当成"执行失败"：这是派发链路的问题，不是被测产品的问题。
2. **manifest 里的 run_id 必须等于领到的 run_id**。不一致就直接拒绝，连交回都不做：
   服务端按 facts.run_id 登记，交回一条对不上的会凭空多出一次没人派发过的运行。
3. **指纹在执行之后算**。执行可能改 run 目录里的事实文件；先算再跑，交上去的指纹描述
   的是"跑之前的样子"，而服务端用它判断"manifest 有没有变"。
4. **执行抛错不伪造结论**。异常一律 `release`（附原因），由平台按 attempts 观察"反复
   拉起又失败"。执行侧无权把"我没跑起来"写成"用例失败"。
"""
from __future__ import annotations

import hashlib
import json
import os
import urllib.error
import urllib.request
from datetime import datetime, timezone
from typing import Any, Callable, Mapping

__all__ = [
    "DispatchError",
    "ManifestMissing",
    "RunIdentityMismatch",
    "PlatformQueue",
    "manifest_facts",
    "manifest_sha256",
    "consume_once",
]


class DispatchError(RuntimeError):
    """队列调用失败（网络/协议/服务端拒绝）。"""


class ManifestMissing(RuntimeError):
    """派发的 run 目录里没有 manifest：不是执行失败，是派发链路缺件。"""


class RunIdentityMismatch(RuntimeError):
    """manifest 的 run_id 与领到的 run_id 不一致：拒绝交回，避免凭空多一条运行。"""


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def manifest_sha256(path: str | os.PathLike[str]) -> str:
    with open(path, "rb") as handle:
        return "sha256:" + hashlib.sha256(handle.read()).hexdigest()


def manifest_facts(path: str | os.PathLike[str]) -> dict:
    """从 manifest 读出平台登记需要的几个字段。缺字段派生为 None，不猜。"""
    with open(path, encoding="utf-8") as handle:
        raw = json.load(handle)
    if not isinstance(raw, dict):
        raise DispatchError("manifest 不是 JSON 对象")
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


class PlatformQueue:
    """平台队列的 HTTP 客户端。只有三个动作，且都不重试写操作。

    写操作（claim/report/release）不自动重试：网络超时后重发可能造成"同一条 run 被
    领两次"或"结果交两次"。不确定时让人看见，比让机器猜更好。
    """

    def __init__(self, base_url: str, token: str, project_id: str, worker: str, *, timeout: float = 15.0):
        if not worker or "::" in worker:
            raise ValueError("worker 是执行器名，不能为空也不该含 '::'（服务端用它拼用户身份）")
        self.base_url = base_url.rstrip("/")
        self.token = token
        self.project_id = project_id
        self.worker = worker
        self.timeout = timeout

    def _post(self, path: str, payload: Mapping[str, Any] | None = None) -> tuple[int, dict | None]:
        body = json.dumps(dict(payload or {}), ensure_ascii=False).encode("utf-8")
        request = urllib.request.Request(
            f"{self.base_url}/api/projects/{self.project_id}{path}",
            data=body,
            method="POST",
            headers={"content-type": "application/json", "authorization": f"Bearer {self.token}"},
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                raw = response.read()
                return response.status, (json.loads(raw.decode("utf-8")) if raw else None)
        except urllib.error.HTTPError as error:
            detail = error.read().decode("utf-8", "replace")[:400]
            raise DispatchError(f"HTTP {error.code} {path}: {detail}") from error
        except urllib.error.URLError as error:
            raise DispatchError(f"无法连接平台 {self.base_url}: {error.reason}") from error

    def claim(self, *, kind: str | None = None, lease_ms: int | None = None) -> dict | None:
        payload: dict[str, Any] = {"worker": self.worker}
        if kind:
            payload["kind"] = kind
        if lease_ms:
            payload["leaseMs"] = lease_ms
        status, data = self._post("/qa/run-queue/claim", payload)
        if status == 204 or not data:
            return None
        return data

    def report(self, run_id: str, *, facts: Mapping[str, Any], manifest_path: str,
               sha256: str, counts: Mapping[str, int] | None = None) -> dict:
        _, data = self._post(f"/qa/run-queue/{run_id}/report", {
            "worker": self.worker,
            "facts": dict(facts),
            "manifestPath": manifest_path,
            "manifestSha256": sha256,
            "counts": dict(counts or {}),
        })
        return (data or {}).get("run", {})

    def release(self, run_id: str, reason: str) -> dict:
        _, data = self._post(f"/qa/run-queue/{run_id}/release", {"worker": self.worker, "reason": reason})
        return (data or {}).get("run", {})


def consume_once(queue: PlatformQueue, executor: Callable[[dict, str], dict], *,
                 kind: str | None = None, lease_ms: int | None = None,
                 counts_from: Callable[[dict], Mapping[str, int]] | None = None) -> dict:
    """领取一次 → 执行 → 交回。返回本次的结果摘要，不抛执行异常（交回队列并记原因）。

    `executor(dispatch, run_dir)` 由调用方注入：它才知道这份计划该用 WebEngine 还是
    ApiEngine、授权从哪来。返回值必须含 `verdict`（pass/fail/blocked/error），本层
    只用它拼摘要，不重新判定。
    """
    claim = queue.claim(kind=kind, lease_ms=lease_ms)
    if claim is None:
        return {"claimed": False}
    run = claim.get("run") or {}
    run_id = run.get("runId")
    if not run_id:
        raise DispatchError("claim 返回的 run 没有 runId")
    dispatch = run.get("dispatch") or {}
    run_dir = dispatch.get("run_dir") or dispatch.get("runDir")
    if not isinstance(run_dir, str) or not run_dir:
        queue.release(run_id, "dispatch_missing_run_dir")
        return {"claimed": True, "run_id": run_id, "executed": False, "reason": "dispatch_missing_run_dir"}

    manifest_path = os.path.join(run_dir, "manifest.json")
    if not os.path.exists(manifest_path):
        queue.release(run_id, "manifest_missing")
        raise ManifestMissing(f"{manifest_path} 不存在：派发链路缺件，交回队列")

    facts = manifest_facts(manifest_path)
    if facts.get("runId") != run_id:
        # 连 release 都不做：交回队列会让另一个执行器重复踩同一个坑，而根因要人看。
        raise RunIdentityMismatch(f"manifest run_id={facts.get('runId')} 与领取的 {run_id} 不一致")

    try:
        result = executor(dispatch, run_dir)
    except Exception as error:                      # noqa: BLE001 - 交回原因要带原始类型
        queue.release(run_id, f"executor_error:{type(error).__name__}")
        return {"claimed": True, "run_id": run_id, "executed": False, "reason": f"executor_error:{type(error).__name__}"}

    # 执行可能追加了事实（exec IR、基线），指纹在跑完之后算。
    counts = counts_from(result) if counts_from else None
    reported = queue.report(
        run_id,
        facts=facts,
        manifest_path=manifest_path,
        sha256=manifest_sha256(manifest_path),
        counts=counts,
    )
    return {
        "claimed": True,
        "run_id": run_id,
        "executed": True,
        "verdict": result.get("verdict"),
        "reclaimed": bool(claim.get("reclaimed")),
        "reported_at": _now(),
        "run_status": reported.get("status"),
        "counts": reported.get("counts") or {},
    }
