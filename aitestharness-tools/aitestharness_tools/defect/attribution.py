"""P7 / M4 失败三分归因：脚本 / 环境 / 产品——程序判，带依据，判不了就说判不了。

为什么要有这一层
----------------
归因今天散在 `web_engine` 的每个失败分支里，写死成一个字符串：
`decide_assert_failed` → `"product"`、`locator_not_found` → `"script"`。
单个分支看都合理，合起来有两个后果：

1. **product 变成了默认值。** 断言一不对就判产品缺陷，而"断言不对"恰恰是
   脚本写错、数据污染、环境漂移、产品真坏了这四种情况共有的表象。一个工具
   如果总说"产品坏了"，团队会开始无视所有失败——这与 §14.2 "flaky 必须根治"
   是同一个道理：**噪声会让人放弃信号**。
2. **结论不可复核。** 一个字符串没有依据、没有置信度、没有"当时为什么这么判"。
   事后争"这到底算不算产品 bug"时，双方手里都只有那一个词。

所以这里做**确定性归因**——正是 `common/model_capability.py` 里
`failure_attribution` 写明的 fallback："按 §14.3 可疑信号规则表做确定性归因，
人工复核"。三条自我约束：

* **product 是要求最高的结论。** 必须有「环境可比 + 定位稳定 + 可复现」三重支撑，
  缺一样就降置信度，而不是照样判 product；
* **每条结论带依据，也带上没命中的规则。** 只列命中项，读的人无法判断是否漏判；
* **判不了就说判不了**（`unknown` + 缺什么），不猜。

它不替代 LLM Advisor：这里产出的结构化证据正是 §14.3 第三步要求的输入。
整个模块是纯函数，不读文件、不调模型、不依赖浏览器。
"""
from __future__ import annotations

from typing import Any, Mapping

__all__ = ["CATEGORIES", "CONFIDENCES", "ENV_STANDINGS", "RULES", "WAIT_SLOW_MS",
           "DURATION_SWING", "collect_signals", "attribute_failure"]

# 与 irval enums 的 defect_category 一致。三分是主结论，另三类是诚实的出口：
# data_issue（数据污染）、flaky（不可复现）、unknown（证据不足）。
CATEGORIES = ("product_bug", "script_issue", "env_issue", "data_issue", "flaky", "unknown")
CONFIDENCES = ("high", "medium", "low", "none")
ENV_STANDINGS = ("clean", "warnings", "unverified", "blocking", "version_unknown")

# §14.3 第二步的两个量化口径。写在这里当常量，是因为"超过多少算慢"必须是工程定的，
# 不能由每次调用方各写一个数——否则同一个失败在不同入口下归因不同。
WAIT_SLOW_MS = 3000
DURATION_SWING = 0.5

# 规则表：**顺序即优先级**，按"多能直接解释这次失败"排，不按严重性排。
# 表只用于审计与文档；判定实现在 `_claim_*` 里，一眼能读完，不藏在数据里。
RULES = (
    ("A1", "未执行就失败（编译期 / 授权期）：与被测系统无关"),
    ("A2", "结论不可复现（重放不一致 / 引擎内 flaky / 历史摇摆）：先修稳定性，不归产品"),
    ("A3", "定位失败或歧义：剧本假设的页面结构已经不成立"),
    ("A4", "动作 / 取值失败：剧本作用不到目标"),
    ("A5", "环境不可达：环境没起来，脚本与产品都还没被检验"),
    ("A6", "驱动异常：执行通道坏了"),
    ("A7", "环境存在 blocking 漂移：跑在变了的环境上，结论不可比"),
    ("A8", "历史留下残留污染了数据：先清残留再判"),
    ("A9", "decide 断言不成立，且环境可比、定位稳定、可复现：产品行为与预期不符"),
    ("A10", "等待超时且环境可比：该出现的东西没在声明的时间内出现"),
    ("A11", "以上都不能解释：证据不足，不猜"),
)

# 定位 / 动作类失败：全部是"剧本对页面的假设与现实不符"。
# 这些不是"随便归给脚本图省事"——它们每一条都已经在引擎里被排除过产品原因
# （多命中已拒绝执行、定位到了才谈动作、取值拿不到才判空）。
_SCRIPT_KINDS = {
    "locator_not_found": "全部定位指纹都没命中：剧本描述的页面结构已经不成立",
    "locator_ambiguous": "定位命中多个元素：剧本写得不够严，多命中已按规则拒绝执行",
    "locator_spec_invalid": "定位声明本身有误，解析期就被拒",
    "missing_url": "goto 步骤没有声明地址",
    "wait_locator_ambiguous": "等待条件命中了多个元素：等待条件写宽了，不是产品没渲染",
    "action_failed": "定位到了但动作没完成（遮挡 / 不可点 / 超时）：剧本作用不到目标",
    "extract_empty": "要取的值是空的：剧本引用了页面上不存在的字段",
    "extract_target_missing": "取值目标定位不到：剧本科目的元素已不在页面上",
}

# 通道类失败：**不是**被测系统的问题，也不该让脚本背锅。
_ENV_KINDS = {
    "env_unreachable": "页面或接口打不开：环境不可用，脚本与产品都还没被检验",
    "driver_error": "驱动异常（浏览器 / 网络 / 协议层）：执行通道坏了",
}

_PRODUCT_ASSERT_KINDS = ("decide_assert_failed",)
_PRODUCT_WAIT_KINDS = ("wait_timeout",)


# ------------------------------------------------------------------ 事实提取

def _plan_id(exec_ir: Mapping[str, Any]) -> str | None:
    return ((exec_ir.get("plan") or {}).get("id")) or None


def _failed_step(exec_ir: Mapping[str, Any]) -> dict:
    """定位"这次失败发生在哪一步"。

    halt.step 优先：它是引擎判定"停在这里"的那一步。没有 halt（比如手动拼的 IR）
    就退回第一个非 pass 步骤——**不退回"最后一步"**，最后一步往往是被中断的
    下一个动作，拿它归因会把原因和现场搞混。
    """
    steps = exec_ir.get("steps") or []
    marker = (exec_ir.get("halt") or {}).get("step")
    if marker is not None:
        for step in steps:
            if step.get("index") == marker:
                return step
    for step in steps:
        if step.get("status") in ("fail", "blocked", "error"):
            return step
    return {}


def _env_standing(preflight: Mapping[str, Any] | None) -> tuple[str, list[str], list[dict]]:
    """把 preflight 结论压成一个"环境站得住吗"的档位 + 依据。

    五档而不是布尔的理由：`baseline_missing`（首次运行）和 `not_comparable`（版本变了）
    对归因的影响完全相反——前者是"没验过"，后者是"验过且不能比"。压成
    "环境 OK / 不 OK"，两种都会被误读。
    """
    if not preflight:
        return ("unverified",
                ["未提供执行前置校验结果：无法判断本次执行的环境是否仍是基线"], [])  # noqa: E501

    status = str(preflight.get("status") or "")
    comparison = preflight.get("comparison") or {}
    summary = comparison.get("summary") or {}
    blocking = int(summary.get("blocking") or 0)
    drift = list(comparison.get("drift") or [])
    blocking_drift = [item for item in drift if item.get("severity") == "blocking"]

    if not preflight.get("prechecked"):
        reasons = preflight.get("reasons") or []
        return ("unverified",
                ["本次执行未带环境校验" + (f"：{'；'.join(reasons)}" if reasons else "")],
                blocking_drift)

    if status == "baseline_corrupt":
        return ("blocking", ["已有基线不可读，环境无可比对象"], blocking_drift)

    if blocking:
        # 全是"被测版本变了"时单列一档：版本变了不等于环境坏了，更不等于产品有缺陷，
        # 只是这次结论不可比。混进 env_issue 会让人去查环境，而真正该做的是按新版重跑。
        if all(item.get("section") == "sut_version" for item in blocking_drift):
            return ("version_unknown",
                    ["被测版本与基线不同：结论不可跨版本比较（G3），先按新版本重跑再判"],
                    blocking_drift)
        return ("blocking",
                [f"存在 {blocking} 项 blocking 漂移：{item.get('detail')}"
                 for item in blocking_drift][:6], blocking_drift)

    if status == "inconclusive" or preflight.get("degraded") == "version_unknown":
        return ("version_unknown",
                ["被测版本缺失 / 未定：无法排除「这是新版本的行为」（G3）"], blocking_drift)

    if status == "comparable_with_warnings":
        reasons = preflight.get("reasons") or []
        return ("warnings",
                [f"环境可比但有 warning 级漂移：{'; '.join(reasons[:3])}"], blocking_drift)

    if status == "comparable":
        return ("clean", [], blocking_drift)

    return ("unverified", [f"前置校验状态 '{status}' 不在已知档位内：按未验证处理"], blocking_drift)


def _reproducibility(exec_ir: Mapping[str, Any], replay: Mapping[str, Any] | None,
                     history: list[Mapping[str, Any]] | None) -> dict:
    """这次失败可复现吗？三路证据，优先级：重放 > 引擎内一致性复跑 > 历史。

    为什么重放排第一：它是唯一"同一份计划、同一套环境、跑 N 轮"的证据。
    引擎内一致性复跑只挑一步重复 2 次，历史则连环境是否同一台机器都不知道。
    """
    if replay:
        rounds = int(replay.get("rounds_done") or 0)
        if replay.get("deterministic") is False:
            divergence = replay.get("divergence") or {}
            return {"status": "flaky", "source": "replay", "rounds": rounds,
                    "detail": f"重放 {rounds} 轮结论不一致：{divergence.get('because') or '见 divergence'}"}
        if replay.get("deterministic") is True and rounds >= 2:
            return {"status": "reproduced", "source": "replay", "rounds": rounds,
                    "detail": f"重放 {rounds} 轮结论一致"}

    consistency = exec_ir.get("consistency") or {}
    if consistency.get("status") == "flaky":
        return {"status": "flaky", "source": "consistency",
                "rounds": consistency.get("repeats"),
                "detail": f"引擎内一致性复跑结论不一致：{consistency.get('outcomes')}"}
    if consistency.get("status") == "verified":
        return {"status": "reproduced", "source": "consistency",
                "rounds": consistency.get("repeats"),
                "detail": "引擎内一致性复跑结论一致"}

    plan_id = _plan_id(exec_ir)
    seen = [item for item in (history or [])
            if _plan_id(item) == plan_id and item.get("verdict")]
    verdicts = [item.get("verdict") for item in seen]
    if len(verdicts) >= 2:
        if len(set(verdicts)) > 1:
            return {"status": "flaky", "source": "history", "rounds": len(verdicts),
                    "detail": f"同计划历史结论摇摆：{verdicts[-5:]}"}
        return {"status": "reproduced", "source": "history", "rounds": len(verdicts),
                "detail": f"同计划历史 {len(verdicts)} 次结论一致：{verdicts[-5:]}"}

    return {"status": "single_run", "source": "none", "rounds": 1,
            "detail": "只有本次一次结果，且未提供重放 / 历史：**没证明过可复现**"}


def _has_prior_residue(history: list[Mapping[str, Any]] | None,
                       plan_id: str | None) -> dict | None:
    """历史里有没有"上一次留下了没清干净的东西"。

    为什么看历史而不是看本次：本次 teardown 失败留下的残留影响的是**下一次**。
    用本次残留解释本次失败，因果正好反了——那是"这次跑坏了还留了垃圾"，
    不是"因为脏所以跑坏"。
    """
    for item in history or []:
        if _plan_id(item) != plan_id:
            continue
        attention = item.get("needs_attention") or {}
        if attention.get("kind") == "residue" or attention.get("residue"):
            return {"because": attention.get("because") or "历史执行留下残留",
                    "residue": attention.get("residue") or []}
        teardown = item.get("teardown") or {}
        if teardown.get("status") == "failed" and teardown.get("residue"):
            return {"because": teardown.get("reason") or "历史执行清理失败",
                    "residue": teardown.get("residue")}
    return None


# ------------------------------------------------------------------ 可疑信号（§14.3 第二步）

def collect_signals(exec_ir: Mapping[str, Any], *, history=None,
                    wait_threshold_ms: int = WAIT_SLOW_MS,
                    duration_swing: float = DURATION_SWING) -> dict:
    """零额外成本的可疑信号：命中降级定位、位置耦合、等待超阈值、耗时波动。

    这些信号**不改结论**，只回答"这条用例正在变脆吗"。所以它们在 pass 的 run 上
    也有意义——一条靠第 3 个指纹、等了 4 秒才通过的用例，下个版本大概率会挂。

    `not_available` 是刻意留的：控制台 / 网络异常这两个信号 §14.3 要求，但 exec IR
    目前不带控制台与网络事件，这里如实说"取不到"，而不是返回空列表让人以为"没有异常"。
    """
    signals: dict[str, Any] = {
        "degraded_locators": [], "positional_locators": [], "slow_waits": [],
        "duration_swings": [], "not_available": [],
    }

    for step in exec_ir.get("steps") or []:
        locator = step.get("locator") or {}
        if locator.get("degraded"):
            signals["degraded_locators"].append({
                "step": step.get("index"), "action": step.get("action"),
                "locator_hit": locator.get("locator_hit"),
                "query": locator.get("query"),
                "because": "首选指纹没命中，靠后位指纹跑通：定位器已退化，改版即断",
            })
        if locator.get("positional"):
            signals["positional_locators"].append({
                "step": step.get("index"), "action": step.get("action"),
                "query": locator.get("query"),
                "because": "按位置（第 N 列 / 第 N 个）定位：列序一变就点错地方",
            })
        for wait in step.get("waits") or []:
            elapsed = wait.get("elapsed_ms")
            if isinstance(elapsed, (int, float)) and elapsed > wait_threshold_ms:
                signals["slow_waits"].append({
                    "step": step.get("index"), "type": wait.get("type"),
                    "elapsed_ms": int(elapsed), "ok": bool(wait.get("ok")),
                    "because": f"等待 {int(elapsed)}ms 超过阈值 {wait_threshold_ms}ms",
                })

    swings, unavailable = _duration_swings(exec_ir, history, duration_swing)
    signals["duration_swings"] = swings
    if unavailable:
        signals["not_available"].append(unavailable)

    signals["not_available"].extend([
        "控制台 / 网络异常：exec IR 未携带控制台与网络事件，本信号取不到",
        "重试：引擎不重试（设计如此），N 轮重放是重放而不是重试，本信号不适用",
    ])
    signals["counts"] = {
        "degraded_locators": len(signals["degraded_locators"]),
        "positional_locators": len(signals["positional_locators"]),
        "slow_waits": len(signals["slow_waits"]),
        "duration_swings": len(signals["duration_swings"]),
    }
    signals["clean"] = not any(signals["counts"].values())
    return signals


def _duration_swings(exec_ir: Mapping[str, Any], history, threshold: float) -> tuple[list, str | None]:
    """与同计划**通过的**历史比每一步耗时。没有历史就明说，不猜"正常"。"""
    plan_id = _plan_id(exec_ir)
    passed = [item for item in (history or [])
              if _plan_id(item) == plan_id and item.get("verdict") == "pass"]
    if not history:
        return [], "耗时波动：没有提供历史执行，无法判断本次耗时是否异常"
    if not passed:
        return [], "耗时波动：同计划没有历史通过记录，无法判断本次耗时是否异常"

    baseline: dict[str, list[float]] = {}
    for item in passed:
        for step in item.get("steps") or []:
            duration = step.get("duration_ms")
            if isinstance(duration, (int, float)):
                baseline.setdefault(str(step.get("index")), []).append(float(duration))

    swings = []
    for step in exec_ir.get("steps") or []:
        durations = baseline.get(str(step.get("index"))) or []
        duration = step.get("duration_ms")
        if not durations or not isinstance(duration, (int, float)):
            continue
        ordered = sorted(durations)
        median = ordered[len(ordered) // 2]
        if median <= 0:
            continue
        ratio = float(duration) / median
        if abs(ratio - 1.0) > threshold:
            swings.append({"step": step.get("index"), "current_ms": duration,
                           "median_ms": median, "ratio": round(ratio, 2),
                           "because": f"耗时是历史中位数的 {round(ratio, 2)} 倍"})
    return swings, None


# ------------------------------------------------------------------ 判定

def attribute_failure(exec_ir: Mapping[str, Any], *,
                      preflight: Mapping[str, Any] | None = None,
                      replay: Mapping[str, Any] | None = None,
                      history: list[Mapping[str, Any]] | None = None,
                      signals: Mapping[str, Any] | None = None) -> dict:
    """判一次失败（或一次可疑通过）该归给谁。

    入参都是**已有事实**，本函数不采集、不推断未观测到的东西：
        exec_ir   执行 IR（`WebEngine.run_plan` / `ApiEngine.run_plan` 的返回）
        preflight `exec.preflight()` 的返回：环境是否仍是基线
        replay    `exec.replay()` 的报告：N 轮结论是否一致
        history   同一计划的历史执行 IR 列表：判断是否摇摆、是否有残留
        signals   已算好的可疑信号（不传则内部算）

    返回见模块 `__all__`；核心是 `category` + `confidence` + `rule` + `evidence`，
    另带 `considered`（全部规则逐条命中情况）与 `human_review`（是否该转人工）。
    """
    exec_ir = exec_ir or {}
    signals = signals if signals is not None else collect_signals(exec_ir, history=history)
    step = _failed_step(exec_ir)
    halt = exec_ir.get("halt") or {}
    standing, env_notes, blocking_drift = _env_standing(preflight)
    repro = _reproducibility(exec_ir, replay, history)

    context = {
        "exec_ir": exec_ir, "step": step, "halt": halt,
        "standing": standing, "repro": repro, "signals": signals,
        "blocking_drift": blocking_drift,
        "residue": _has_prior_residue(history, _plan_id(exec_ir)),
    }

    base = {
        "signals": signals,
        "environment": {
            "standing": standing,
            "preflight_status": (preflight or {}).get("status"),
            "prechecked": bool((preflight or {}).get("prechecked")),
            "blocking_drift": blocking_drift,
            "notes": env_notes,
        },
        "reproducibility": repro,
    }

    if exec_ir.get("verdict") == "pass":
        # 通过也要看信号：一条靠降级定位、等了 4 秒才通过的用例，是"下次一定会挂"。
        return {
            "applicable": False, "category": None, "confidence": "none", "rule": None,
            "because": "结论为 pass，没有失败可归因；可疑信号照常给出，供资产维护参考",
            "human_review": False, "candidate": None, "evidence": [],
            "considered": [], "notes": ["错误通过风险：见 signals，本函数不改变结论"], **base,
        }

    decision = _decide(context)
    guards: list[str] = []

    if decision["category"] == "product_bug":
        # 护栏一：环境不可比时，product 不成立。跑在变了的环境上得出的"断言不符"，
        # 可能是版本变了、mock 换了、关键表改了——先修环境再判产品。
        if standing in ("blocking", "version_unknown"):
            guards.append(
                f"环境档位为 {standing}：不能把断言不符判成产品缺陷（先修环境 / 补版本再判）")
            decision = {**decision, "category": "unknown",
                        "confidence": "none", "because": decision["because"],
                        "rule": decision["rule"] + "+guard"}
        elif standing == "unverified":
            guards.append("环境未经前置校验：没有基线事实支撑「产品缺陷」，置信度压到 low")
            decision = {**decision, "confidence": "low"}
        elif standing == "warnings" and decision["confidence"] == "high":
            guards.append("环境有 warning 级漂移（文件 / 凭据）：置信度从 high 压到 medium")
            decision = {**decision, "confidence": "medium"}

        # 护栏二：只跑过一次的失败，无论环境多干净都只是"一次观测"。
        if decision["category"] != "unknown" and repro["status"] == "single_run":
            if decision["confidence"] == "high":
                decision = {**decision, "confidence": "medium"}
            guards.append("只跑过一次：未复现的失败最高只能给 medium")

    category = decision["category"]
    confidence = decision["confidence"] if category != "unknown" else "none"
    notes = list(env_notes) + guards
    if category == "unknown":
        notes.append("证据不足，不猜：需要补的是 " + "、".join(decision.get("missing") or ["更多事实"]))

    return {
        "applicable": True,
        "category": category,
        "confidence": confidence,
        "rule": decision["rule"],
        "because": decision["because"],
        # 契约要求"低置信转人工"（agent/tasks.py failure_attribution）。
        # unknown 一律转人工：它本来就是"程序判不了"；flaky 也转人工——
        # §14.4 的 flaky 出口是"人工 triage 后修资产 / 转偶发缺陷 / 进隔离区"，
        # 这一步程序替不了。
        "human_review": category in ("unknown", "flaky") or confidence == "low",
        "candidate": decision.get("candidate"),
        "missing": decision.get("missing") or [],
        "evidence": decision.get("evidence") or [],
        "considered": decision["considered"],
        "notes": notes,
        **base,
    }


def _decide(context: Mapping[str, Any], *, skip: tuple[str, ...] = ()) -> dict:
    """按规则表逐条试，先命中先收口；`skip` 用于"去掉某条规则再判一遍"。

    `skip` 的唯一用途是 flaky：判成 flaky 之后还要回答"如果它稳定下来，会归给谁"。
    不给这个候选，flaky 就成了一句没用的话——人还是不知道下一步去查什么。
    """
    considered: list[dict] = []
    claim: dict | None = None

    for rule_id, description in RULES:
        if claim is not None:
            considered.append({"id": rule_id, "matched": False, "bypassed": True,
                               "because": f"已由 {claim['rule']} 收口"})
            continue
        if rule_id in skip:
            considered.append({"id": rule_id, "matched": False, "skipped": True,
                               "because": "本次判定跳过该规则"})
            continue
        outcome = _EVALUATORS[rule_id](context)
        if outcome is None:
            considered.append({"id": rule_id, "matched": False, "because": description})
            continue
        claim = {"rule": rule_id, "considered": [], **outcome}
        considered.append({"id": rule_id, "matched": True, "because": outcome["because"]})
        claim["considered"] = considered

    if claim is None:  # 规则表最后一条是兜底，正常不会到这里
        claim = {"rule": "A11", "considered": considered, "category": "unknown",
                 "confidence": "none", "because": "没有规则能解释这次失败",
                 "missing": ["可解释的失败事实"]}
    claim["considered"] = considered

    if claim["category"] == "flaky":
        candidate = _decide(context, skip=tuple(skip) + ("A2",))
        if candidate["category"] != "flaky":
            claim["candidate"] = {"category": candidate["category"],
                                  "confidence": candidate["confidence"],
                                  "rule": candidate["rule"],
                                  "because": candidate["because"]}
    return claim


# ---- 逐条规则。返回 None = 不命中；返回 dict = 命中并收口。
# 每条都必须能说清"为什么这个事实能唯一解释这次失败"，否则它不该排在前面。

def _claim_a1_not_executed(context):
    stage = (context["halt"] or {}).get("stage")
    if stage == "compile":
        return {"category": "script_issue", "confidence": "high",
                "because": "计划未通过编译期校验，浏览器根本没启动：问题在剧本本身",
                "evidence": [{"kind": "halt.stage", "detail": "compile"},
                             {"kind": "halt.because", "detail": context["halt"].get("because")}]}
    if stage == "authorization":
        return {"category": "script_issue", "confidence": "high",
                "because": "未获写操作授权，执行被闸拦下：属流程 / 授权问题，不是被测系统的行为",
                "evidence": [{"kind": "halt.because", "detail": context["halt"].get("because")}]}
    return None


def _claim_a2_flaky(context):
    repro = context["repro"]
    if repro["status"] != "flaky":
        return None
    return {"category": "flaky", "confidence": "high",
            "because": f"结论不可复现（{repro['source']}）：{repro['detail']}。"
                       f"先修稳定性，再谈归因——偶发失败不判产品缺陷",
            "evidence": [{"kind": "reproducibility", "detail": repro}]}


def _claim_a3_locator(context):
    kind = (context["step"] or {}).get("failure_kind")
    if kind in ("locator_not_found", "locator_ambiguous", "locator_spec_invalid",
                "missing_url", "wait_locator_ambiguous"):
        locator = (context["step"] or {}).get("locator") or {}
        return {"category": "script_issue", "confidence": "high",
                "because": _SCRIPT_KINDS[kind],
                "evidence": [{"kind": "failure_kind", "detail": kind},
                             {"kind": "locator", "detail": locator}]}
    return None


def _claim_a4_action(context):
    kind = (context["step"] or {}).get("failure_kind")
    if kind in ("action_failed", "extract_empty", "extract_target_missing"):
        return {"category": "script_issue", "confidence": "high",
                "because": _SCRIPT_KINDS[kind],
                "evidence": [{"kind": "failure_kind", "detail": kind},
                             {"kind": "step", "detail": (context["step"] or {}).get("action")}]}
    return None


def _claim_a5_unreachable(context):
    kind = (context["step"] or {}).get("failure_kind")
    if kind == "env_unreachable":
        return {"category": "env_issue", "confidence": "high",
                "because": _ENV_KINDS[kind],
                "evidence": [{"kind": "failure_kind", "detail": kind}]}
    return None


def _claim_a6_driver(context):
    kind = (context["step"] or {}).get("failure_kind")
    if kind == "driver_error":
        return {"category": "env_issue", "confidence": "high",
                "because": _ENV_KINDS[kind],
                "evidence": [{"kind": "failure_kind", "detail": kind}]}
    return None


def _claim_a7_env_drift(context):
    drift = [item for item in context["blocking_drift"]
             if item.get("section") != "sut_version"]
    if not drift:
        return None
    return {"category": "env_issue", "confidence": "high",
            "because": "执行时环境存在 blocking 漂移（关键表 / mock / 基线文件）："
                       "跑在变了的环境上，任何「产品缺陷」结论都不成立",
            "evidence": [{"kind": "baseline.drift", "detail": item} for item in drift[:6]]}


def _claim_a8_residue(context):
    residue = context["residue"]
    kind = (context["step"] or {}).get("failure_kind")
    if not residue or kind not in _PRODUCT_ASSERT_KINDS:
        return None
    assertions = [item for item in (context["step"] or {}).get("assertions") or []
                  if item.get("decide") and not item.get("passed")]
    # 只认数量类断言：残留最直接的表象就是"多了一条 / 少了一条"。文案类断言的
    # 不符原因太多（文案改版、状态没刷新也都是），拿它当数据污染的入口会把
    # 真实产品缺陷漏掉——宁可把 data_issue 判窄，也不要它变成第二个"兜底类别"。
    data_flavoured = [item for item in assertions if item.get("type") == "count_equals"]
    if not data_flavoured:
        return None
    return {"category": "data_issue", "confidence": "medium",
            "because": f"历史执行留下过残留（{residue['because']}），而本次失败是"
                       f"数量 / 文案类断言：先按残留清理并重跑，再判是否为产品缺陷",
            "evidence": [{"kind": "history.residue", "detail": residue},
                         {"kind": "assertion", "detail": data_flavoured}]}


def _product_confidence(standing: str, repro_status: str) -> str:
    """product 的置信度矩阵：**环境档位定上限，复现与否定档内高低**。"""
    if standing == "clean":
        return "high" if repro_status == "reproduced" else "medium"
    if standing == "warnings":
        return "medium" if repro_status == "reproduced" else "low"
    return "low"


def _claim_a9_assert(context):
    kind = (context["step"] or {}).get("failure_kind")
    if kind not in _PRODUCT_ASSERT_KINDS:
        return None
    assertions = [item for item in (context["step"] or {}).get("assertions") or []
                  if item.get("decide") and not item.get("passed")]
    standing = context["standing"]
    confidence = _product_confidence(standing, context["repro"]["status"])
    locator = (context["step"] or {}).get("locator") or {}
    stable = locator.get("status") in (None, "ok") and not locator.get("degraded")
    because = ("断言不成立，且环境档位为 "
               f"{standing}、定位{'稳定' if stable else '不稳定'}、"
               f"复现状态 {context['repro']['status']}：产品行为与预期不符")
    if not stable:
        # 靠降级指纹才定位到、或根本没记录定位：断言比的可能不是那个元素。
        because += "；但定位不稳定，这条结论要先确认断言比的是同一个元素"
        confidence = "low"
    return {"category": "product_bug", "confidence": confidence, "because": because,
            "evidence": [{"kind": "assertion", "detail": assertions},
                         {"kind": "locator", "detail": locator}],
            "missing": [] if confidence != "low" else ["未排除定位漂移"]}


def _claim_a10_wait(context):
    kind = (context["step"] or {}).get("failure_kind")
    if kind not in _PRODUCT_WAIT_KINDS:
        return None
    waits = [item for item in (context["step"] or {}).get("waits") or []
             if not item.get("ok")]
    standing = context["standing"]
    confidence = _product_confidence(standing, context["repro"]["status"])
    # 等待超时天然比断言弱：元素没出现，可能是产品没渲染，也可能是阈值比基线耗时还短。
    if confidence == "high":
        confidence = "medium"
    return {"category": "product_bug", "confidence": confidence,
            "because": f"等待超时且环境档位为 {standing}：该出现的东西没在声明时间内出现。"
                       f"注意：等待阈值若低于该元素历史耗时，先怀疑阈值本身",
            "evidence": [{"kind": "wait", "detail": waits},
                         {"kind": "signals.slow_waits", "detail": context["signals"]["slow_waits"]}]}


def _claim_a11_unknown(context):
    step = context["step"] or {}
    missing = []
    if not step:
        missing.append("失败步骤（halt.step 缺失，且没有非 pass 步骤）")
    if not step.get("failure_kind"):
        missing.append("failure_kind（引擎未标出失败类型）")
    if context["standing"] == "unverified":
        missing.append("执行前置校验结果（preflight）")
    if context["repro"]["status"] == "single_run":
        missing.append("重放或历史结论（用于判断是否可复现）")
    if not missing:
        missing.append("能唯一解释这次失败的事实")
    return {"category": "unknown", "confidence": "none",
            "because": f"现有事实不能唯一解释这次失败（failure_kind="
                       f"{step.get('failure_kind')!r}，环境 {context['standing']}，"
                       f"复现 {context['repro']['status']}）",
            "missing": missing,
            "evidence": [{"kind": "step", "detail": step}]}


_EVALUATORS = {
    "A1": _claim_a1_not_executed,
    "A2": _claim_a2_flaky,
    "A3": _claim_a3_locator,
    "A4": _claim_a4_action,
    "A5": _claim_a5_unreachable,
    "A6": _claim_a6_driver,
    "A7": _claim_a7_env_drift,
    "A8": _claim_a8_residue,
    "A9": _claim_a9_assert,
    "A10": _claim_a10_wait,
    "A11": _claim_a11_unknown,
}
