"""接口自动化最小执行引擎：DSL（YAML plan）→ HTTP → exec IR。

设计目标（v3 方案第 12 章）：
- 重放零 LLM：执行路径完全由 plan 决定，引擎不做任何决策；
- verdict 五档：pass / fail / flaky / skipped / inconclusive；
- 断言分级：observe（采集事实，不影响 verdict）/ decide（决定 verdict）；
- evidence：请求/响应正文入 evidence 包（有保留期），exec 长期资产不留入参（决议 #2）。

支持的步骤形态（最小集）：
  - driver: api, request: "POST /api/login", payload: {...}（支持 ${data.*} 引用）
  - assert: [{type: status_code, matcher: equals, expected: "200", decide: true},
             {type: json_path, path: $.code, matcher: equals, expected: "0", decide: true}]
  - extract: {token: $.data.token}   # 从本步响应取值写入变量池，供后续步骤 ${data.token} 引用
前置/登录态：通过 session 段（可选）先执行登录请求并把响应 token 写入变量。

变量池的两条边界（为什么 extract 必须显式声明、不能自动推断）：
  · 计划里出现 `${data.token}` 而没有任何一步 extract 过 token，应当在编译期被判死
    （那是"计划依赖了一个不存在的来源"，属于未声明上下文），而不是在执行期拿到
    字面量 `${data.token}` 发出去、再以一个看不懂的 401 结束；
  · extract 的 key 一旦写入变量池，后续所有步骤都能看到它——所以 key 名是接口契约的
    一部分，不是局部变量。重名覆盖只允许同一 session 内的登录刷新（见 `session`）。
"""
from __future__ import annotations

import json
import re
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone

import requests

from ..common.version import (CapabilityRegistry, runtime_stamp,
                              default_registry)
from .authorization import authorize_plan
from .consistency import not_verified_note, pick_repeatable

__all__ = ["ApiEngine", "run_plan"]

_DATA_REF = re.compile(r"\$\{data\.([A-Za-z0-9_.]+)\}")
_JSONPATH_SIMPLE = re.compile(r"^\$\.([A-Za-z0-9_.]+)$")


def _resolve(data_ref_text, data: dict):
    """把文本/对象中的 ${data.x.y} 替换为 data 值。"""
    if isinstance(data_ref_text, str):
        def repl(m):
            cur = data
            for k in m.group(1).split("."):
                if not isinstance(cur, dict) or k not in cur:
                    return m.group(0)  # 解析不了就原样保留，闸3会拦硬编码
                cur = cur[k]
            # re.sub 的回调必须返回字符串：dict/list 值若原样返回会抛 TypeError
            return cur if isinstance(cur, str) else json.dumps(cur, ensure_ascii=False, default=str)
        return _DATA_REF.sub(repl, data_ref_text)
    if isinstance(data_ref_text, dict):
        return {k: _resolve(v, data) for k, v in data_ref_text.items()}
    if isinstance(data_ref_text, list):
        return [_resolve(v, data) for v in data_ref_text]
    return data_ref_text


def _json_get(payload, path: str):
    m = _JSONPATH_SIMPLE.match(path or "")
    if not m:
        return None, f"unsupported json_path: {path}（最小引擎仅支持 $.a.b 形式）"
    cur = payload
    for k in m.group(1).split("."):
        if isinstance(cur, dict) and k in cur:
            cur = cur[k]
        else:
            return None, f"path '{path}' 不存在"
    return cur, None


def _apply_matcher(actual, matcher: str, expected) -> bool:
    if matcher == "equals":
        return str(actual) == str(expected)
    if matcher == "not_equals":
        return str(actual) != str(expected)
    if matcher == "contains":
        return str(expected) in str(actual)
    if matcher == "not_contains":
        return str(expected) not in str(actual)
    if matcher == "null":
        return actual is None
    if matcher == "not_null":
        return actual is not None
    if matcher in ("gt", "gte", "lt", "lte"):
        try:
            a, e = float(actual), float(expected)
        except (TypeError, ValueError):
            return False
        return {"gt": a > e, "gte": a >= e, "lt": a < e, "lte": a <= e}[matcher]
    if matcher == "between":
        lo, hi = expected if isinstance(expected, (list, tuple)) else (expected.get("lo"), expected.get("hi"))
        return str(lo) <= str(actual) <= str(hi)
    if matcher == "in_set":
        return str(actual) in [str(x) for x in (expected or [])]
    if matcher == "regex":
        return re.search(str(expected), str(actual)) is not None
    return False


@dataclass
class StepResult:
    # session 段的前置步骤没有业务步骤序号，用 "s1"/"login" 这类标识，不挤占 0..n 的编号
    index: int | str
    action: str
    status: str                    # pass / fail / error
    assertions: list = field(default_factory=list)
    evidence: dict = field(default_factory=dict)
    duration_ms: int = 0
    extracted: dict = field(default_factory=dict)


def _authorization_ir(gate: dict | None) -> dict:
    """授权判定的 IR 投影。字段与 web_engine 的同名函数保持一致——
    报告层不该因为"这条用例是 api 还是 web"而读两套字段名。"""
    if not gate:
        return {"status": "not_evaluated", "allow": None}
    return {
        "status": gate.get("status"),
        "allow": gate.get("allow"),
        "verdict": gate.get("verdict"),
        "approval_id": gate.get("approval_id"),
        "issued_by": gate.get("issued_by"),
        "expires_at": gate.get("expires_at"),
        "plan_hash": gate.get("plan_hash"),
        "env_id": gate.get("env_id"),
        "required_actions": gate.get("required_actions") or [],
        "trust": gate.get("trust"),
        "reasons": gate.get("reasons") or [],
    }


# 哨兵：区分"未传参"与"显式传 None（无授权）"
_UNSET = object()


class ApiEngine:
    """确定性 HTTP 执行器。base_url 与 data 在构造时注入，plan 中不落任何环境细节。"""

    def __init__(self, base_url: str, data: dict | None = None, timeout: int = 30,
                 registry: CapabilityRegistry | None = None,
                 authorization: dict | None = None, env_id: str | None = None):
        self.base_url = base_url.rstrip("/")
        self.data = data or {}
        # 写操作授权（P4 判据 3）：与 web 侧同一个闸、同一套语义
        self.authorization = authorization
        self.env_id = env_id
        self.timeout = timeout
        self.session = requests.Session()
        # 能力包注册表：执行期会被冻结（§24.7），stamp 由此产出
        self.registry = registry if registry is not None else default_registry()

    def run_plan(self, plan: dict, *, authorization=_UNSET, env_id=_UNSET) -> dict:
        """执行一份 type: api 的 plan，返回 exec IR 正文（不含公共头，由上层补 lineage）。

        `authorization` / `env_id` 可覆盖构造值：replay 的引擎由工厂造、计划后到，
        拿不到计划就无法在构造时签授权。用哨兵区分"没传"与"显式无授权"。
        """
        approval = self.authorization if authorization is _UNSET else authorization
        scope_id = self.env_id if env_id is _UNSET else env_id
        # 版本冻结 + stamp 在会话开始时取一次：执行期间任何能力包变更都抛错，
        # 保证同一份 exec IR 里记的版本就是实际跑的版本。
        scope = self.registry.frozen_scope()
        with scope:
            stamp = runtime_stamp(self.registry)
            started = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
            step_results: list[StepResult] = []
            verdict = "pass"
            consistency = {"status": "not_run", "reason": "未执行到一致性检查", "repeats": 0}
            halt = None
            # 授权判定必须在 session 之前：登录本身是 POST，等它跑完再判等于
            # "已经建了会话才问允不允许"——顺序反了
            gate = authorize_plan(plan, approval, env_id=scope_id)
            if not gate["allow"]:
                return self._build_exec(
                    plan, [], gate["verdict"], started, stamp,
                    halt={"stage": "authorization", "step": None, "attribution": "script",
                          "because": "；".join(gate["reasons"])},
                    consistency={"status": "skipped", "reason": "未获授权，未执行",
                                 "repeats": 0},
                    authorization=gate)
            # 前置（session 段）：登录 / 取 token。失败即不进入业务步骤——
            # 拿未登录态去跑业务断言，只会把"登录失败"伪装成一串业务失败，
            # 归因阶段再想把它拆开就得逐个反推，代价远高于在此处止步。
            for j, step in enumerate(plan.get("session") or []):
                sr = self._run_step(f"session-{j}", step)
                step_results.append(sr)
                if sr.status != "pass":
                    verdict = "inconclusive"
                    halt = {"stage": "session", "step": sr.index,
                            "because": "前置登录/取凭证未通过，业务步骤未执行"}
                    break
            for i, step in enumerate(plan.get("steps") or []):
                if halt is not None:
                    break
                sr = self._run_step(i, step)
                step_results.append(sr)
                if sr.status == "fail":
                    # decide 断言失败 → fail；observe 失败只记录
                    has_decide_fail = any(a["decide"] and not a["passed"]
                                          for a in sr.assertions)
                    if has_decide_fail:
                        verdict = "fail"
                        break
                elif sr.status == "error":
                    # 环境/连接层失败 → inconclusive，不判 fail（不冤枉被测系统）
                    verdict = "inconclusive"
                    break
            if verdict == "pass":
                verdict, consistency = self._consistency(plan)  # N=3，仅限安全步骤
            else:
                consistency = {"status": "skipped", "reason": "结论已非 pass，无需复跑",
                               "repeats": 0}
        return self._build_exec(plan, step_results, verdict, started, stamp, halt, consistency,
                                authorization=gate)

    def _run_step(self, i: int | str, step: dict) -> StepResult:
        t0 = time.time()
        method, path = None, None
        # request 也要解析变量：`GET /api/orders/${data.order_id}` 是真实用例的常态，
        # 只解析 payload/headers 会让"上一步拿到的 id"没法用在路径上
        raw_request = str(_resolve(str(step.get("request") or ""), self.data))
        m = re.match(r"^(GET|POST|PUT|PATCH|DELETE)\s+(\S+)$",
                     raw_request, re.I)
        if m:
            method, path = m.group(1).upper(), m.group(2)
        else:
            method = str(step.get("method") or "GET").upper()
            path = str(_resolve(str(step.get("endpoint") or ""), self.data))
        payload = _resolve(step.get("payload") or step.get("data"), self.data)
        headers = _resolve(step.get("headers") or {}, self.data)
        try:
            resp = self.session.request(
                method, f"{self.base_url}{path}",
                json=payload if isinstance(payload, (dict, list)) else None,
                data=None if isinstance(payload, (dict, list)) else payload,
                headers=headers or None, timeout=self.timeout)
            http_ok = True
        except requests.RequestException as exc:
            return StepResult(i, f"{method} {path}", "error",
                              evidence={"error": str(exc)},
                              duration_ms=int((time.time() - t0) * 1000))
        sr = StepResult(i, f"{method} {path}", "pass",
                        duration_ms=int((time.time() - t0) * 1000))
        sr.evidence = {
            "request": {"method": method, "path": path, "payload": payload},
            "response": {"status": resp.status_code,
                         "body_excerpt": resp.text[:2000]},
        }
        try:
            body = resp.json()
        except ValueError:
            body = resp.text
        for j, a in enumerate(step.get("assert") or []):
            atype = a.get("type")
            if atype == "status_code":
                actual, err = resp.status_code, None
            elif atype == "json_path":
                actual, err = _json_get(body, a.get("path"))
            else:
                actual, err = None, f"unsupported assert type: {atype}"
            passed = err is None and _apply_matcher(actual, a.get("matcher"), a.get("expected"))
            sr.assertions.append({
                "index": j, "type": atype, "matcher": a.get("matcher"),
                "expected": a.get("expected"), "actual": _safe(actual),
                "decide": bool(a.get("decide")), "passed": passed,
                "source": a.get("source"),
            })
            if a.get("decide") and not passed:
                sr.status = "fail"
        # 变量提取：只认显式 extract 声明（见模块 docstring 的两条边界）。
        # 提取到的是**敏感值**（token/会话 id），所以只写变量池与 evidence（短期），
        # 不写 exec IR（长期资产不留入参，决议 #2）。
        for key, path in (step.get("extract") or {}).items():
            value, err = _json_get(body, path)
            if err is not None:
                sr.evidence.setdefault("extract_errors", {})[str(key)] = err
                continue
            self.data[str(key)] = value
            sr.extracted[str(key)] = _safe(value)
        return sr

    def _consistency(self, plan: dict, n: int = 3) -> tuple[str, dict]:
        """N=3 一致性（最小实现）：在**允许复跑**的步骤上重复 n 次比对结论。

        复跑对象不是"第一个 decide 步骤"，而是"第一个 decide 且不会产生副作用的步骤"
        （见 exec/consistency.py）。选不出对象时如实记 not_verified：
        静默返回 pass 等于宣称"已验证可复现"，而实际一次都没验证。
        """
        picked = pick_repeatable(plan.get("steps") or [], "api")
        if picked is None:
            return "pass", {"status": "not_verified",
                            "reason": not_verified_note(plan.get("steps") or [], "api"),
                            "repeats": 0}
        outcomes = {}
        for _ in range(n - 1):
            sr = self._run_step(picked["index"], picked["step"])
            failed = [a for a in sr.assertions if a["decide"] and not a["passed"]]
            key = "fail" if failed else "pass"
            outcomes[key] = outcomes.get(key, 0) + 1
        info = {"status": "flaky" if "fail" in outcomes else "verified",
                "target": picked["index"], "reason": picked["reason"],
                "repeats": n - 1,
                "outcomes": outcomes}
        return ("flaky" if "fail" in outcomes else "pass"), info

    def _build_exec(self, plan, step_results, verdict, started, stamp=None, halt=None,
                    consistency=None, authorization=None) -> dict:
        stamp = stamp or runtime_stamp(self.registry)
        return {
            "type": "exec",
            "plan": {"id": plan.get("lineage", {}).get("id"),
                     "version": plan.get("lineage", {}).get("version")},
            "driver": "api",
            # §24.7 决策 57：每条执行结果记版本戳，供 flaky 判定与事故追溯
            "engine_version": stamp["engine_version"],
            "schema_version": stamp["schema_version"],
            "capability_versions": stamp["capability_versions"],
            "started_at": started,
            "finished_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "verdict": verdict,
            # 一致性检查的实际范围：verified / flaky / not_verified / skipped。
            # 这一栏存在的意义是让"没验证"和"验证过"在报告里长得不一样。
            "consistency": consistency or {"status": "not_run", "repeats": 0},
            # 中途止步的原因（当前只有"前置未通过"）：不写原因的话，一个全是 0 步的
            # exec IR 在报告层看起来跟"用例没有步骤"完全一样
            "halt": halt,
            "authorization": _authorization_ir(authorization),
            "steps": [{
                "index": sr.index, "action": sr.action, "status": sr.status,
                "assertions": sr.assertions, "duration_ms": sr.duration_ms,
                # 只记提取了哪些 key，不记值：token 之类不许进长期资产
                "extracted_keys": sorted(sr.extracted),
            } for sr in step_results],
            "evidence_refs": [f"evidence://{plan.get('lineage', {}).get('id')}/step-{sr.index}"
                              for sr in step_results if sr.evidence],
        }


def _safe(v):
    return v if isinstance(v, (str, int, float, bool, type(None))) else str(v)


def run_plan(plan: dict, base_url: str, data: dict | None = None,
             registry: CapabilityRegistry | None = None, *,
             authorization: dict | None = None, env_id: str = "local") -> dict:
    """便捷入口：构造引擎并执行。

    `authorization` 与 `env_id` 透传给引擎（判据 3 的闸在引擎里）。便捷入口曾漏掉这两个
    参数，于是"用便捷入口就绕过了授权闸"——不是实现了绕过，而是唯一能跑的入口没有
    开口，调用方只能去掉闸。授权仍然是记录（有 id / 签发人 / 范围），不是布尔开关。
    """
    return ApiEngine(base_url, data, registry=registry).run_plan(
        plan, authorization=authorization, env_id=env_id)
