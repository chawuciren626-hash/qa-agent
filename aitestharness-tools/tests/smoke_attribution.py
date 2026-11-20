"""P7 / M4 三分归因验收。

这一层要守的不是"能给出一个类别"，而是**结论配得上它的证据**：

1. **product 不是默认值**——断言不符 + mock 变了必须判环境，断言不符 + 版本变了
   必须判"判不了"，两者都不能判产品。这是本文件最重要的两条阴性对照；
2. **该高的高、该低的不冒充高**——环境干净且 5 轮重放一致才给 high；
   只跑过一次最多 medium；没做前置校验一律 low 且转人工；
3. **不可复现的失败不判产品**——先判 flaky，但必须同时给出"稳定下来会归谁"的候选，
   否则 flaky 就是一句没用的话；
4. **判不了要说缺什么**——`unknown` 必须带 `missing`，不许拿 unknown 当垃圾桶；
5. **规则表可审计**——输出里能逐条看到"用过哪条、为什么没用其它条"。

所有用例都是纯数据，不起浏览器、不调模型。
"""
import copy
import glob
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from aitestharness_tools.defect.attribution import (CATEGORIES, CONFIDENCES, RULES,
                                                    attribute_failure, collect_signals)

PLAN = "PLAN-BBIAO-CRUD"


# ------------------------------------------------------------------ 夹具

def ir(verdict="fail", *, steps=None, halt=None, consistency=None,
       teardown=None, needs_attention=None, plan_id=PLAN):
    body = {
        "type": "exec", "plan": {"id": plan_id, "version": 1}, "driver": "web",
        "verdict": verdict, "halt": halt,
        "steps": steps if steps is not None else [],
        "consistency": consistency or {"status": "not_verified", "repeats": 0},
        "teardown": teardown or {"status": "not_run", "steps": [], "verify": [], "residue": []},
        "started_at": "2026-11-20T00:00:00Z", "finished_at": "2026-11-20T00:00:01Z",
    }
    if needs_attention:
        body["needs_attention"] = needs_attention
    return body


def step(index=0, status="fail", failure_kind=None, *, assertions=None, waits=None,
         locator=None, duration_ms=120, action="click"):
    return {"index": index, "action": action, "status": status,
            "assertions": assertions or [], "waits": waits or [],
            "duration_ms": duration_ms, "failure_kind": failure_kind,
            "locator": locator, "extracted_keys": []}


def failed_assert(index=0, atype="text_equals"):
    return step(index, "fail", "decide_assert_failed",
                assertions=[{"type": atype, "decide": True, "passed": False,
                             "expected": "订单已创建", "actual": "请稍候"}],
                locator={"status": "ok", "degraded": False, "positional": False,
                         "locator_hit": 1, "counts": [1], "query": "role=button[name=提交]"})


def preflight(status="comparable", *, blocking=(), warning=(), prechecked=True,
              degraded=None, reasons=None):
    drift = [{"section": section, "key": None, "kind": "changed", "severity": "blocking",
              "detail": f"{section} 与基线不同"} for section in blocking]
    drift += [{"section": section, "key": None, "kind": "changed", "severity": "warning",
               "detail": f"{section} 与基线不同"} for section in warning]
    return {
        "allow": status != "not_comparable", "status": status, "prechecked": prechecked,
        "degraded": degraded, "reasons": list(reasons or []),
        "comparison": {"summary": {"blocking": len(blocking), "warning": len(warning),
                                   "info": 0},
                       "drift": drift} if prechecked else None,
    }


def replay_report(deterministic=True, rounds=5):
    return {"deterministic": deterministic, "rounds_done": rounds,
            "divergence": None if deterministic else {
                "because": "第 2 轮第 0 步从 pass 变 fail", "step": 0}}


# ------------------------------------------------------------------ 未执行类

def test_compile_failure_is_script_not_product():
    result = attribute_failure(ir(verdict="inconclusive", steps=[],
                                  halt={"stage": "compile", "step": None,
                                        "attribution": "script",
                                        "because": "plan.steps 为空：没有可执行的步骤"}),
                               preflight=preflight())
    assert result["category"] == "script_issue", result
    assert result["rule"] == "A1", result
    assert result["confidence"] == "high", result


def test_authorization_denied_is_script_and_says_so():
    result = attribute_failure(ir(verdict="inconclusive", steps=[],
                                  halt={"stage": "authorization", "step": None,
                                        "attribution": "script",
                                        "because": "写操作计划未获授权"}),
                               preflight=preflight())
    assert result["category"] == "script_issue", result
    assert "授权" in result["because"], result["because"]


# ------------------------------------------------------------------ 脚本类

def test_locator_not_found_is_script():
    result = attribute_failure(
        ir(steps=[step(0, "blocked", "locator_not_found",
                       locator={"status": "locator_not_found", "counts": [0, 0]})]),
        preflight=preflight())
    assert result["category"] == "script_issue", result
    assert result["rule"] == "A3"


def test_locator_ambiguous_is_script_not_product():
    """多命中已在引擎里被拒绝执行：这是选择器写宽了，不是产品缺陷。"""
    result = attribute_failure(
        ir(steps=[step(0, "blocked", "locator_ambiguous",
                       locator={"status": "locator_ambiguous", "counts": [3]})]),
        preflight=preflight())
    assert result["category"] == "script_issue", result


def test_action_failed_is_script():
    result = attribute_failure(
        ir(steps=[step(0, "blocked", "action_failed",
                       locator={"status": "ok", "degraded": False})]),
        preflight=preflight())
    assert result["category"] == "script_issue", result
    assert result["rule"] == "A4"


# ------------------------------------------------------------------ 环境类

def test_driver_error_is_env():
    result = attribute_failure(ir(steps=[step(0, "error", "driver_error")]),
                               preflight=preflight())
    assert result["category"] == "env_issue", result


def test_env_unreachable_is_env():
    result = attribute_failure(ir(steps=[step(0, "error", "env_unreachable", action="goto")]),
                               preflight=preflight())
    assert result["category"] == "env_issue", result
    assert result["rule"] == "A5"


def test_mock_drift_blocks_product():
    """阴性对照 ①：断言不符 + mock 变了 → 必须判环境，不许判产品。

    这是整层存在的理由。旧写法里 `decide_assert_failed` 无条件写 "product"，
    在这份输入下会产出一个假缺陷。
    """
    result = attribute_failure(failed_assert_ir(),
                               preflight=preflight(status="not_comparable",
                                                   blocking=("mock", "db")))
    assert result["category"] == "env_issue", result
    assert result["rule"] == "A7", result
    assert any("blocking" in item for item in result["notes"]), result["notes"]


def test_version_drift_is_unknown_not_product_not_env():
    """阴性对照 ②：只有被测版本变了 → 判不了，不判产品也不判环境。

    版本变了不等于环境坏了，更不等于产品有缺陷——只是"这次结论不可比"。
    """
    result = attribute_failure(failed_assert_ir(),
                               preflight=preflight(status="not_comparable",
                                                   blocking=("sut_version",)))
    assert result["category"] == "unknown", result
    assert result["rule"] == "A9+guard", result
    assert result["human_review"] is True
    assert result["environment"]["standing"] == "version_unknown", result["environment"]
    assert any("版本" in item for item in result["notes"]), result["notes"]


# ------------------------------------------------------------------ 产品类

def failed_assert_ir(**kwargs):
    return ir(steps=[failed_assert()],
              halt={"stage": "step", "step": 0, "attribution": "product",
                    "because": "第 0 步的 decide 断言不成立"}, **kwargs)


def test_assert_on_clean_reproduced_env_is_product_high():
    result = attribute_failure(failed_assert_ir(), preflight=preflight(),
                               replay=replay_report(deterministic=True, rounds=5))
    assert result["category"] == "product_bug", result
    assert result["confidence"] == "high", result
    assert result["human_review"] is False, result


def test_single_run_cannot_be_high():
    """只跑过一次就判 product 已经是结论，但置信度不许冒充 high。"""
    result = attribute_failure(failed_assert_ir(), preflight=preflight())
    assert result["category"] == "product_bug", result
    assert result["confidence"] == "medium", result
    assert any("只跑过一次" in item for item in result["notes"]), result["notes"]


def test_no_preflight_caps_at_low_and_asks_human():
    result = attribute_failure(failed_assert_ir())
    assert result["category"] == "product_bug", result
    assert result["confidence"] == "low", result
    assert result["human_review"] is True
    assert result["environment"]["standing"] == "unverified"


def test_warning_drift_caps_confidence():
    result = attribute_failure(failed_assert_ir(),
                               preflight=preflight(status="comparable_with_warnings",
                                                   warning=("files",)),
                               replay=replay_report())
    assert result["category"] == "product_bug", result
    assert result["confidence"] == "medium", result


def test_unstable_locator_downgrades_product():
    """断言比的可能不是那个元素：靠降级指纹定位到的元素，不能直接判产品。"""
    unstable = failed_assert()
    unstable["locator"] = {"status": "ok", "degraded": True, "locator_hit": 3,
                           "positional": False, "counts": [0, 0, 1]}
    result = attribute_failure(
        ir(steps=[unstable], halt={"stage": "step", "step": 0, "attribution": "product"}),
        preflight=preflight(), replay=replay_report())
    assert result["category"] == "product_bug", result
    assert result["confidence"] == "low", result
    assert "定位" in result["because"]


# ------------------------------------------------------------------ 不可复现

def test_flaky_wins_but_keeps_candidate():
    result = attribute_failure(failed_assert_ir(), preflight=preflight(),
                               replay=replay_report(deterministic=False, rounds=5))
    assert result["category"] == "flaky", result
    assert result["human_review"] is True, "flaky 必须转人工 triage（§14.4）"
    assert result["candidate"]["category"] == "product_bug", result["candidate"]


def test_engine_consistency_flaky_counts():
    result = attribute_failure(
        ir(steps=[failed_assert()],
           halt={"stage": "step", "step": 0},
           consistency={"status": "flaky", "repeats": 2,
                        "outcomes": {"pass": 1, "fail": 1}}),
        preflight=preflight())
    assert result["category"] == "flaky", result
    assert result["rule"] == "A2"


def test_history_swing_is_flaky():
    history = [ir(verdict="pass", plan_id=PLAN), ir(verdict="fail", plan_id=PLAN)]
    result = attribute_failure(failed_assert_ir(), preflight=preflight(), history=history)
    assert result["category"] == "flaky", result
    assert result["reproducibility"]["source"] == "history"


# ------------------------------------------------------------------ 等待类

def test_wait_timeout_is_at_most_medium():
    slow = step(0, "fail", "wait_timeout",
                waits=[{"type": "element_visible", "ok": False, "elapsed_ms": 10000,
                        "attempts": 100}],
                locator={"status": "ok", "degraded": False})
    result = attribute_failure(
        ir(steps=[slow], halt={"stage": "step", "step": 0}), preflight=preflight(),
        replay=replay_report())
    assert result["category"] == "product_bug", result
    assert result["confidence"] == "medium", result
    assert "阈值" in result["because"], result["because"]


def test_wait_timeout_on_drifted_env_is_env():
    slow = step(0, "fail", "wait_timeout",
                waits=[{"type": "network_idle", "ok": False, "elapsed_ms": 10000}])
    result = attribute_failure(ir(steps=[slow], halt={"stage": "step", "step": 0}),
                               preflight=preflight(status="not_comparable",
                                                   blocking=("db",)))
    assert result["category"] == "env_issue", result


# ------------------------------------------------------------------ 数据污染

def test_prior_residue_with_count_assert_is_data_issue():
    history = [ir(verdict="pass", plan_id=PLAN,
                  needs_attention={"kind": "residue", "residue": ["user qa_probe"],
                                   "because": "清理步骤失败"})]
    result = attribute_failure(
        ir(steps=[failed_assert(atype="count_equals")],
           halt={"stage": "step", "step": 0}),
        preflight=preflight(), history=history)
    assert result["category"] == "data_issue", result
    assert result["confidence"] == "medium", result


def test_prior_residue_does_not_mask_visible_assert():
    """阴性对照 ③：残留不能成为一切失败的兜底理由。只有数量类断言才走数据污染。"""
    history = [ir(verdict="pass", plan_id=PLAN,
                  needs_attention={"kind": "residue", "residue": ["user qa_probe"]})]
    result = attribute_failure(
        ir(steps=[failed_assert(atype="visible")],
           halt={"stage": "step", "step": 0}),
        preflight=preflight(), history=history, replay=replay_report())
    assert result["category"] == "product_bug", result


# ------------------------------------------------------------------ 判不了

def test_unknown_lists_what_is_missing():
    result = attribute_failure(ir(verdict="inconclusive",
                                  steps=[step(0, "blocked", None)]))
    assert result["category"] == "unknown", result
    assert result["confidence"] == "none", result
    assert result["human_review"] is True
    assert len(result["missing"]) >= 2, result["missing"]
    assert any("证据不足" in item for item in result["notes"])


def test_pass_is_not_applicable_but_signals_still_reported():
    passing = step(0, "pass", None,
                   locator={"status": "ok", "degraded": True, "locator_hit": 2,
                            "positional": False, "counts": [0, 1]})
    result = attribute_failure(ir(verdict="pass", steps=[passing]),
                               preflight=preflight())
    assert result["applicable"] is False, result
    assert result["category"] is None
    assert result["signals"]["counts"]["degraded_locators"] == 1, result["signals"]


# ------------------------------------------------------------------ 可疑信号

def test_signals_capture_degraded_positional_and_slow_wait():
    noisy = step(0, "pass", None,
                 waits=[{"type": "element_visible", "ok": True, "elapsed_ms": 4200}],
                 locator={"status": "ok", "degraded": True, "locator_hit": 2,
                          "positional": True, "counts": [0, 1]})
    signals = collect_signals(ir(verdict="pass", steps=[noisy]))
    assert signals["counts"]["degraded_locators"] == 1
    assert signals["counts"]["positional_locators"] == 1
    assert signals["counts"]["slow_waits"] == 1
    assert signals["slow_waits"][0]["elapsed_ms"] == 4200
    assert signals["clean"] is False
    # 取不到的信号必须如实说取不到
    assert any("控制台" in item for item in signals["not_available"])


def test_signals_duration_swing_against_passing_history():
    current = ir(steps=[step(0, "fail", "decide_assert_failed", duration_ms=600)],
                 halt={"stage": "step", "step": 0})
    history = [ir(verdict="pass", steps=[step(0, "pass", None, duration_ms=100)]),
               ir(verdict="pass", steps=[step(0, "pass", None, duration_ms=100)])]
    signals = collect_signals(current, history=history)
    assert signals["counts"]["duration_swings"] == 1, signals
    assert signals["duration_swings"][0]["ratio"] == 6.0


def test_signals_without_history_says_so():
    signals = collect_signals(ir(steps=[step(0, "pass", None)]))
    assert any("耗时波动" in item for item in signals["not_available"]), signals


# ------------------------------------------------------------------ 与真实引擎对齐

def _real_exec(plan, elements):
    """跑一遍真引擎（内存驱动），拿到引擎**真的**会产出的 exec IR。

    为什么必须有这一组：前面的夹具是我按 IR 规格手写的，如果规格与实现漂了
    （比如 locator.status 的名字换了），夹具全绿而线上全错。用真 IR 跑一次，
    至少保证"归因读的字段确实存在"。
    """
    from smoke_web_engine import FakeDriver
    from aitestharness_tools.exec.web_engine import WebEngine
    return WebEngine(FakeDriver(elements), {}, locator_timeout_ms=0,
                     poll_ms=5).run_plan(plan)


def test_real_engine_locator_failure_reads_as_script():
    from smoke_web_engine import element

    plan = {"driver": "web", "lineage": {"id": "PLAN-ATTR-L", "version": 1},
            "steps": [{"action": "extract",
                       "extract": {"n": {"from": "text",
                                         "target": {"role": "button", "name": "不存在的按钮"}}}}]}
    exec_ir = _real_exec(plan, [element({"role": "button", "name": "登录"}, text="登录")])
    assert exec_ir["verdict"] == "inconclusive", exec_ir
    result = attribute_failure(exec_ir, preflight=preflight())
    assert result["category"] == "script_issue", result
    assert result["rule"] == "A3", result


def test_real_engine_assert_failure_reads_as_product():
    from smoke_web_engine import element

    plan = {"driver": "web", "lineage": {"id": "PLAN-ATTR-P", "version": 1},
            "steps": [{"action": "goto", "target": {"url": "/login"},
                       "assert": [{"type": "url_contains", "expected": "/dashboard",
                                   # 断言默认是 observe：不写 level=decide，它只记录不判定
                                   "level": "decide"}]}]}
    exec_ir = _real_exec(plan, [element({"role": "button", "name": "登录"}, text="登录")])
    assert exec_ir["verdict"] == "fail", exec_ir
    assert exec_ir["steps"][0]["failure_kind"] == "decide_assert_failed", exec_ir["steps"][0]
    result = attribute_failure(exec_ir, preflight=preflight(), replay=replay_report())
    assert result["category"] == "product_bug", result
    assert result["confidence"] == "high", result


# ------------------------------------------------------------------ 可审计 / 确定性

def test_step_attribution_hint_is_ignored():
    """引擎写的 `step.attribution` 只是失败瞬间的初判，看不到环境与复现，不能当结论。

    这条用例守的是"归因器不许继承上游的猜测"：初判说 product，但失败类型是定位失败，
    结论必须是 script_issue；反过来初判说 script、事实支持产品，也必须判产品。
    """
    misleading = step(0, "blocked", "locator_not_found",
                      locator={"status": "locator_not_found", "counts": [0]})
    misleading["attribution"] = "product"
    result = attribute_failure(ir(steps=[misleading]), preflight=preflight())
    assert result["category"] == "script_issue", result

    reverse = failed_assert()
    reverse["attribution"] = "script"
    result = attribute_failure(
        ir(steps=[reverse], halt={"stage": "step", "step": 0, "attribution": "script"}),
        preflight=preflight(), replay=replay_report())
    assert result["category"] == "product_bug", result


def test_considered_covers_every_rule():
    result = attribute_failure(failed_assert_ir(), preflight=preflight())
    ids = [item["id"] for item in result["considered"]]
    assert ids == [rule_id for rule_id, _ in RULES], ids
    matched = [item for item in result["considered"] if item["matched"]]
    assert len(matched) == 1, matched
    assert matched[0]["id"] == result["rule"]


def test_same_input_same_output():
    first = attribute_failure(failed_assert_ir(), preflight=preflight(),
                              replay=replay_report())
    second = attribute_failure(copy.deepcopy(failed_assert_ir()),
                               preflight=preflight(), replay=replay_report())
    assert first == second, "归因必须是纯函数：同一份事实两次调用结果必须一致"


def test_category_and_confidence_vocabularies_are_closed():
    result = attribute_failure(failed_assert_ir(), preflight=preflight())
    assert result["category"] in CATEGORIES
    assert result["confidence"] in CONFIDENCES
    for item in (("product_bug", "high"), ("env_issue", "high")):
        assert item[0] in CATEGORIES and item[1] in CONFIDENCES


if __name__ == "__main__":
    import traceback
    fails = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            try:
                fn()
                print(f"PASS {name}")
            except Exception as error:
                fails += 1
                print(f"FAIL {name}: {error}")
                traceback.print_exc()
    print("ALL PASS" if fails == 0 else f"{fails} FAILED")
    sys.exit(1 if fails else 0)
