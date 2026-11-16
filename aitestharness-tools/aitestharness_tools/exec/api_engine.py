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
前置/登录态：通过 session 段（可选）先执行登录请求并把响应 token 写入变量。
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
            return str(cur) if not isinstance(cur, (dict, list)) else cur
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
    index: int
    action: str
    status: str                    # pass / fail / error
    assertions: list = field(default_factory=list)
    evidence: dict = field(default_factory=dict)
    duration_ms: int = 0


class ApiEngine:
    """确定性 HTTP 执行器。base_url 与 data 在构造时注入，plan 中不落任何环境细节。"""

    def __init__(self, base_url: str, data: dict | None = None, timeout: int = 30,
                 registry: CapabilityRegistry | None = None):
        self.base_url = base_url.rstrip("/")
        self.data = data or {}
        self.timeout = timeout
        self.session = requests.Session()
        # 能力包注册表：执行期会被冻结（§24.7），stamp 由此产出
        self.registry = registry if registry is not None else default_registry()

    def run_plan(self, plan: dict) -> dict:
        """执行一份 type: api 的 plan，返回 exec IR 正文（不含公共头，由上层补 lineage）。"""
        # 版本冻结 + stamp 在会话开始时取一次：执行期间任何能力包变更都抛错，
        # 保证同一份 exec IR 里记的版本就是实际跑的版本。
        scope = self.registry.frozen_scope()
        with scope:
            stamp = runtime_stamp(self.registry)
            started = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
            step_results: list[StepResult] = []
            verdict = "pass"
            for i, step in enumerate(plan.get("steps") or []):
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
                verdict = self._consistency(plan)  # N=3 一致性复跑（引擎内最小实现）
        return self._build_exec(plan, step_results, verdict, started, stamp)

    def _run_step(self, i: int, step: dict) -> StepResult:
        t0 = time.time()
        method, path = None, None
        m = re.match(r"^(GET|POST|PUT|PATCH|DELETE)\s+(\S+)$",
                     str(step.get("request") or ""), re.I)
        if m:
            method, path = m.group(1).upper(), m.group(2)
        else:
            method = str(step.get("method") or "GET").upper()
            path = str(step.get("endpoint") or "")
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
        return sr

    def _consistency(self, plan: dict, n: int = 3) -> str:
        """N=3 一致性（最小实现）：关键步骤（首个 decide 请求）复跑 n 次比对 verdict。"""
        first = None
        for s in plan.get("steps") or []:
            if any(a.get("decide") for a in (s.get("assert") or [])):
                first = s
                break
        if first is None:
            return "pass"
        outcomes = set()
        for _ in range(n - 1):
            sr = self._run_step(-1, first)
            outcomes.add("fail" if any(a["decide"] and not a["passed"] for a in sr.assertions)
                         else "pass")
        outcomes.discard("pass")
        return "flaky" if outcomes else "pass"

    def _build_exec(self, plan, step_results, verdict, started, stamp=None) -> dict:
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
            "steps": [{
                "index": sr.index, "action": sr.action, "status": sr.status,
                "assertions": sr.assertions, "duration_ms": sr.duration_ms,
            } for sr in step_results],
            "evidence_refs": [f"evidence://{plan.get('lineage', {}).get('id')}/step-{sr.index}"
                              for sr in step_results if sr.evidence],
        }


def _safe(v):
    return v if isinstance(v, (str, int, float, bool, type(None))) else str(v)


def run_plan(plan: dict, base_url: str, data: dict | None = None,
             registry: CapabilityRegistry | None = None) -> dict:
    """便捷入口：构造引擎并执行。"""
    return ApiEngine(base_url, data, registry=registry).run_plan(plan)
