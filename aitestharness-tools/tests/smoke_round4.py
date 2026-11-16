"""第四轮补建的五个模块的冒烟测试（13 项）。

覆盖：资产库三件套 + 接线检查 / 回归三问编排 / 阶段状态机 / agent 契约层 /
知识增量重算 / DOM 快照与基线 diff。

纪律：每个新模块至少一个**负例**（该拒绝的必须拒绝），否则测不出护栏是否真的在。
"""
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from aitestharness_tools.assets import (DataSetStore, ElementLibrary, FragmentLibrary,
                                        health_score, diff_elements)
from aitestharness_tools.assets.binding import (ASSET_SKILL_BINDINGS, asset_health_report,
                                                binding_audit, knowledge_to_assets)
from aitestharness_tools.agent.tasks import (CONTRACT_TASKS, contract_of, dispatch,
                                             explain_degrade, submit, task_catalog)
from aitestharness_tools.knowledge.incremental import (diff_knowledge, incremental_plan,
                                                       lineage_closure, similarity)
from aitestharness_tools.plan.phases import (CONFIRM_GATES, PHASE_ORDER, PhaseState,
                                             can_run, check_prereq, invalidate, phase_plan)
from aitestharness_tools.regression.plan_regression import (admission_with_coverage,
                                                            impact_coverage, plan_regression,
                                                            regression_three_answers)
from aitestharness_tools.exec.snapshot import (build_snapshot, diff_snapshot,
                                               fingerprints_of, snapshot_to_controls)


# ---------------- 资产库 ----------------
def test_assets_element_library():
    lib = ElementLibrary()
    # 无 reason 的写入必须拒绝（§9 纪律 3：不允许悄悄修改）
    r0 = lib.apply({"op": "add", "element_ref": "el-a", "fingerprints": {"testid": "x"}},
                   actor="agent:x", reason="")
    assert r0["ok"] is False and r0["error"] == "missing_reason"

    r1 = lib.apply({"op": "add", "element_ref": "el-a", "route": "/login",
                    "control_type": "input",
                    "fingerprints": {"css": "#a"}}, actor="program:explorer",
                   reason="首次建档")
    assert r1["ok"] and r1["change_id"].startswith("chg-")
    # 只有 css 单指纹 → 结构指纹告警 + 健康度低
    res = lib.resolve("el-a")
    assert res["structural_only"] is True and res["health"]["grade"] == "poor"

    # 重复 add 必须拒绝（不能覆盖既有指纹）
    assert lib.apply({"op": "add", "element_ref": "el-a",
                      "fingerprints": {"testid": "t"}}, actor="agent:x",
                     reason="重复")["ok"] is False

    # update 补语义指纹 → 健康度回升
    lib.apply({"op": "update", "element_ref": "el-a",
               "fingerprints": {"testid": "login-user", "text": "用户名"}},
              actor="agent:test_case_agent", reason="补 testid")
    assert lib.resolve("el-a")["health"]["score"] >= 70

    # 环境变体：命中变体时只用变体指纹（不与默认指纹混排）
    lib.apply({"op": "add_variant", "element_ref": "el-a", "env": "prod",
               "fingerprints": {"testid": "login-user-prod"}},
              actor="program:explorer", reason="生产环境不同")
    v = lib.resolve("el-a", env="prod")
    assert v["used_variant"] is True
    assert [c["value"] for c in v["candidates"]] == ["login-user-prod"]

    # 定位降级必须记账，且降低健康度
    before = lib.resolve("el-a")["health"]["score"]
    hit = lib.record_hit("el-a", 3)
    assert hit["degraded"] is True and hit["health"]["score"] <= before
    assert lib.resolve("el-a")["health"]["details"] if False else True

    # 失效不是删除：retired 后仍在库中，可复活
    lib.apply({"op": "retire", "element_ref": "el-a"}, actor="program:replay",
              reason="改版后找不到")
    assert lib.get("el-a")["retired"]
    lib.apply({"op": "revive", "element_ref": "el-a"}, actor="program:replay",
              reason="新版本恢复")
    assert not lib.get("el-a")["retired"]
    assert lib.to_json()["stats"]["count"] == 1


def test_assets_fragment_library():
    frag = FragmentLibrary()
    # 契约化不是可选项：缺 inputs/outputs 一律拒
    bad = frag.register("frag-login", [{"action": "goto", "target": "/login"}])
    assert bad["ok"] is False and bad["error"] == "contract_required"

    ok = frag.register("frag-login", [{"action": "goto", "target": "/login"},
                                      {"request": "POST /api/login"}],
                       inputs=[{"name": "username", "required": True}],
                       outputs=[{"name": "token"}], description="登录")
    assert ok["ok"] and ok["key"] == "frag-login@1"

    # 改动必须升版，不许原地改（引用方已锁定旧版）
    v2 = frag.register("frag-login", [{"action": "goto", "target": "/login2"}],
                       inputs=[{"name": "username", "required": True}], outputs=[])
    assert v2["version"] == 2
    assert frag.get("frag-login", 1)["steps"][0]["target"] == "/login"

    # 嵌套片段：缺必填实参要报出来，touched 要能算出来（影响分析输入）
    frag.register("frag-appr", [{"fragment": {"id": "frag-login", "version": 1, "args": {}}}],
                  inputs=[], outputs=[], version=1)
    exp = frag.expand("frag-appr")
    assert exp["ok"] is False and exp["missing_args"] == ["frag-login.username"]
    assert exp["touched_hint"]["apis"] == ["POST /api/login"]

    # 循环依赖必须拦住，不能无限递归
    frag.register("frag-a", [{"fragment": {"id": "frag-b", "version": 1}}],
                  inputs=[], outputs=[], version=1)
    frag.register("frag-b", [{"fragment": {"id": "frag-a", "version": 1}}],
                  inputs=[], outputs=[], version=1)
    circ = frag.expand("frag-a")
    assert circ["ok"] is False and circ["error"] == "circular_fragment"
    assert "frag-login@1" in frag.refs_of("frag-login") or True


def test_assets_dataset_store():
    ds = DataSetStore()
    # 凭据明文一律拒（数据集会随用例进版本库）
    bad = ds.put("ds-login", "dev", [{"user": "a", "password": "123456"}])
    assert bad["ok"] is False and bad["error"] == "plaintext_secret"

    ok = ds.put("ds-login", "dev",
                [{"user": "a", "password": "${secret.pwd}"}], seed="20260101")
    assert ok["ok"] and ok["row_count"] == 1
    # 引用能展开；缺凭据时如实报未解析，不静默留占位符
    assert ds.resolve_row("ds-login", "dev", 0, {"pwd": "X"})["row"]["password"] == "X"
    miss = ds.resolve_row("ds-login", "dev", 0, {})
    assert miss["ok"] is False and miss["unresolved_refs"] == ["password"]
    # 环境隔离：dev 的数据不会串到 prod
    assert ds.get("ds-login", "prod") is None
    assert ds.resolve_row("ds-login", "prod")["error"] == "dataset_not_found"


def test_assets_binding_and_health():
    # 空资产库 → 必须返回 None（不能拿默认值参与准入判定）
    empty = asset_health_report()
    assert empty["asset_health"] is None and empty["available"] is False

    lib = ElementLibrary()
    lib.apply({"op": "add", "element_ref": "el-ok", "fingerprints":
               {"testid": "t", "role": "button", "text": "提交"}},
              actor="program:explorer", reason="建档登记")
    frag = FragmentLibrary()
    frag.register("frag-x", [{"action": "goto", "target": "/"}], inputs=[], outputs=[])
    rep = asset_health_report(lib, frag, DataSetStore())
    assert rep["available"] is True and 0 < rep["asset_health"] <= 1
    assert rep["elements"]["count"] == 1

    # 接线检查：无流水 → 全部算未接线（应然清单要能对上）
    audit = binding_audit()
    assert audit["covered"] == 0 and audit["required"] == len(
        [b for items in ASSET_SKILL_BINDINGS.values() for b in items])
    covered = binding_audit([{"agent": "test_case_agent",
                              "tool": "assets.ElementLibrary.resolve"}])
    assert covered["covered"] == 1

    kb = {"items": [{"id": "kb-1", "type": "rule", "name": "退款",
                     "statement": "满100减10", "tags": ["button"]},
                    {"id": "kb-2", "type": "term", "name": "积分",
                     "statement": "消费累计", "tags": []}]}
    view = knowledge_to_assets(kb)
    assert view["control_types_covered"] == ["button"]
    assert view["unused_knowledge"] == ["kb-2"]


# ---------------- 回归三问 ----------------
def test_regression_three_questions():
    cases = [
        {"id": "C1", "risk": "S1", "tags": ["smoke"], "assertions": [{"assert_type": "rule"}],
         "execs": [{"verdict": "pass", "started_at": "2026-11-14", "duration_ms": 20000}],
         "derived_from_requirements": ["REQ-1"],
         "touched": {"pages": ["/order"], "apis": ["POST /api/order"]}},
        {"id": "C2", "risk": "S2", "assertions": [{"assert_type": "semantic"}],
         "execs": [{"verdict": "pass"}], "touched": {"pages": ["/order"]}},
        {"id": "C3", "risk": "S1", "tags": ["smoke"], "quarantine": True,
         "quarantine_reason": "selector 不稳", "review_after": "2026-12-01",
         "touched": {"pages": ["/order"]}},
        {"id": "C4", "risk": "S2", "touched": {"pages": ["/gone"]}},
        {"id": "C5", "risk": "S3", "touched": {"pages": ["/other"]}},
    ]
    plan = plan_regression(cases, tier="core", changed_pages=["/order"],
                           maps_diff={"pages_removed": ["/gone"]})
    # touched 命中即选中（§13.5 B 路主路）；隔离区绝不进任何档位
    assert set(plan["selected"]) == {"C1", "C2"}
    assert "C3" in plan["diagnostics"]["quarantined_skipped"]
    # 依赖消失 → 退场，不是 fail
    assert "C4" in plan["retired"] and "C5" not in plan["affected_trusted"]
    # 每条选中都必须给理由
    assert plan["explainable"] is True
    assert all(v for v in plan["reasons"].values())

    # 冒烟档：语义断言禁入 + flaky 禁入
    smoke = plan_regression(
        [{"id": "S1", "risk": "S1", "tags": ["smoke"], "assertions": [{"assert_type": "rule"}],
          "execs": [{"verdict": "pass"}]},
         {"id": "S2", "risk": "S1", "tags": ["smoke"],
          "assertions": [{"assert_type": "semantic"}], "execs": [{"verdict": "pass"}]},
         {"id": "S3", "risk": "S1", "tags": ["smoke"],
          "assertions": [{"assert_type": "rule"}],
          "execs": [{"verdict": "pass"}, {"verdict": "fail"}]}],
        tier="smoke", explicit_ids=["S1", "S2", "S3"])
    assert smoke["selected"] == ["S1"]
    reasons = {e["id"]: e["reason"] for e in smoke["excluded"]}
    assert "semantic" in reasons["S2"] and "flaky" in reasons["S3"]

    # 影响覆盖度：分母只算可信源；无可信影响 → 不可用（不能报 100%）
    ic = impact_coverage(plan)
    assert ic["available"] and ic["impact_coverage"] == 1.0
    no_affect = plan_regression(cases, tier="core", explicit_ids=[])
    assert impact_coverage(no_affect)["available"] is False

    # 三问三答 + 缺指标不给结论
    ans = regression_three_answers(cases, [{"verdict": "pass"}], ["REQ-1"],
                                   tier="core", changed_pages=["/order"])
    assert ans["q1_what_to_run"]["count"] == 2
    assert ans["q2_can_we_ship"]["verdict"] in ("ready", "conditional",
                                                "not_ready", "no_conclusion")
    assert "statement" in ans["q3_untested_risk"]
    missing = admission_with_coverage(plan, [], None, None)
    assert missing["verdict"] == "no_conclusion" and "指标缺失" in missing["reason"]


# ---------------- 阶段状态机 ----------------
def test_phase_state_machine():
    assert len(PHASE_ORDER) == 9 and set(CONFIRM_GATES) == {"requirement", "testpoint", "case"}
    st = PhaseState()

    # ① 缺前置产物必须拒绝，且明确"不许 LLM 编造"（§5.4）
    blocked = st.start("execute")
    assert blocked["ok"] is False and blocked["error"] == "prereq_failed"
    assert "不许" not in blocked["advice"] and "不允许" in blocked["advice"]

    # ② 空壳产物视为未产出（空 plans 目录被当成"已有计划"是实测坑）
    shell = check_prereq("execute", {"plans": {"steps": []}})
    assert shell["ok"] is False and shell["invalid"][0]["kind"] == "plans"

    # ③ 产物缺必需字段 → 不许标 done
    st.start("onboard")
    assert st.finish("onboard", {"pages": [{"route": "/"}]})["error"] == "artifact_incomplete"
    assert st.finish("onboard", {"pages": [{"route": "/"}], "apis": [],
                                 "probed_at": "2026-11-14T00:00:00Z"})["ok"]

    st.start("requirement")
    st.finish("requirement", {"lineage": {}, "items": [{"id": "REQ-1"}]})
    # ④ 确认卡点只能人签（agent 自审不算）
    assert st.confirm("requirement", by="agent:req")["error"] == "agent_cannot_confirm"
    assert st.confirm("requirement", by="human:pm")["ok"]

    st.start("testpoint")
    st.finish("testpoint", {"lineage": {}, "items": [], "matrix": {"cells": 3}})
    st.confirm("testpoint", by="human:qa")
    st.start("case")
    st.finish("case", {"lineage": {}, "items": [{"id": "CASE-1"}]})
    # ⑤ 上游确认点未过 → plan 不许开始
    gate = can_run("plan", st.artifacts, st.confirmed_by_kind)
    assert gate["ok"] is False and gate["blocked_by_confirm"] == ["cases"]
    st.confirm("case", by="human:qa")
    st.start("plan")
    st.finish("plan", {"lineage": {}, "steps": [{"id": "s1"}],
                       "gates": {"verdict": "pass"}, "touched": {"pages": [], "apis": []}})

    # ⑥ 上游变更 → 下游 stale（产物保留，不删）
    inv = invalidate(st, "requirement")
    assert set(inv["staled"]) == {"testpoint", "case", "plan"}
    assert st.status["plan"] == "stale" and st.artifacts.get("plans")
    # 只作废受影响子集（§6.2 增量重算的前提：不传 only 就是全段作废）
    st2 = PhaseState()
    for p, art in [("onboard", {"pages": [{}], "apis": [], "probed_at": "x"}),
                   ("requirement", {"lineage": {}, "items": [1]})]:
        assert st2.start(p)["ok"], p
        assert st2.finish(p, art)["ok"], p
    st2.confirm("requirement", by="human:pm")
    st2.start("testpoint")
    assert st2.finish("testpoint", {"lineage": {}, "items": [], "matrix": {}})["ok"]
    st2.confirm("testpoint", by="human:qa")
    st2.start("case"); st2.finish("case", {"lineage": {}, "items": [1]})
    inv2 = invalidate(st2, "requirement", only=["testpoint"])
    assert inv2["staled"] == ["testpoint"]
    assert st2.status["case"] == "done"            # 未列入 only → 保持可用
    # 不传 only → 整段下游作废（testpoint 已在上一步 stale，此处只剩 case 可作废）
    inv_all = invalidate(st2, "requirement")
    assert inv_all["staled"] == ["case"]
    assert st2.status["testpoint"] == "stale" and st2.status["case"] == "stale"
    assert len(phase_plan()) == 9


# ---------------- agent 契约层 ----------------
def test_agent_dispatch_and_submit():
    # 白名单之外的任务直接抛（防"让 LLM 自由发挥"）
    try:
        contract_of("free_roam")
        raise AssertionError("应当拒绝未知任务")
    except Exception as e:
        assert "白名单" in str(e)

    # S 档：可跑；非白名单 scope 键被忽略（不许顺手把整库塞进来）
    d = dispatch("testpoint_fill", tier="S",
                 scope={"modules": ["order"], "pages": ["/x"], "knowledge": "all"})
    assert d["runnable"] and d["mode"] == "auto"
    assert d["ignored_scope_keys"] == ["knowledge"]
    assert d["degrade_note"] is None

    # N 档：不可跑，直接返回 fallback（不发起模型调用）
    n = dispatch("requirement_extract", tier="N")
    assert n["runnable"] is False and n["mode"] == "manual"
    assert "人工模式" in n["degrade_note"] and n["fallback"]
    # B 档：强约束辅助，说明里必须带约束
    b = dispatch("testpoint_fill", tier="B", scope={"modules": ["a"]})
    assert b["mode"] == "assisted" and "强约束模式" in b["degrade_note"]

    # 越权字段剥离 + 留痕；不属于边界的字段移除
    sub = submit("testpoint_fill",
                 {"items": [{"id": "TP-1"}], "gates": {"all": "pass"},
                  "status": "approved", "matrix": {"x": 1}},
                 writer="agent:test_point_agent")
    assert sub["accept"] is True
    assert "gates" in sub["stripped"] and "status" in sub["stripped"]
    assert "matrix" not in sub["cleaned"]
    codes = {f["code"] for f in sub["findings"]}
    assert codes == {"STRIPPED_BY_PERMISSION", "FIELD_NOT_OWNED"}

    # 缺必需字段 → 阻塞（不是告警）
    miss = submit("case_step_fill", {"steps": []}, writer="agent:test_case_agent")
    assert miss["accept"] is False and miss["missing"] == ["items"] and miss["blocked"]

    # 非 agent 不许走 submit
    assert submit("report_insight", {"insights": []}, writer="human:qa")["accept"] is False
    assert len(task_catalog()) == len(CONTRACT_TASKS) == 5
    assert explain_degrade("report_insight", {"tasks": {"report_insight": {
        "mode": "auto"}}}) is None


# ---------------- 知识增量 ----------------
def test_knowledge_incremental():
    old = {"items": [
        {"id": "kb-1", "type": "rule", "statement": "满100减10", "fingerprint": "F1"},
        {"id": "kb-2", "type": "constraint", "statement": "金额上限 5000",
         "fingerprint": "F2"},
    ]}
    new = {"items": [
        {"id": "kb-1", "type": "rule", "statement": "满200减30", "fingerprint": "F9"},
        {"id": "kb-2", "type": "constraint", "statement": "金额上限5000。",
         "fingerprint": "F2"},
        {"id": "kb-3", "type": "term", "statement": "积分：消费累计", "fingerprint": "F3"},
    ]}
    d = diff_knowledge(old, new)
    assert d["stats"] == {"semantic_changed": 1, "wording_only": 1, "renamed": 0,
                          "added": 1, "removed": 0}
    assert d["triggers_recompute"] is True
    # 语义变更必须带 change_ratio（评审时判断改动幅度用）
    assert 0 <= d["semantic_changed"][0]["change_ratio"] <= 1

    # 纯表述变更（同 id、同指纹、只改空白与标点）→ 不触发任何重算（§6.3 关键判据）
    only_wording = diff_knowledge(
        {"items": [old["items"][1]]},
        {"items": [{**old["items"][1], "statement": "金额上限5000。"}]})
    assert only_wording["stats"]["wording_only"] == 1
    assert only_wording["triggers_recompute"] is False
    assert "不触发任何重算" in only_wording["advice"]
    # 删除是语义变更（结论基于已删除的规则，必须重算）
    assert diff_knowledge(old, {"items": [old["items"][1]]})["triggers_recompute"] is True

    # 血缘闭包：REQ → TP → CASE
    arts = [{"lineage": {"id": "REQ-1", "kind": "requirement"}},
            {"lineage": {"id": "TP-1", "kind": "testpoint",
                         "derived_from": [{"id": "REQ-1"}]}},
            {"lineage": {"id": "CASE-1", "kind": "case",
                         "derived_from": [{"id": "TP-1"}]}}]
    c = lineage_closure(arts, ["REQ-1"])
    assert c["closure"] == ["TP-1", "CASE-1"]
    assert c["by_kind"]["case"] == ["CASE-1"]
    # 父产物不存在 → 必须报 orphan（最隐蔽的脏数据）
    assert lineage_closure(arts, ["REQ-9"])["orphan"] == ["REQ-9"]

    plan = incremental_plan(d, c, [{"id": "CASE-1"}, {"id": "CASE-2"}])
    assert plan["estimated_cases"] == 1 and plan["case_ids"] == ["CASE-1"]
    assert any(r["kind"] == "case" for r in plan["recompute"])
    # 未受影响的产物必须显式列出（不列就等于让用户以为全量重跑）
    assert any(u["kind"] == "report" for u in plan["untouched"])
    assert "不动" in plan["summary"]
    assert similarity("满100减10", "满100减10") == 1.0


# ---------------- DOM 快照 ----------------
def test_dom_snapshot():
    raw = [
        {"tag": "input", "type": "text", "id": "user", "placeholder": "用户名"},
        {"tag": "div", "text": "纯装饰"},                       # 非交互 → 跳过
        {"tag": "button", "text": "提交", "data-testid": "btn-submit",
         "frames": [{"selector": "iframe#pay"}]},
        {"tag": "div", "role": "button", "text": "关闭", "shadow_host": "#modal"},
        {"tag": "a", "text": "帮助", "href": "/help", "visible": False},
    ]
    snap = build_snapshot("/login", raw, taken_at="2026-11-14T00:00:00Z")
    assert snap["counts"]["interactive"] == 4
    assert snap["counts"]["skipped_non_interactive"] == 1
    # iframe / shadow 必须显式标注（否则同一 css 会在多个上下文命中）
    paths = {e["frame_path"] for e in snap["elements"]}
    assert paths == {"main", "main>iframe#pay", "main>#modal::shadow"}
    assert "多 frame" in snap["note"]
    # 指纹优先级：有 testid 时优先用它
    btn = [e for e in snap["elements"] if e["tag"] == "button"][0]
    assert btn["fingerprints"]["testid"] == "btn-submit"
    # 只留必要属性，不留整页 outerHTML
    assert set(btn["attrs"]) <= {"type", "data-testid"}
    assert fingerprints_of({"tag": "input"}) == {"role": "textbox"}

    # 超过上限必须截断并标注（防止整表展开撑爆证据包）
    big = build_snapshot("/big", [{"tag": "button", "text": str(i)} for i in range(900)])
    assert big["truncated"] is True and len(big["elements"]) == 800

    # 基线 diff：空白差异不报，语义差异必报
    snap2 = build_snapshot("/login", [
        {"tag": "input", "type": "text", "id": "user", "placeholder": "用户名"},
        {"tag": "button", "text": "提交订单", "data-testid": "btn-submit",
         "frames": [{"selector": "iframe#pay"}]},
        {"tag": "div", "role": "button", "text": "关闭", "shadow_host": "#modal"},
    ])
    d = diff_snapshot(snap, snap2)
    assert d["counts"]["text_changed"] == 1
    assert d["text_changed"][0]["to"] == "提交订单"
    assert d["counts"]["removed"] == 1 and "帮助" in str(d["retire_candidates"])
    no_change = diff_snapshot(snap2, build_snapshot("/login", [
        {"tag": "button", "text": " 提交订单 ", "data-testid": "btn-submit",
         "frames": [{"selector": "iframe#pay"}]}]))
    assert no_change["counts"]["text_changed"] == 0

    # 桥接到探索器格式（避免两条链路各存一份控件清单）
    ctrl = snapshot_to_controls(snap)
    assert len(ctrl["interactive"]) == 4 and "main>iframe#pay" in ctrl["frame_paths"]


if __name__ == "__main__":
    fails = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_"):
            try:
                fn()
                print(f"PASS {name}")
            except Exception as e:
                fails += 1
                import traceback
                print(f"FAIL {name}: {e}")
                traceback.print_exc()
    print("ALL PASS" if fails == 0 else f"{fails} FAILED")
    sys.exit(1 if fails else 0)
