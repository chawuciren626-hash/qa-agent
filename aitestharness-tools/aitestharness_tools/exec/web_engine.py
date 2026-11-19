"""Web 执行引擎：plan（YAML/JSON）→ 浏览器动作 → exec IR。

一条用例"没通过"至少有三种完全不同的含义，混成一种就是 UI 自动化最常见的自毁方式：

  · **fail**    —— 页面确实没达到预期。只有 decide 级断言不成立、或声明的等待条件
                   超时才走到这里。这类结论可以报缺陷。
  · **blocked** —— 剧本没能作用到目标上：定位未命中/多命中、动作被遮挡、计划用了本
                   驱动不支持的写法。结论判 `inconclusive`，**不判产品缺陷**。
  · **error**   —— 环境不可达：导航失败、浏览器异常。结论判 `inconclusive`。

为什么 blocked 不判 fail：一个没找到了的按钮，可能是产品没渲染（真缺陷），也可能是
页面改版把 data-testid 改了（脚本过期）。在拿到基线指纹与自愈结果之前这两者无法区
分；此时判 fail 等于把"脚本过期"记成产品 bug。一次误报要花几小时解释，报三次以后就
没人再看报告了——这比漏报更贵。

**没有隐式断言，只有隐式等待**：元素出现与否由 `locator_timeout_ms` 轮询解决（这不是
sleep，是等待条件）；但"页面对不对"一律由 plan 里的 assert 决定，引擎不替作者判定。
"""
from __future__ import annotations

import re
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone

from ..common.version import CapabilityRegistry, default_registry, runtime_stamp
from .api_engine import _resolve
from .consistency import not_verified_note, pick_repeatable
from .locator import (LocatorSpecError, describe_query, fingerprint_query,
                      resolve_target, target_locators)
from .wait_assert import (WAIT_DEFAULTS, AssertionEngine, assertion_level,
                          check_wait_step)
from .web_driver import wait_until

__all__ = ["WebEngine", "run_web_plan", "validate_plan", "WEB_SUPPORTED_ACTIONS",
           "WEB_ASSERT_TYPES"]

# 本驱动真正支持的步骤动作。枚举里其余值（upload/download/request/db_query/
# switch_context）不是"以后再说"，而是**在编译期明确拒绝**——静默跳过会让计划
# 少跑一步却照样 pass，那是所有假通过里最难发现的一种。
WEB_SUPPORTED_ACTIONS = ("goto", "navigate", "click", "fill", "press", "select",
                         "hover", "scroll", "wait", "extract")
UNSUPPORTED = ("upload", "download", "request", "db_query", "switch_context")

WEB_ASSERT_TYPES = ("url_contains", "url_matches", "visible", "hidden", "text_visible",
                    "text_equals", "value_equals", "attribute_equals", "count_equals")


@dataclass
class StepResult:
    index: int | str
    action: str
    status: str                       # pass / fail / blocked / error
    assertions: list = field(default_factory=list)
    waits: list = field(default_factory=list)
    evidence: dict = field(default_factory=dict)
    duration_ms: int = 0
    extracted: dict = field(default_factory=dict)
    attribution: str = "product"      # product / script / env
    failure_kind: str | None = None
    locator: dict | None = None       # 本次动作的定位判定（含降级记录）


def validate_plan(plan: dict) -> list[str]:
    """编译期检查：动作/等待/定位/断言全部在封闭枚举内。返回违例列表。"""
    errors: list[str] = []
    steps = plan.get("steps") or []
    if not isinstance(steps, list) or not steps:
        return ["plan.steps 为空：没有可执行的步骤"]
    for index, step in enumerate(steps):
        where = f"step[{index}]"
        if not isinstance(step, dict):
            errors.append(f"{where} 不是映射")
            continue
        action = str(step.get("action") or "").strip()
        if action in UNSUPPORTED:
            errors.append(f"{where} 动作 '{action}' 本驱动不支持（明确拒绝而非静默跳过）")
        elif action not in WEB_SUPPORTED_ACTIONS:
            errors.append(f"{where} 未知动作 '{action}'；支持：{list(WEB_SUPPORTED_ACTIONS)}")
        errors.extend(f"{where} {e}" for e in check_wait_step(step))
        try:
            locators, _ = target_locators(step.get("target") or {})
            for fingerprint in locators:
                fingerprint_query(fingerprint)
        except LocatorSpecError as error:
            errors.append(f"{where} 定位声明有误：{error}")
        for j, assertion in enumerate(step.get("assert") or []):
            atype = assertion.get("type")
            if atype not in WEB_ASSERT_TYPES:
                errors.append(f"{where}.assert[{j}] 断言类型 '{atype}' 不在 web 支持集 "
                              f"{list(WEB_ASSERT_TYPES)}")
    return errors


class WebEngine:
    """确定性浏览器执行器。driver 注入，plan 里不落环境细节（base_url 由驱动持有）。"""

    def __init__(self, driver, data: dict | None = None, *,
                 locator_timeout_ms: int = 3000, poll_ms: int = 100,
                 registry: CapabilityRegistry | None = None):
        self.driver = driver
        self.data = data or {}
        self.locator_timeout_ms = locator_timeout_ms
        self.poll_ms = poll_ms
        self.registry = registry if registry is not None else default_registry()
        self._assertions = AssertionEngine()

    # ---- 主流程 ----------------------------------------------------------
    def run_plan(self, plan: dict) -> dict:
        scope = self.registry.frozen_scope()
        with scope:
            stamp = runtime_stamp(self.registry)
            started = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
            problems = validate_plan(plan)
            if problems:
                return self._build_exec(
                    plan, [], "inconclusive", started, stamp,
                    halt={"stage": "compile", "step": None, "attribution": "script",
                          "because": "计划未通过编译期校验，未启动浏览器"},
                    consistency={"status": "skipped", "reason": "计划未执行", "repeats": 0},
                    compile_errors=problems)

            step_results: list[StepResult] = []
            verdict, halt = "pass", None
            # 请求记录按计划清一次：request_done 等的是"本计划期间发生的请求"，
            # 不清会把上一份计划访问 home 的记录也算进来，制造假通过
            if hasattr(self.driver, "clear_requests"):
                self.driver.clear_requests()
            for index, step in enumerate(plan.get("steps") or []):
                result = self._run_step(index, step)
                step_results.append(result)
                decided_failed = [a for a in result.assertions
                                  if a["decide"] and not a["passed"]]
                if result.status == "fail" and decided_failed:
                    verdict = "fail"
                    halt = {"stage": "step", "step": result.index, "attribution": "product",
                            "because": f"第 {index} 步的 decide 断言不成立"}
                    break
                if result.status == "fail":
                    verdict = "fail"
                    halt = {"stage": "step", "step": result.index,
                            "attribution": result.attribution,
                            "because": f"第 {index} 步未通过：{result.failure_kind}"}
                    break
                if result.status in ("blocked", "error"):
                    # 后续步骤依赖这一步的结果：继续跑只会在错误前提上制造更多噪音
                    verdict = "inconclusive"
                    halt = {"stage": "step", "step": result.index,
                            "attribution": result.attribution,
                            "because": f"第 {index} 步{'无法作用到目标' if result.status == 'blocked' else '环境异常'}"
                                       f"：{result.failure_kind}"}
                    break
            consistency = self._consistency(plan, verdict)
            self._teardown(plan)
        return self._build_exec(plan, step_results, verdict, started, stamp, halt, consistency)

    def _consistency(self, plan: dict, verdict: str) -> dict:
        if verdict != "pass":
            return {"status": "skipped", "reason": "结论已非 pass，无需复跑", "repeats": 0}
        picked = pick_repeatable(plan.get("steps") or [], "web")
        if picked is None:
            # 不假装验证过：web 的一致性由 replay 层（N 轮重放）负责，
            # 引擎内复跑一个 click 只会重复提交
            return {"status": "not_verified", "repeats": 0,
                    "reason": not_verified_note(plan.get("steps") or [], "web")}
        outcomes: dict = {}
        for _ in range(2):
            result = self._run_step(f"repeat-{picked['index']}", picked["step"])
            key = result.status
            outcomes[key] = outcomes.get(key, 0) + 1
        return {"status": "flaky" if set(outcomes) - {"pass"} else "verified",
                "target": picked["index"], "reason": picked["reason"],
                "repeats": 2, "outcomes": outcomes}

    def _teardown(self, plan: dict) -> None:
        for step in plan.get("teardown") or []:
            if str(step.get("action") or "") == "reset_session":
                reset = getattr(self.driver, "reset", None)
                if callable(reset):
                    reset()

    # ---- 单步 ------------------------------------------------------------
    def _run_step(self, index: int | str, step: dict) -> StepResult:
        started = time.time()
        action = str(step.get("action") or "").strip()
        result = StepResult(index, action or "(空)", "pass")
        try:
            if action in ("goto", "navigate"):
                self._goto(step, result)
            elif action == "wait":
                self._apply_waits(step, result)
            elif action == "extract":
                self._extract(step, result)
            else:
                self._act(step, action, result)
            if result.status == "pass" and action != "wait":
                # wait 动作已经自己跑过等待，再跑一遍等于等两次（超时翻倍）
                self._apply_waits(step, result)
            if result.status == "pass":
                self._apply_asserts(step, result)
            if result.status == "pass" and step.get("extract") and action != "extract":
                # 提取放在断言之后：先判"这一步做对了没有"，再取值——
                # 反过来会让一次失败的步骤也往变量池里写半截脏值
                self._extract(step, result)
        except LocatorSpecError as error:
            result.status, result.attribution = "blocked", "script"
            result.failure_kind = "locator_spec_invalid"
            result.evidence["error"] = str(error)
        except Exception as error:                       # 驱动异常 ≠ 产品问题
            result.status, result.attribution = "error", "env"
            result.failure_kind = "driver_error"
            result.evidence["error"] = f"{type(error).__name__}: {error}"
        result.duration_ms = int((time.time() - started) * 1000)
        return result

    def _goto(self, step: dict, result: StepResult) -> None:
        target = step.get("target") or {}
        url = target.get("url") or step.get("url")
        if not url:
            result.status, result.attribution = "blocked", "script"
            result.failure_kind = "missing_url"
            result.evidence["error"] = "goto 步骤缺少 target.url"
            return
        opened = self.driver.open(str(_resolve(str(url), self.data)))
        result.evidence["navigation"] = opened
        if not opened.get("ok"):
            result.status, result.attribution = "error", "env"
            result.failure_kind = "env_unreachable"
        return

    def _act(self, step: dict, action: str, result: StepResult) -> None:
        decision = self._resolve(step.get("target") or {})
        result.locator = decision
        result.evidence["locator"] = _decision_evidence(decision)
        if decision["status"] != "ok":
            result.status, result.attribution = "blocked", "script"
            result.failure_kind = decision["status"]
            return
        query = decision["query"]
        value = _resolve(step.get("value"), self.data) if step.get("value") is not None else None
        key = step.get("key")
        driver_action = {"navigate": "click"}.get(action, action)
        if action == "scroll":
            outcome = self.driver.act("scroll", None if value is None else query,
                                      value=value if value is not None else "800")
        else:
            outcome = self.driver.act(driver_action, query, value=value, key=key)
        result.evidence["action"] = outcome
        if not outcome.get("ok"):
            # 定位到了但动作没完成（遮挡/不可点/超时）：剧本没作用到目标，
            # 归因为 script（剧本假设与现实不符），不直接判产品缺陷
            result.status, result.attribution = "blocked", "script"
            result.failure_kind = "action_failed"

    def _extract(self, step: dict, result: StepResult) -> None:
        for key, spec in (step.get("extract") or {}).items():
            if not isinstance(spec, dict):
                raise LocatorSpecError(
                    f"extract['{key}'] 必须是映射（from: text|value|attribute + target），"
                    f"收到 {type(spec).__name__}")
            source = str(spec.get("from") or "text")
            decision = self._resolve(spec.get("target") or step.get("target") or {})
            if decision["status"] != "ok":
                result.status, result.attribution = "blocked", "script"
                result.failure_kind = decision["status"]
                result.evidence.setdefault("extract_errors", {})[key] = decision.get("detail")
                return
            if source == "text":
                value = self.driver.probe(decision["query"]).get("text")
            elif source == "value":
                value = self.driver.probe(decision["query"]).get("value")
            elif source == "attribute":
                value = self.driver.attribute(decision["query"], str(spec.get("attribute") or ""))
            else:
                raise LocatorSpecError(f"extract['{key}'].from='{source}' 不在 text/value/attribute 内")
            if value is None:
                result.status, result.attribution = "blocked", "script"
                result.failure_kind = "extract_empty"
                return
            self.data[str(key)] = value
            result.extracted[str(key)] = str(value)[:200]

    # ---- 等待 ------------------------------------------------------------
    def _apply_waits(self, step: dict, result: StepResult) -> None:
        specs = step.get("wait")
        specs = specs if isinstance(specs, list) else ([specs] if specs else [])
        for spec in specs:
            if not isinstance(spec, dict):
                spec = {"type": str(spec)}
            outcome = self._wait(spec)
            result.waits.append({"type": spec.get("type"), **outcome})
            if not outcome["ok"]:
                result.status = "fail"
                result.failure_kind = "wait_timeout"
                result.attribution = "product"
                return

    def _wait(self, spec: dict) -> dict:
        """执行一条等待声明。

        元素类等待**每轮重新定位**，而不是先花 `locator_timeout_ms` 等元素出现、再花
        `timeout_ms` 等条件成立——那样两个超时叠加，声明 10s 的等待实际会拖到 13s，
        而报告上显示的还是 10s。
        """
        kind = str(spec.get("type") or "")
        timeout = int(spec.get("timeout_ms") or WAIT_DEFAULTS["timeout_ms"])
        interval = int(spec.get("poll_interval_ms") or self.poll_ms)

        if kind == "element_visible":
            return wait_until(lambda: {"ok": _probe_field(self, spec.get("target"), "visible")},
                              timeout, interval)
        if kind == "element_enabled":
            return wait_until(lambda: {"ok": _probe_field(self, spec.get("target"), "enabled")},
                              timeout, interval)
        if kind == "element_stable":
            return self._wait_stable(spec, timeout, interval)
        if kind == "network_idle":
            return wait_until(lambda: {"ok": self.driver.inflight() == 0,
                                       "inflight": self.driver.inflight()}, timeout, interval)
        if kind == "request_done":
            return self._wait_request(spec.get("pattern") or "", timeout, interval)
        if kind == "url_matches":
            pattern = str(_resolve(str(spec.get("pattern") or ""), self.data))
            return wait_until(lambda: {"ok": bool(re.search(pattern, self.driver.url())),
                                       "url": self.driver.url()}, timeout, interval)
        if kind == "text_changed":
            state: dict = {"initial": None}

            def changed() -> dict:
                probe = _probe(self, spec.get("target"))
                text = probe.get("text")
                if text is None:
                    return {"ok": False, "reason": "定位未就绪"}
                if state["initial"] is None:
                    state["initial"] = text
                    return {"ok": False, "initial": text[:120], "reason": "已取初值，等待变化"}
                return {"ok": text != state["initial"],
                        "initial": (state["initial"] or "")[:120], "current": text[:120]}

            return wait_until(changed, timeout, interval)
        if kind == "attribute_equals":
            name = str(spec.get("attribute") or "")
            expected = str(_resolve(str(spec.get("value") or ""), self.data))

            def matches() -> dict:
                decision = self._resolve(spec.get("target") or {}, retry=False)
                if decision["status"] != "ok":
                    return {"ok": False, "reason": decision.get("detail")}
                actual = self.driver.attribute(decision["query"], name)
                return {"ok": str(actual) == expected, "attribute": name,
                        "expected": expected, "actual": actual}

            return wait_until(matches, timeout, interval)
        return {"ok": False, "reason": f"未实现的等待类型：{kind}"}

    def _wait_stable(self, spec: dict, timeout: int, interval: int) -> dict:
        need = int(spec.get("stable_frames") or WAIT_DEFAULTS["stable_frames"])
        state = {"last": None, "same": 0}

        def check() -> dict:
            box = _probe(self, spec.get("target")).get("box")
            if box is None:
                state["last"], state["same"] = None, 0
                return {"ok": False, "reason": "元素不可见，取不到位置"}
            if box == state["last"]:
                state["same"] += 1
            else:
                state["last"], state["same"] = box, 1
            return {"ok": state["same"] >= need, "box": box, "stable_frames": state["same"]}

        return wait_until(check, timeout, interval)

    def _wait_request(self, pattern: str, timeout: int, interval: int) -> dict:
        method, _, path = pattern.partition(" ")
        method, path = method.strip().upper(), path.strip()

        def seen() -> dict:
            for item in self.driver.requests_seen():
                if method and item.get("method", "").upper() != method:
                    continue
                item_path = str(item.get("path") or "")
                if path and not (item_path.startswith(path) or re.search(path, item_path)):
                    continue
                return {"ok": True, "matched": item}
            return {"ok": False, "pattern": pattern,
                    "seen": [f"{i.get('method')} {i.get('path')}" for i in self.driver.requests_seen()][-5:]}

        return wait_until(seen, timeout, interval)

    # ---- 断言 ------------------------------------------------------------
    def _apply_asserts(self, step: dict, result: StepResult) -> None:
        for position, assertion in enumerate(step.get("assert") or []):
            record = self._evaluate(step, assertion, position)
            result.assertions.append(record)
            if record["decide"] and not record["passed"]:
                result.status = "fail"
                result.failure_kind = "decide_assert_failed"
                result.attribution = "product"

    def _evaluate(self, step: dict, assertion: dict, position: int) -> dict:
        atype = str(assertion.get("type") or "")
        expected = assertion.get("expected", assertion.get("value"))
        expected = _resolve(expected, self.data) if expected is not None else None
        matcher = assertion.get("matcher")
        target = assertion.get("target") or step.get("target") or {}
        error = None
        actual = None
        if atype in ("url_contains", "url_matches"):
            actual = self.driver.url()
            matcher = matcher or ("regex" if atype == "url_matches" else "contains")
        elif atype in ("visible", "hidden", "text_equals", "value_equals",
                       "count_equals", "attribute_equals"):
            if atype == "count_equals":
                # 数数时**不能**走 LocatorResolver：它遇到多命中会拒绝执行，
                # 而"命中 3 个"恰恰是 count_equals 要断言的答案
                actual = self._count_only(target)
                matcher = matcher or "equals"
            else:
                decision = self._resolve(target, retry=False)
                probe = (self.driver.probe(decision["query"]) if decision["status"] == "ok"
                         else {"ok": False, "count": 0})
                if atype == "visible":
                    actual = bool(probe.get("ok") and probe.get("visible"))
                    matcher = matcher or "equals"
                    expected = True if expected is None else expected
                elif atype == "hidden":
                    # 不存在也算 hidden：断言的是"用户看不到"，不是"元素存在且不可见"
                    actual = not (probe.get("ok") and probe.get("visible"))
                    matcher = matcher or "equals"
                    expected = True if expected is None else expected
                elif atype == "text_equals":
                    actual = probe.get("text")
                    matcher = matcher or "equals"
                elif atype == "value_equals":
                    actual = probe.get("value")
                    matcher = matcher or "equals"
                else:
                    name = str(assertion.get("attribute") or "")
                    actual = (self.driver.attribute(decision["query"], name)
                              if decision["status"] == "ok" else None)
                    matcher = matcher or "equals"
        elif atype == "text_visible":
            actual = self.driver.page_text()
            matcher = matcher or "contains"
        else:
            error = f"不支持的断言类型：{atype}"

        level = assertion.get("level") or ("decide" if assertion.get("decide") else None) \
            or assertion_level(step)
        record = {"index": position, "type": atype, "matcher": matcher,
                  "expected": _safe(expected), "actual": _safe(actual),
                  "decide": level == "decide", "level": level,
                  "passed": False, "source": assertion.get("source")}
        if error:
            record["error"] = error
            return record
        verdict = self._assertions.evaluate(actual, {"matcher": matcher, "expected": expected,
                                                    "level": level})
        record["passed"] = bool(verdict.get("passed"))
        if verdict.get("error"):
            record["error"] = verdict["error"]
        return record

    # ---- 定位（带隐式出现等待）------------------------------------------
    def _count_only(self, target) -> int:
        """只数第一个指纹的命中数（count_equals 专用，不经过歧义拒绝）。"""
        locators, _ = target_locators(target)
        if not locators:
            return 0
        counts = self.driver.counts([fingerprint_query(locators[0])])
        return int(counts[0]) if counts else 0

    def close(self) -> None:
        """释放会话（不关浏览器进程，浏览器归 BrowserHost 管）。"""
        closer = getattr(self.driver, "close", None)
        if callable(closer):
            closer()

    def _resolve(self, target, *, retry: bool = True) -> dict:
        locators, _ = target_locators(target)
        if not locators:
            return {"status": "locator_not_found", "detail": "步骤未声明定位指纹",
                    "query": None, "counts": []}
        deadline = time.monotonic() + (self.locator_timeout_ms / 1000.0 if retry else 0)
        while True:
            decision = resolve_target(self.driver.counts, locators)
            if decision["status"] != "locator_not_found":
                return decision
            if time.monotonic() >= deadline:
                return decision
            time.sleep(self.poll_ms / 1000.0)

    # ---- exec IR ---------------------------------------------------------
    def _build_exec(self, plan, step_results, verdict, started, stamp,
                    halt=None, consistency=None, compile_errors=None) -> dict:
        lineage = plan.get("lineage") or {}
        body = {
            "type": "exec",
            "plan": {"id": lineage.get("id"), "version": lineage.get("version")},
            "driver": "web",
            "engine_version": stamp["engine_version"],
            "schema_version": stamp["schema_version"],
            "capability_versions": stamp["capability_versions"],
            "started_at": started,
            "finished_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "verdict": verdict,
            "consistency": consistency or {"status": "not_run", "repeats": 0},
            "halt": halt,
            "steps": [{
                "index": result.index, "action": result.action, "status": result.status,
                "assertions": result.assertions, "waits": result.waits,
                "duration_ms": result.duration_ms,
                "extracted_keys": sorted(result.extracted),
                "failure_kind": result.failure_kind,
                "attribution": result.attribution,
                # 降级必须记录（§12.3 规则 3）：只写在 evidence 里，报告层就看不见
                # "这条用例是靠第 3 个指纹才跑通的"，定位器退化永远只能靠事故发现
                "locator": _decision_evidence(result.locator) if result.locator else None,
            } for result in step_results],
            "evidence_refs": [f"evidence://{lineage.get('id')}/step-{r.index}"
                              for r in step_results if r.evidence],
        }
        if compile_errors:
            body["compile_errors"] = compile_errors
        return body


def _probe(engine: "WebEngine", target) -> dict:
    """对当前页面做一次定位 + 取事实，不做隐式等待（调用方在轮询里反复调）。"""
    decision = engine._resolve(target or {}, retry=False)
    if decision["status"] != "ok":
        counts = decision.get("counts") or []
        return {"ok": False, "count": counts[0] if len(counts) == 1 else 0,
                "reason": decision.get("detail")}
    return engine.driver.probe(decision["query"])


def _probe_field(engine: "WebEngine", target, field: str) -> bool:
    probe = _probe(engine, target)
    return bool(probe.get("ok") and probe.get(field))


def _decision_evidence(decision: dict) -> dict:
    payload = {"status": decision.get("status"), "counts": decision.get("counts"),
               "locator_hit": decision.get("locator_hit"),
               "degraded": decision.get("degraded"),
               "query": describe_query(decision.get("query"))}
    if decision.get("detail"):
        payload["detail"] = decision["detail"]
    return payload


def _safe(value):
    if isinstance(value, (str, int, float, bool, type(None))):
        return value[:400] if isinstance(value, str) else value
    return str(value)[:400]


def run_web_plan(plan: dict, driver, data: dict | None = None, **options) -> dict:
    """便捷入口：`WebEngine(driver, data, **options).run_plan(plan)`。"""
    return WebEngine(driver, data, **options).run_plan(plan)
