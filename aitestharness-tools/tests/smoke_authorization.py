"""写操作授权闸（P4 判据 3）验收。

这一层要守的是一句话：**能被改的数据，必须先被批过**。所以用例的重点不是"闸能过"，
而是"该拦的都拦住了、且拦的理由说的是真的"：

  1. **拦得住四类真事故**（忘了批 / 批的不是这份计划 / 跨环境挪用 / 一次批准反复用）；
  2. **拦的时候不误伤**——只读计划不该被卡（否则人会把审批当例行手续，闸退化成仪式）；
  3. **拦得准**——改一个断言不该要求重新审批（那是观测，不是副作用），
     改一个动作必须重新审批（那是副作用本身）；
  4. **拦的结论必须进 IR**——否则事后只有"没跑"，没有"谁批的 / 批的是什么"。
"""
import glob
import os
import sys
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from aitestharness_tools.exec.authorization import (authorize_plan, build_approval,
                                                    plan_actions, plan_fingerprint)
from aitestharness_tools.exec.web_engine import WebEngine

ENV = "bbiao-admin@local"
NOW = datetime(2026, 11, 19, 12, 0, tzinfo=timezone.utc)

READ_ONLY_PLAN = {
    "driver": "web",
    "lineage": {"id": "PLAN-RO", "version": 1},
    "steps": [
        {"action": "goto", "target": {"url": "/system/user/index"}},
        {"action": "extract", "key": "row_count", "target": {"css": ".el-table__row"}},
        {"action": "wait", "wait": [{"type": "element_visible",
                                    "target": {"css": ".el-table__row"}}]},
    ],
}

WRITE_PLAN = {
    "driver": "web",
    "lineage": {"id": "PLAN-RW", "version": 1},
    "steps": [
        {"action": "goto", "target": {"url": "/system/user/index"}},
        {"action": "click", "target": {"role": "button", "name": "添加用户"}},
        {"action": "fill", "target": {"label": "用户名"}, "value": "qa_probe"},
        {"action": "click", "target": {"role": "button", "name": "创建用户"}},
    ],
}


# ---------------------------------------------------------------- 分类与指纹
def test_read_only_plan_not_required():
    gate = authorize_plan(READ_ONLY_PLAN, None, env_id=ENV)
    assert gate["allow"] is True, gate
    assert gate["status"] == "not_required", gate
    assert gate["required_actions"] == [], gate


def test_write_plan_requires_approval():
    gate = authorize_plan(WRITE_PLAN, None, env_id=ENV)
    assert gate["allow"] is False, gate
    assert gate["status"] == "missing_approval", gate
    # 不是 fail：被测系统没坏，是这次执行不该被允许
    assert gate["verdict"] == "invalid", gate
    assert set(gate["required_actions"]) == {"click", "fill"}, gate


def test_approval_covers_plan():
    approval = build_approval(WRITE_PLAN, env_id=ENV, issued_by="human:qa-lead", now=NOW)
    gate = authorize_plan(WRITE_PLAN, approval, env_id=ENV, now=NOW)
    assert gate["allow"] is True, gate
    assert gate["status"] == "approved", gate
    assert gate["approval_id"] == approval["id"], gate


def test_fingerprint_is_order_insensitive_and_stable():
    reordered = {"steps": WRITE_PLAN["steps"], "driver": "web",
                 "lineage": WRITE_PLAN["lineage"]}
    assert plan_fingerprint(WRITE_PLAN) == plan_fingerprint(reordered)
    assert plan_fingerprint(WRITE_PLAN) == plan_fingerprint(WRITE_PLAN)


# ---------------------------------------------------------------- 四类事故
def test_changed_action_invalidates_approval():
    """批的是这份计划，不是"这类操作"：多一个删除动作就必须重新批。"""
    approval = build_approval(WRITE_PLAN, env_id=ENV, issued_by="human:qa-lead", now=NOW)
    tampered = {**WRITE_PLAN, "steps": WRITE_PLAN["steps"] + [
        {"action": "click", "target": {"role": "button", "name": "注销"}}]}
    gate = authorize_plan(tampered, approval, env_id=ENV, now=NOW)
    assert gate["allow"] is False, gate
    assert gate["status"] == "plan_mismatch", gate


def test_changed_assertion_keeps_approval():
    """改断言不改副作用，不该要求重新审批。

    这是刻意的取舍：若断言也进指纹，"改一个错别字就要重批"，人的实际反应是绕过
    审批（写一条万能 approval），闸就退化成仪式。代价是"删断言换取通过"不受此闸
    约束——那属于结论质量问题，由 decide 断言与 replay 一致性管。
    """
    approval = build_approval(WRITE_PLAN, env_id=ENV, issued_by="human:qa-lead", now=NOW)
    steps = [dict(step) for step in WRITE_PLAN["steps"]]
    steps[-1] = {**steps[-1], "assert": [
        {"type": "text_visible", "value": "创建成功", "level": "decide"}]}
    gate = authorize_plan({**WRITE_PLAN, "steps": steps}, approval, env_id=ENV, now=NOW)
    assert gate["allow"] is True, gate
    assert gate["status"] == "approved", gate


def test_env_mismatch_rejected():
    approval = build_approval(WRITE_PLAN, env_id=ENV, issued_by="human:qa-lead", now=NOW)
    gate = authorize_plan(WRITE_PLAN, approval, env_id="production@prod", now=NOW)
    assert gate["allow"] is False, gate
    assert gate["status"] == "env_mismatch", gate
    assert ENV in gate["reasons"][0], gate


def test_missing_env_id_rejected():
    """没有 env_id 就不做降级：环境校验是"跨环境挪用"的唯一防线。"""
    approval = build_approval(WRITE_PLAN, env_id=ENV, issued_by="human:qa-lead", now=NOW)
    gate = authorize_plan(WRITE_PLAN, approval, env_id=None, now=NOW)
    assert gate["allow"] is False, gate
    assert gate["status"] == "env_unverifiable", gate


def test_expired_approval_rejected():
    approval = build_approval(WRITE_PLAN, env_id=ENV, issued_by="human:qa-lead",
                              ttl_minutes=30, now=NOW)
    gate = authorize_plan(WRITE_PLAN, approval, env_id=ENV,
                          now=NOW + timedelta(minutes=31))
    assert gate["allow"] is False, gate
    assert gate["status"] == "expired", gate


def test_approval_still_valid_before_expiry():
    approval = build_approval(WRITE_PLAN, env_id=ENV, issued_by="human:qa-lead",
                              ttl_minutes=30, now=NOW)
    gate = authorize_plan(WRITE_PLAN, approval, env_id=ENV,
                          now=NOW + timedelta(minutes=29))
    assert gate["allow"] is True, gate


def test_single_use_approval_cannot_be_replayed():
    """批的是"建一个账号"，不能跑成建一百个。"""
    approval = build_approval(WRITE_PLAN, env_id=ENV, issued_by="human:qa-lead",
                              single_use=True, now=NOW)
    approval["used_at"] = (NOW + timedelta(minutes=1)).isoformat()
    gate = authorize_plan(WRITE_PLAN, approval, env_id=ENV, now=NOW)
    assert gate["allow"] is False, gate
    assert gate["status"] == "already_used", gate


def test_actions_not_covered_rejected():
    """授权范围可以收窄：只批 click 不批 fill 时，含 fill 的计划不能跑。"""
    approval = build_approval(WRITE_PLAN, env_id=ENV, issued_by="human:qa-lead",
                              actions=["click"], now=NOW)
    gate = authorize_plan(WRITE_PLAN, approval, env_id=ENV, now=NOW)
    assert gate["allow"] is False, gate
    assert gate["status"] == "actions_not_covered", gate
    assert "fill" in gate["reasons"][0], gate


def test_corrupt_approval_rejected():
    incomplete = {"id": "APR-X", "plan_hash": plan_fingerprint(WRITE_PLAN)}
    gate = authorize_plan(WRITE_PLAN, incomplete, env_id=ENV, now=NOW)
    assert gate["allow"] is False, gate
    assert gate["status"] == "approval_corrupt", gate


# ---------------------------------------------------------------- 覆盖边界
def test_teardown_mutation_is_covered():
    """主步骤只读、teardown 写：清理本身是写操作，必须一并批准。

    不覆盖这里的后果很实际：主流程批了、清理没批 → 拒绝清理 → 残留留在被测系统。
    """
    plan = {**READ_ONLY_PLAN, "teardown": {"steps": [
        {"action": "click", "target": {"role": "button", "name": "注销"}}]}}
    assert "click" in plan_actions(plan)["mutating"]
    gate = authorize_plan(plan, None, env_id=ENV)
    assert gate["allow"] is False, gate
    assert gate["status"] == "missing_approval", gate


def test_api_read_is_not_required_and_write_is():
    read = {"driver": "api", "lineage": {"id": "P-A1", "version": 1},
            "steps": [{"request": "GET /api/users"}]}
    write = {"driver": "api", "lineage": {"id": "P-A2", "version": 1},
             "steps": [{"request": "POST /api/users"}]}
    assert authorize_plan(read, None, env_id=ENV)["status"] == "not_required"
    gate = authorize_plan(write, None, env_id=ENV)
    assert gate["status"] == "missing_approval", gate
    assert gate["required_actions"] == ["POST"], gate


def test_session_write_is_covered():
    """把写操作塞进 session 段不能绕过闸。

    session 段本来是登录（POST /login），它天然是写动作。如果只遍历 steps，
    "计划里全是 GET"就会判成只读——而它实际上会建会话、可能建更多东西。
    """
    plan = {"driver": "api", "lineage": {"id": "P-S", "version": 1},
            "session": [{"request": "POST /api/login"}],
            "steps": [{"request": "GET /api/orders"}]}
    gate = authorize_plan(plan, None, env_id=ENV)
    assert gate["allow"] is False, gate
    assert gate["status"] == "missing_approval", gate
    assert gate["required_actions"] == ["POST"], gate


def test_api_engine_halts_before_session_runs():
    """闸必须在 session 之前判：等登录跑完再问"允不允许"，顺序已经反了。"""
    from aitestharness_tools.exec.api_engine import ApiEngine

    plan = {"driver": "api", "lineage": {"id": "P-S2", "version": 1},
            "session": [{"request": "POST /api/login"}],
            "steps": [{"request": "GET /api/orders"}]}
    # base_url 指向必然连不通的地址：若闸失效而真的发了请求，会得到 error 而不是 invalid
    engine = ApiEngine("http://127.0.0.1:9", {}, env_id=ENV)
    result = engine.run_plan(plan)
    assert result["verdict"] == "invalid", result
    assert result["halt"]["stage"] == "authorization", result["halt"]
    assert result["steps"] == [], "被拦下时 session 段也不该执行"
    assert result["authorization"]["trust"] == "asserted", result["authorization"]


def test_unknown_action_treated_as_mutating():
    """判断不了的动作按写处理：保守方向的代价只是多批一次。"""
    plan = {"driver": "web", "lineage": {"id": "P-U", "version": 1},
            "steps": [{"action": "drag_and_drop", "target": {"css": "#a"}}]}
    gate = authorize_plan(plan, None, env_id=ENV)
    assert gate["status"] == "missing_approval", gate
    assert gate["required_actions"] == ["drag_and_drop"], gate


# ---------------------------------------------------------------- 引擎入口
class _NoopDriver:
    """只为验证"闸拦下时引擎一步都不跑"。

    `clear_requests` / `requests_seen` 是引擎在第一批步骤前的**记账**调用，与页面无关，
    所以正常实现；其余任何页面原语被调用都算闸失效（记下来并抛）。
    """

    def __init__(self):
        self.calls = 0

    def clear_requests(self):
        return None

    def requests_seen(self):
        return []

    def __getattr__(self, name):
        def _recorded(*args, **kwargs):
            self.calls += 1
            raise AssertionError(f"闸拦下后不应调用驱动原语：{name}")
        return _recorded


def test_engine_halts_before_touching_driver():
    driver = _NoopDriver()
    result = WebEngine(driver, {}, env_id=ENV).run_plan(WRITE_PLAN)
    assert result["verdict"] == "invalid", result
    assert result["halt"]["stage"] == "authorization", result["halt"]
    assert result["steps"] == [], "被拦下时不应有任何步骤记录"
    assert result["consistency"]["status"] == "skipped", result["consistency"]
    assert driver.calls == 0, "闸拦下后驱动不应被调用一次"


def test_engine_ir_carries_authorization_evidence():
    """报告要能回答"谁批的、批的是哪份计划"，不能只有"没跑"。"""
    driver = _NoopDriver()
    result = WebEngine(driver, {}, env_id=ENV).run_plan(WRITE_PLAN)
    block = result["authorization"]
    assert block["status"] == "missing_approval", block
    assert block["plan_hash"] == plan_fingerprint(WRITE_PLAN), block
    assert block["env_id"] == ENV, block
    assert block["required_actions"] == ["click", "fill"], block
    # 未经签名校验这件事必须显式带出，否则读者会以为这是一条可信的批准
    assert block["trust"] == "asserted", block


def test_engine_runs_when_approved():
    """批准后闸不该改变执行路径：真的开始跑步骤，而不是换个理由拒绝。"""
    from smoke_web_engine import FakeDriver, element

    driver = FakeDriver([
        element({"role": "button", "name": "添加用户"}, text="添加用户"),
        element({"label": "用户名"}, text=""),
        element({"role": "button", "name": "创建用户"}, text="创建用户"),
    ])
    approval = build_approval(WRITE_PLAN, env_id=ENV, issued_by="human:qa-lead")
    result = WebEngine(driver, {}, env_id=ENV, authorization=approval,
                       locator_timeout_ms=0, poll_ms=10).run_plan(WRITE_PLAN)
    assert result["authorization"]["status"] == "approved", result["authorization"]
    assert (result["halt"] or {}).get("stage") != "authorization", result["halt"]
    assert result["steps"], "批准后应当真的执行了步骤"


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
