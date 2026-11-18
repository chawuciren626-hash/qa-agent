"""各阶段工具冒烟测试：跑通全链路（血缘→验收检查→覆盖对账→五闸→执行引擎→回归/flaky→facts→台账→分发协商）。"""
import sys, os, tempfile
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from aitestharness_tools.common.lineage import make_lineage, content_hash, new_artifact_id, semantic_fingerprint
from aitestharness_tools.common.semantic_diff import semantic_diff, needs_recompute
from aitestharness_tools.common.capability import negotiate, PolicySnapshot
from aitestharness_tools.requirement.acceptance import check_acceptance_observable, change_impact
from aitestharness_tools.testpoint.coverage import coverage_gaps
from aitestharness_tools.plan.gates import compile_gates, gates_summary, extract_touched
from aitestharness_tools.exec.api_engine import run_plan
from aitestharness_tools.regression.selector import select_regression, verdict_of_samples, quarantine_check
from aitestharness_tools.report.reviewer import extract_facts, RiskLedger, REVIEWER_PROMPT
from aitestharness_tools.requirement.parsers import parse_markdown, parse_openapi, parse_prototype, check_location
from aitestharness_tools.requirement.testability import check_testability
from aitestharness_tools.testpoint.matrix import build_matrix, matrix_gaps, assign_verify_mode, search_checklist
from aitestharness_tools.case.builder import build_case_skeleton, DataFactory, check_case_budget, reconcile_enumeration
from aitestharness_tools.defect.tools import (build_evidence_pack, dedup_defects,
                                              render_defect_ticket, identify_heisenbug, defect_fingerprint)
from aitestharness_tools.exec.wait_assert import (WAIT_TYPES, check_wait_step,
                                                  AssertionEngine, assertion_level)
from aitestharness_tools.exec.infra import classify_for_heal, CredentialCenter, HEAL_LEVELS
from aitestharness_tools.exec.api_ext import ResponseContractValidator, AsyncPoller, extract_variable, DatabaseAsserter
from aitestharness_tools.exec.native_mini import LocResolver, DeviceQueue, PopupPolicyChain
from aitestharness_tools.exec.hybrid import check_hybrid_plan, weakest_link_verdict, allocation_audit
from aitestharness_tools.exec.pools import PoolScheduler


def test_lineage_and_id():
    head = make_lineage("requirement", new_artifact_id("requirement", 44), 2, actor="human")
    assert head["lineage"]["id"] == "req-0044"
    assert content_hash({"lineage": head["lineage"], "x": 1}) == content_hash({"lineage": None, "x": 1})
    assert semantic_fingerprint("登录成功，显示首页！") == semantic_fingerprint("登录 成功 显示 首页")
    assert semantic_fingerprint("登录成功") != semantic_fingerprint("登录失败")


def test_semantic_diff():
    old = {"acceptance": [{"observable": "提交后显示成功提示"}], "title_raw": "登录需求v1"}
    new = {"acceptance": [{"observable": "提交后跳转至首页"}], "title_raw": "登录需求v2"}
    changes = semantic_diff(old, new)
    assert needs_recompute(changes)          # observable 变了 → 语义变更
    old2 = {"acceptance": [{"observable": "提交后显示成功提示"}], "title_raw": "登录需求A"}
    assert not needs_recompute(semantic_diff(old2, {**old2, "title_raw": "登录需求B"}))


def test_acceptance_check():
    bad = {"acceptance": [{"observable": "界面美观好用"}]}
    errs = check_acceptance_observable(bad)
    assert any(f.level == "error" and "E3" in f.message for f in errs)
    empty = check_acceptance_observable({})
    assert empty and empty[0].message.startswith("E1")


def test_coverage_v33():
    req = {"lineage": make_lineage("requirement", "req-0001", 1)["lineage"], "status": "approved"}
    req["lineage"].update({"id": "req-0001", "status": "approved"})
    tp = {"lineage": {"kind": "test_point", "id": "tp-0001", "version": 1, "status": "approved",
                      "derived_from": [{"id": "req-0001", "version": 1}]}, "status": "approved"}
    # 用例缺失 → 应有 warn 缺口
    r = coverage_gaps([req], [tp], [], enforce=True)
    assert r["rule"] == "V-33" and not r["ok"] is None
    assert any(g["level"] == "warn" for g in r["gaps"])
    case = {"lineage": {"kind": "case", "id": "case-0001", "version": 1, "status": "approved",
                        "derived_from": [{"id": "tp-0001", "version": 1}]}, "status": "approved"}
    r2 = coverage_gaps([req], [tp], [case])
    assert r2["ok"] and r2["stats"]["case_coverage_ratio"] == 1.0


def test_gates_and_touched():
    plan = {"lineage": {"id": "plan-0001", "version": 1},
            "steps": [
                {"action": "navigate", "target": "/login",
                 "locators": [{"type": "css", "value": "#user"}],
                 "input": "${data.username}",
                 "assert": [{"matcher": "equals", "expected": "200", "source": "case.assertions[0]"}]},
                {"request": "POST /api/login", "driver": "api",
                 "assert": [{"matcher": "equals", "expected": "0"}]},
            ]}
    touched = extract_touched(plan)
    assert touched["pages"] == ["/login"] and touched["apis"] == ["POST /api/login"]
    gates = compile_gates(plan, case=None)
    names = [g.name for g in gates]
    assert names == ["locator_unique", "assertion_decidable", "data_no_hardcode", "traceable", "replay_verified"]
    assert gates_summary(gates)["verdict"] in ("fail", "pending")
    # float 断言应被闸2拦下
    bad = {"steps": [{"assert": [{"matcher": "equals", "expected": 0.1}]}]}
    g2 = [g for g in compile_gates(bad, case=None) if g.name == "assertion_decidable"][0]
    assert not g2.passed and "float" in g2.violations[0]


def test_api_engine_live():
    """用本地 http.server 起最小 echo 服务验证 DSL→HTTP→exec。"""
    from http.server import BaseHTTPRequestHandler, HTTPServer
    import threading, json as j

    class H(BaseHTTPRequestHandler):
        def do_POST(self):
            body = j.loads(self.rfile.read(int(self.headers["Content-Length"]) or 0))
            resp = {"code": 0 if body.get("u") == "admin" else 401, "token": "T123"}
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(j.dumps(resp).encode())

        def log_message(self, *a):
            pass

    srv = HTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    port = srv.server_address[1]

    plan = {"lineage": {"id": "plan-0042", "version": 1}, "driver": "api",
            "data": {"username": "admin"},
            "steps": [{"request": "POST /login", "payload": {"u": "${data.username}"},
                       "assert": [{"type": "status_code", "matcher": "equals", "expected": "200", "decide": True},
                                  {"type": "json_path", "path": "$.code", "matcher": "equals", "expected": "0",
                                   "decide": True, "source": "case.assertions[0]"}]}]}
    ex = run_plan(plan, f"http://127.0.0.1:{port}", data={"username": "admin"})
    assert ex["verdict"] == "pass", ex
    assert ex["steps"][0]["assertions"][1]["actual"] == 0

    # 错误路径：错口令 → decide 失败 → verdict=fail
    ex2 = run_plan(plan, f"http://127.0.0.1:{port}", data={"username": "hacker"})
    assert ex2["verdict"] == "fail"
    srv.shutdown()


def test_regression_flaky():
    cases = [
        {"id": "case-0001", "risk": "S1", "tags": ["smoke"], "execs": [{"started_at": "2026-11-14T10:00:00Z", "duration_ms": 20000}]},
        {"id": "case-0002", "risk": "S2", "tags": [], "execs": []},
        {"id": "case-0003", "risk": "S3", "quarantine": True, "execs": []},
    ]
    sel = select_regression(cases, tier="smoke")
    assert sel["selected"] == ["case-0001"] and "case-0003" not in sel["selected"]
    assert verdict_of_samples(["pass", "pass", "fail"]) == "flaky"
    assert verdict_of_samples(["pass"] * 3) == "pass"
    q = quarantine_check([{"id": "case-0003", "quarantine": True}])
    assert not q["ok"]  # 缺 reason/review_after


def test_report_and_risk_ledger():
    execs = [{"plan": {"id": "plan-0042"}, "verdict": "pass", "steps": [{"duration_ms": 1500}]},
             {"plan": {"id": "plan-0042"}, "verdict": "fail", "steps": [{"duration_ms": 1800}]}]
    facts = extract_facts(execs)
    assert facts["runs"] == 2 and facts["pass_rate"] == 0.5 and facts["flaky_plans"] == ["plan-0042"]
    assert "无数据" not in facts and facts["runs"] > 0
    empty = extract_facts([])
    assert empty["runs"] == 0 and "允许空输出" in empty["note"]
    led = RiskLedger()
    r = led.add("登录步骤 flaky", refs=["exec-8820"])
    led.transition(r["id"], "tracking", actor="pm")
    try:
        led.transition(r["id"], "new", actor="x")
        assert False, "非法流转应被拒绝"
    except ValueError:
        pass
    try:
        led.add("无引用洞察", refs=[])
        assert False, "无引用风险应被拒绝"
    except ValueError:
        pass
    assert "引用" in REVIEWER_PROMPT


def test_capability_negotiate():
    server = [{"name": "policy-m2", "schema_version": "2.0.0", "compatible_engine": ">=2.0",
               "rules_meta": {"V-33": {}}},
              {"name": "policy-m1", "schema_version": "1.1.0", "compatible_engine": ">=1.0,<2.0",
               "rules_meta": {"V-33": {"enforce": False}}}]
    r = negotiate("1.0.0", server, builtin=PolicySnapshot({"V-33": {}}, "1.0.0", "builtin"))
    assert r["status"] == "ok" and r["snapshot"].schema_version == "1.1.0"
    r2 = negotiate("1.0.0", [], builtin=PolicySnapshot({}, "1.0.0", "builtin"))
    assert r2["status"] == "degraded" and r2["snapshot"].source == "builtin"


# ---------- 10.2 需求阶段 Parser 三件套 + 可测性 ----------

def test_parsers_102():
    import tempfile, os, json
    # md 解析：章节树 + 条款带行号
    md = tempfile.NamedTemporaryFile("w", suffix=".md", delete=False, encoding="utf-8")
    md.write("# 登录需求\n## 规则\n- 用户名最少 6 字符\n- 密码错误提示锁定\n## 验收\n- 提交后显示首页\n")
    md.close()
    doc = parse_markdown(md.name)
    assert doc["clause_count"] == 3 and doc["clauses"][0]["location"]["line"] == 3
    assert doc["sections"][0]["title"] == "登录需求"
    os.unlink(md.name)
    # OpenAPI 解析：接口清单 IR + module 标签
    spec = {"openapi": "3.0.0", "paths": {
        "/auth/login": {"post": {"summary": "登录", "requestBody": {"content": {
            "application/json": {"schema": {"required": ["username"]}}}},
            "responses": {"200": {}, "401": {}}}},
        "/users/me": {"get": {"responses": {"200": {}}}}}}
    sp = tempfile.NamedTemporaryFile("w", suffix=".yaml", delete=False, encoding="utf-8")
    import yaml
    yaml.safe_dump(spec, sp, allow_unicode=True)
    sp.close()
    api = parse_openapi(sp.name)
    assert api["api_count"] == 2 and api["apis"][0]["module"] == "auth"
    assert "username" in api["apis"][0]["request_required"]
    os.unlink(sp.name)
    # Figma 解析：只取类型与文案
    fig = {"document": {"children": [{"name": "登录页", "children": [
        {"type": "TEXT", "characters": "欢迎登录"},
        {"type": "BUTTON", "name": "提交", "children": [{"type": "TEXT", "characters": "登 录"}]}]}]}}
    proto = parse_prototype(fig)
    assert proto["pages"] == ["登录页"] and proto["control_count"] == 2
    # 需求项无位置 → 必须丢弃
    assert check_location({"title": "x"})["accepted"] is False
    assert check_location({"title": "x", "location": {"file": "a.md", "line": 3}})["accepted"]


def test_testability_102():
    bad = {"id": "req-0001", "title": "系统应尽快响应", "description": "适当处理异常"}
    probs = check_testability(bad)
    rules = {p["rule"] for p in probs}
    assert "T1" in rules and "T4" in rules        # 无预期 + 歧义
    ok = {"id": "req-0002", "title": "登录", "description": "用户名最多 32 字符",
          "expected": "提交后跳转首页", "preconditions": "已注册账号"}
    assert check_testability(ok) == [] or all(p["level"] != "error" for p in check_testability(ok))


# ---------- 10.3 矩阵三件套 + 验证方式分配 ----------

def test_matrix_103():
    assert "边界" in search_checklist("input")
    matrix = build_matrix([
        {"id": "req-0001", "control_types": ["input", "button"]},
        {"id": "req-0002", "control_types": ["api"]}])
    assert matrix["total"] == 5 + 3 + 6  # input=4, button=4, api=6 → 实际 14
    tps = [{"id": "tp-0001", "req_id": "req-0001", "control_type": "input",
            "dimension": "边界", "verify_mode": "api"},
           {"id": "tp-0002", "req_id": "req-0001", "control_type": "input",
            "dimension": "功能", "verify_mode": "ui"}]
    gaps = matrix_gaps(matrix, tps)
    assert gaps["covered"] == 2 and gaps["gap_count"] == matrix["total"] - 2
    modes = {r["id"]: r["verify_mode"] for r in assign_verify_mode([
        {"id": "tp-x1", "dimension": "权限"}, {"id": "tp-x2", "dimension": "数据"},
        {"id": "tp-x3", "dimension": "功能"}])}
    assert modes["tp-x1"] == "api" and modes["tp-x2"] == "db" and modes["tp-x3"] == "ui"


# ---------- 10.4 用例阶段四件套 ----------

def test_case_builder_104():
    tp = {"id": "tp-0031", "version": 1, "title": "用户名边界", "dimension": "边界"}
    sk = build_case_skeleton(tp, variant="api")
    assert sk["lineage"]["derived_from"][0]["id"] == "tp-0031"
    assert sk["steps"][0]["assert"][0].get("__FROM_TEST_POINT__") is True
    # 数据工厂：边界组齐 + 数值字符串十进制 + 确定性
    ds = DataFactory(seed=7).build_dataset([
        {"name": "username", "type": "string", "constraints": {"min": 6, "max": 32, "required": True}},
        {"name": "amount", "type": "decimal", "constraints": {"min": "0.01", "max": "100"}}])
    assert set(ds["rows"].keys()) == set(DataFactory.BOUNDARY_LABELS)
    assert ds["rows"]["min_out"]["amount"].startswith("-0.99")
    ds2 = DataFactory(seed=7).build_dataset([
        {"name": "username", "type": "string", "constraints": {"min": 6, "max": 32, "required": True}},
        {"name": "amount", "type": "decimal", "constraints": {"min": "0.01", "max": "100"}}])
    assert ds["rows"]["normal"] == ds2["rows"]["normal"]
    # 预算校验
    assert check_case_budget(500)["ok"] is False
    assert check_case_budget(50, {"req-0001": 40})["ok"] is False
    assert check_case_budget(50, {"req-0001": 10})["ok"]
    # 枚举对账：双向 diff
    rec = reconcile_enumeration(
        [{"id": "ri-1", "key": "login.sms"}, {"id": "ri-2", "key": "login.pwd"}],
        [{"id": "case-0001", "covered_capabilities": ["login.sms", "login.bad_key"]}])
    assert [m["capability"] for m in rec["missing_in_cases"]] == ["login.pwd"]
    assert rec["unknown_in_cases"][0]["key"] == "login.bad_key"
    assert rec["ok"] is False


# ---------- 10.5 缺陷阶段四件套 ----------

def test_defect_tools_105():
    exec_ir = {"id": "exec-9001", "plan": {"id": "plan-0042"}, "env": {"key": "test-env"},
               "verdict": "fail", "steps": [
        {"index": 0, "action": "POST /api/login", "status": "fail", "request": {"u": "admin"},
         "assertions": [{"matcher": "equals", "expected": "0", "actual": "500",
                         "decide": True, "passed": False}]}]}
    pack = build_evidence_pack(exec_ir)
    assert pack["failed_steps"][0]["assertions"][0]["actual"] == "500"
    assert pack["failed_steps"][0]["request_excerpt"]["u"] == "admin"  # 入参只入 evidence
    fp1 = defect_fingerprint(pack["failed_steps"][0], "test-env")
    fp2 = defect_fingerprint(pack["failed_steps"][0], "test-env")
    assert fp1 == fp2
    dd = dedup_defects([pack, pack], existing=[{"id": "defect-0007", "fingerprint": fp1}])
    assert dd["merged_count"] == 1 and dd["groups"][0]["linked_defects"] == ["defect-0007"]
    ticket = render_defect_ticket(dd["groups"][0],
                                  {"title": "登录接口 500", "case_id": "case-0031",
                                   "plan_id": "plan-0042", "env": "test-env",
                                   "severity": "S2", "category": "product_bug",
                                   "evidence_pack": pack})
    assert "S2" in ticket and "登录接口" in ticket
    jira = render_defect_ticket(dd["groups"][0],
                                {"title": "t", "case_id": "c", "plan_id": "p",
                                 "env": "e", "severity": "S2",
                                 "evidence_pack": pack}, template="jira")
    assert jira["priority"] == "S2" and "product_bug" not in jira["labels"]  # 未传 category 时标签用默认值
    assert jira["description"].startswith("用例 c")
    # 偶发 bug：verdict 不稳定 + actual 多样 → 上报
    hist = [{"case_id": "case-0031", "env": "test-env", "verdict": "pass"},
            {"case_id": "case-0031", "env": "test-env", "verdict": "fail", "actual": "500"},
            {"case_id": "case-0031", "env": "test-env", "verdict": "fail", "actual": "502"}]
    sus = identify_heisenbug(hist)
    assert len(sus) == 1 and sus[0]["suspect"] == "heisenbug" and len(sus[0]["actual_variants"]) == 2


# ---------- §11.3 等待条件库 / 断言引擎 / 自愈分级 / 凭证中心 ----------

def test_wait_assert_113():
    # 封闭枚举严格对齐 §12.2（8 种，不含 toast_dismissed/duration 等自造类型）
    assert set(WAIT_TYPES) == {"element_visible", "element_enabled", "element_stable",
                              "network_idle", "request_done", "text_changed",
                              "url_matches", "attribute_equals"}
    # 自造类型/driver 专有写法 → 拒
    errs = check_wait_step({"wait": [{"type": "playwright_wait", "timeout_ms": 1000}]})
    assert errs and "封闭枚举" in errs[0]
    # sleep 语义（duration）同样不在枚举 → 拒（V-18）
    assert check_wait_step({"wait": [{"type": "duration", "timeout_ms": 2000}]})
    # 缺必需参数 → 拒
    assert any("缺必需参数" in e for e in check_wait_step({"wait": [{"type": "request_done"}]}))
    assert any("METHOD /path" in e for e in check_wait_step(
        {"wait": [{"type": "request_done", "pattern": "/api/orders"}]}))
    assert check_wait_step({"wait": [{"type": "element_visible", "target": {"testid": "x"},
                                      "timeout_ms": 5000}]}) == []
    # 断言分级：程序判定 + 人工覆写（§12.4）
    assert assertion_level({"action": "click"}, "正常流程") == "observe"     # 支撑性步骤
    assert assertion_level({"action": "verify_total"}, "数据校验") == "decide"  # 强制关键
    assert assertion_level({"action": "click"}, "正常流程", manual_override=True) == "decide"
    # 断言引擎判定
    eng = AssertionEngine()
    r1 = eng.evaluate("0", {"matcher": "equals", "expected": "0", "level": "decide"})
    assert r1["passed"]
    r2 = eng.evaluate("500", {"matcher": "equals", "expected": "0", "level": "observe"})
    assert eng.verdict_for([r2]) == "pass"          # observe 失败不判死
    assert eng.verdict_for([{**r2, "level": "decide"}]) == "fail"
    # 语义断言必须标注由模型判定（可审计）
    r3 = eng.evaluate("ok", {"matcher": "equals", "expected": "ok",
                             "assert_type": "semantic", "level": "decide"})
    assert r3["judged_by"] == "model"


def test_locator_resolver_123():
    """§12.3 三条硬规则：优先级、多命中拒绝、降级必须记录。"""
    from aitestharness_tools.exec.wait_assert import LocatorResolver
    lr = LocatorResolver()
    ok = lr.resolve([1, 1])               # 首选唯一 → 命中即停，不降级
    assert ok["status"] == "ok" and ok["locator_hit"] == 1 and not ok["degraded"]
    deg = lr.resolve([0, 1])              # 次选命中 → 降级必须记录
    assert deg["status"] == "ok" and deg["locator_hit"] == 2 and deg["degraded"]
    amb = lr.resolve([3, 1])              # 多命中 → 拒绝执行，不允许取第一个
    assert amb["status"] == "locator_ambiguous" and "拒绝执行" in amb["detail"]
    miss = lr.resolve([0, 0])
    assert miss["status"] == "locator_not_found"


def test_heal_credentials_113():
    # 自愈分级严格对齐 §12.8：L1 换指纹 / L2 延长等待（限一次）/ L3 步骤自愈禁止
    r1 = classify_for_heal({"assertions": [{"level": "decide", "passed": False}]})
    assert r1["level"] == "L3" and r1["allowed"] is False and "红线" in r1["reason"]
    r2 = classify_for_heal({"error": "NoSuchElement: #btn", "assertions": []})
    assert r2["level"] == "L1" and r2["action"] == "refind_locator" and r2["allowed"]
    r3 = classify_for_heal({"error": "wait_timeout"})
    assert r3["level"] == "L2" and r3["action"] == "extend_wait"
    # L2 限一次：已用过一次后再遇超时 → L3 人工
    r4 = classify_for_heal({"error": "wait_timeout"}, heal_history={"L2": 1})
    assert r4["level"] == "L3" and "限一次" in r4["reason"]
    assert set(HEAL_LEVELS) == {"L1", "L2", "L3"}
    # 凭证中心：环境切换 + token 刷新
    cc = CredentialCenter()
    cc.register_env("test", {"default": "https://api.test.local", "pay": "https://pay.test.local"})
    assert cc.resolve_base_url("test", "pay") == "https://pay.test.local"
    calls = []
    cc.set_token_refresher("login", lambda: (calls.append(1) or "TOK-1", 60))
    assert cc.get_token("login") == "TOK-1" and cc.get_token("login") == "TOK-1"
    assert len(calls) == 1                       # 缓存生效，只刷一次
    cc.invalidate_token("login")
    assert cc.get_token("login") == "TOK-1" and len(calls) == 2


# ---------- §11.4 接口/Web/App/小程序 专有 ----------

def test_api_ext_114():
    v = ResponseContractValidator()
    schema = {"type": "object", "required": ["code", "data"],
              "properties": {"code": {"type": "integer"},
                             "data": {"type": "object", "required": ["token"],
                                      "properties": {"token": {"type": "string"}}}}}
    assert v.validate({"code": 0, "data": {"token": "T"}}, schema) == []
    errs = v.validate({"code": "0", "data": {}}, schema)
    assert any("integer" in e for e in errs) and any("token" in e for e in errs)
    # 异步轮询
    state = {"n": 0}
    pr = AsyncPoller(interval_s=0.01, max_attempts=5).poll(
        lambda: (state.update(n=state["n"] + 1) or state["n"] >= 3, {"progress": state["n"]}))
    assert pr["status"] == "done" and pr["attempts"] == 3
    to = AsyncPoller(interval_s=0.01, max_attempts=3).poll(lambda: (False, {}))
    assert to["status"] == "timeout" and to["attempts"] == 3
    # 变量提取
    assert extract_variable({"a": {"b": "v"}}, "$.a.b")["value"] == "v"
    assert extract_variable({}, "$.x.y")["ok"] is False
    # db 断言（sqlite 原型）
    import tempfile, os
    db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
    db.close(); os.unlink(db.name)
    da = DatabaseAsserter(f"sqlite://{db.name}")
    da.conn.execute("CREATE tABLE t(id int, name text)")
    da.conn.execute("INSERT INTO t VALUES (1, 'alice')")
    da.conn.commit()
    q = da.query("SELECT * FROM t WHERE id = :id", {"id": 1})
    assert q["rows"] == [{"id": 1, "name": "alice"}]


def test_native_mini_114():
    lr = LocResolver()
    w = lr.plan_order({"kind": "web", "locators": [{"xpath": "//div"}, {"css": "#a"}]})
    assert w["ok"] and w["fallback_order"][0] == "css" and len(w["fallback_order"]) == 2
    bad = lr.plan_order({"kind": "web", "locators": [{"playwright": "x"}]})
    assert not bad["ok"]
    n = lr.plan_order({"kind": "native", "strategy": "accessibility_id", "value": "btn_login"})
    assert n["ok"] and n["primary"] == "accessibility_id"
    # 单设备串行
    dq = DeviceQueue()
    assert dq.acquire("dev-001")["acquired"]
    assert not dq.acquire("dev-001", timeout_s=0.1)["acquired"]
    dq.release("dev-001")
    assert dq.acquire("dev-001")["acquired"]
    # 弹窗策略链：命中 accept；未命中默认 abort
    chain = PopupPolicyChain([{"match": ["允许", "始终允许"], "handle": "accept"},
                              {"match": ["取消"], "handle": "dismiss"}])
    r = chain.resolve(["是否允许访问相机？"])
    assert r["hit"] and r["handle"] == "accept"      # '允许' 是弹窗文本子串 → 命中
    r2 = chain.resolve(["系统更新提示"])
    assert not r2["hit"] and r2["handle"] == "abort"  # 未命中任何策略 → 默认 abort 防误授权
    try:
        PopupPolicyChain([{"match": ["x"], "handle": "hack"}])
        assert False
    except ValueError:
        pass


# ---------- §11.5 / §11.6 / §11.7 ----------

def test_hybrid_115():
    # 合规混合用例：api 起头 → web 收尾，context_flow 显式
    good = {"main_driver": "api", "context_flow": [
                {"from": "s1.output.token", "to": "${ctx.token}"},
                {"from": "${ctx.token}", "to": "s2.headers.Authorization"}],
            "steps": [
                {"driver": "api", "request": "POST /login"},
                {"driver": "web", "action": "goto", "params": {"t": "${ctx.token}"}}]}
    r = check_hybrid_plan(good)
    assert r["ok"] and r["segments"] == ["api", "web"]
    # 违例1：无主 driver
    r1 = check_hybrid_plan({"steps": [{"driver": "api"}, {"driver": "web"}]})
    assert any(p["constraint"] == "C1-main-driver" for p in r1["problems"])
    # 违例2：切回（三段）
    r2 = check_hybrid_plan({"main_driver": "api", "steps": [
        {"driver": "api"}, {"driver": "web"}, {"driver": "api"}]})
    assert any(p["constraint"] == "C2-max-2-segments" for p in r2["problems"])
    # 违例3：混合但无 context_flow
    r3 = check_hybrid_plan({"main_driver": "api", "steps": [
        {"driver": "api"}, {"driver": "web"}]})
    assert any(p["constraint"] == "C3-context-flow" for p in r3["problems"])
    # 违例4：引用未声明的 ctx 变量
    r4 = check_hybrid_plan({"main_driver": "api",
                            "context_flow": [{"from": "s1.x", "to": "${ctx.a}"}],
                            "steps": [{"driver": "api", "params": {"k": "${ctx.ghost}"}}]})
    assert any("ghost" in p["message"] for p in r4["problems"])
    # 约束4：最弱一环
    w = weakest_link_verdict([{"driver": "api", "verdict": "pass"},
                              {"driver": "web", "verdict": "fail"}])
    assert w["verdict"] == "fail" and w["failed_driver"] == "web"


def test_allocation_audit_116():
    tps = [{"id": f"tp-{i:04d}", "type": "权限", "verify_mode": "ui"} for i in range(4)] + \
          [{"id": f"tp-{i:04d}", "type": "界面呈现", "verify_mode": "ui"} for i in range(4, 10)]
    r = allocation_audit(tps, threshold=0.30)
    assert r["misplaced_count"] == 4 and r["ratio"] > 0.30 and not r["ok"]
    # 切片前 6 条：2 个权限被分到 UI → 2/6=0.333 超阈值
    assert not allocation_audit(tps[:6], threshold=0.30)["ok"]
    ok_case = [{"id": "tp-1", "type": "业务逻辑", "verify_mode": "api"}]
    assert allocation_audit(ok_case)["ok"]


# ---------- §12.5 取证包七分区 / §12.7 接管重对齐 / §12.10 单步调试 ----------

def test_evidence_125():
    from aitestharness_tools.defect.evidence import build_evidence_pack as bep, EVIDENCE_SECTIONS
    exec_ir = {"id": "exec-9002", "plan": {"id": "plan-0042", "version": 1},
               "env": {"key": "test"}, "steps": [
        {"index": 0, "action": "goto", "status": "pass", "dom_summary": {"a": 1, "b": 2}},
        {"index": 1, "action": "click", "status": "fail",
         "dom_summary": {"a": 1, "b": 3, "c": 4},
         "assertions": [{"level": "decide", "passed": False, "matcher": "equals",
                         "expected": "0", "actual": "500"}],
         "console_errors": ["TypeError"], "network": [{"url": "/api/x", "status": 500}],
         "request": {"u": "admin"}}]}
    pack = bep(exec_ir, baseline={"dom_summary": {"a": 1, "b": 2}})
    assert set(EVIDENCE_SECTIONS) <= set(pack.keys())
    d = pack["dom"]["baseline_diff"]
    assert d["available"] and d["added"] == ["c"] and d["changed"] == ["b"]
    assert pack["console"]["errors"] == ["TypeError"]
    assert pack["failed_assertions"][0]["actual"] == "500"
    assert pack["network"]["request_excerpt"] == {"u": "admin"}   # 入参只入 evidence
    # 无基线时必须明确"无法给出 diff"，不能假装"无差异"
    pack2 = bep(exec_ir)
    assert pack2["dom"]["baseline_diff"]["available"] is False


def test_realign_and_debug_127_1210():
    from aitestharness_tools.defect.evidence import realign_after_takeover
    # 三步对齐：全满足 → ok
    ok = realign_after_takeover({"dom_summary": {"x": 1}, "touched": {"pages": [], "apis": []},
                                 "satisfied": {"logged_in": True}},
                                {"requires": ["logged_in"]})
    assert ok["ok"] and len(ok["steps"]) == 3
    # 前置不满足 → 拒绝硬跑
    bad = realign_after_takeover({"dom_summary": {"x": 1}, "touched": {},
                                  "satisfied": {"logged_in": False}},
                                 {"requires": ["logged_in"]})
    assert not bad["ok"] and "拒绝继续执行" in bad["blocked_reason"]
    # 单步调试：断点暂停 / 单步 / 继续
    from aitestharness_tools.exec.debug import DebugController
    dc = DebugController(mode="run", breakpoints=[1])
    assert dc.before_step(0, {}) == "proceed"
    assert dc.before_step(1, {}) == "pause" and dc.inspect()["paused_at"] == 1
    assert dc.step_over() == "proceed"
    assert dc.cont() == "proceed"
    # 接管会话 + 交回必须做三步对齐
    sess = dc.take_over("验证码需要人工", mode="correction")
    sess.human_action({"action": "fill", "field": "captcha"})
    hb = sess.hand_back({"dom_summary": {"x": 1}, "touched": {},
                          "satisfied": {"ready": True}}, {"requires": ["ready"]})
    assert hb["ok"] and hb["takeover"]["compilable_fragment"] is True


# ---------- §12.6 登录器与验证码策略链 ----------

def test_login_126():
    from aitestharness_tools.exec.login import (detect_login_form, detect_captcha_type,
                                                 LoginStrategyChain, SessionCache,
                                                 LOGIN_STANDARD_FLOW, CAPTCHA_TYPES)
    # 步 1 探测：零 LLM 规则命中密码框 + 相邻用户名框
    f = detect_login_form({"inputs": [{"name": "user", "type": "text"},
                                      {"name": "pwd", "type": "password"}]})
    assert f["is_login"] and f["username_field"] == "user" and f["password_field"] == "pwd"
    # iframe/canvas 降级视觉
    assert detect_login_form({"inputs": [], "iframes": 1})["is_login"] is None
    # 验证码分类
    assert detect_captcha_type({"html": "滑块验证"}) == "slider"
    assert detect_captcha_type({"html": "图形 captcha image"}) == "image"
    assert detect_captcha_type({"html": "普通表单"}) == "none"
    assert detect_captcha_type({"html": "captcha ???"}) in CAPTCHA_TYPES
    # 策略链：首个失败 → 第二个成功；失败次数受"最多重试 1 次"约束
    chain = LoginStrategyChain()
    tried = []
    def ocr_ok(ctx): tried.append("ocr"); return True
    def bypass_fail(ctx): tried.append("bypass"); return False
    res = chain.run("projA", "image", {"test_bypass_code": bypass_fail, "ocr": ocr_ok}, {})
    assert res["status"] == "ok" and res["used"] == "ocr" and "manual" not in tried
    # 全部失败 → manual_required（且自动策略尝试不超过首次+1 次重试）
    chain2 = LoginStrategyChain()
    n = {"c": 0}
    def always_fail(ctx):
        n["c"] += 1
        return False
    res2 = chain2.run("projA", "image",
                      {"test_bypass_code": always_fail, "ocr": always_fail,
                       "captcha_service": always_fail}, {})
    assert res2["status"] == "manual_required" and n["c"] <= 2   # 红线 2：≤1 次重试（防锁号）
    # 会话固化（红线 4：会话复用是终极解法）
    sc = SessionCache()
    sc.save("projA", {"storage": {"cookie": "x"}, "form_signature": "sig",
                      "submit_path": "/api/login"})
    assert sc.inject("projA")["form_signature"] == "sig"
    try:
        sc.save("projB", {"storage": {}})
        assert False
    except ValueError:
        pass
    assert len(LOGIN_STANDARD_FLOW) == 5


# ---------- §13.2 选集五源 / §13.3 冒烟约束 / §13.4 准入结论 ----------

def test_selection_132():
    from aitestharness_tools.regression.impact import select_by_change
    cases = [
        {"id": "case-0001", "derived_from_requirements": ["req-0044"], "modules": [],
         "fragments": []},
        {"id": "case-0002", "derived_from_requirements": [], "modules": ["order-service"],
         "fragments": [{"id": "frag-login", "version": 1}]},
        {"id": "case-0003", "derived_from_requirements": [], "modules": [], "fragments": []},
        {"id": "case-0004", "modules": ["x"]},
    ]
    r = select_by_change(explicit_ids=["case-0003"], changed_requirements=["req-0044"],
                         changed_modules=["order-service"],
                         changed_fragments=["frag-login@1"],
                         similar_cases=["case-0004"], cases=cases,
                         quarantine_ids={"case-0004"})
    # 每条选中必须给理由（可解释性，§13.2 关键原则）
    assert r["explainable"] and r["reasons"]["case-0001"][0]["source"] == "requirement_change"
    assert r["reasons"]["case-0002"][0]["source"] == "code_change"
    assert any(x["source"] == "dependency" for x in r["reasons"]["case-0002"])
    assert "case-0004" not in r["selected"]        # quarantine 排除
    assert r["reasons"]["case-0003"][0]["reliability"] == 0   # 显式指定最可靠


def test_smoke_constraints_133_and_metrics_134():
    # 冒烟集：flaky 率必须 0 + 语义断言禁入
    cases = [
        {"id": "case-0001", "risk": "S1", "execs": [
            {"started_at": "2026-11-14T10:00:00Z", "verdict": "pass", "duration_ms": 5000}]},
        {"id": "case-0002", "risk": "S1", "execs": [
            {"started_at": "2026-11-14T10:00:00Z", "verdict": "pass", "duration_ms": 5000},
            {"started_at": "2026-11-14T11:00:00Z", "verdict": "fail", "duration_ms": 5000}]},
        {"id": "case-0003", "risk": "S1",
         "assertions": [{"assert_type": "semantic"}],
         "execs": [{"started_at": "2026-11-14T10:00:00Z", "verdict": "pass", "duration_ms": 5000}]},
    ]
    sel = select_regression(cases, tier="smoke")
    assert sel["selected"] == ["case-0001"]
    reasons = {e["id"]: e["reason"] for e in sel["excluded"]}
    assert "smoke-flaky" in reasons["case-0002"]
    assert "semantic-assertion" in reasons["case-0003"]
    # 准入结论：资产健康度低 → 不给结论（最重要的一条）
    from aitestharness_tools.regression.selector import admission_conclusion
    assert admission_conclusion(0.95, 0.9, 0.5)["verdict"] == "no_conclusion"
    assert admission_conclusion(0.5, 0.9, 0.9)["verdict"] == "not_ready"
    assert admission_conclusion(0.95, 0.5, 0.9)["verdict"] == "conditional"
    assert admission_conclusion(0.95, 0.9, 0.9)["verdict"] == "ready"


def test_flaky_metrics_143_145():
    from aitestharness_tools.regression.selector import (first_run_pass_rate,
                                                          suspicious_signals)
    # §14.1：inconclusive 不参与 flaky 判定（环境问题不算脚本不稳）
    assert verdict_of_samples(["pass", "inconclusive"]) == "inconclusive"
    assert verdict_of_samples(["pass", "fail"]) == "flaky"
    assert verdict_of_samples(["fail", "inconclusive"]) == "inconclusive"
    # §14.5 首次执行通过率（禁用含重试的最终通过率）
    rep = first_run_pass_rate([
        {"case_id": "c1", "driver": "api", "attempts": ["pass"]},
        {"case_id": "c2", "driver": "web", "attempts": ["fail", "pass"]},   # 重试才过 → 不算首次通过
    ])
    assert rep["first_run_pass_rate"] == 0.5
    assert rep["by_driver"]["api"]["first_run_pass_rate"] == 1.0
    assert "禁用" in rep["note"]
    # §14.3 可疑信号：降级定位/长等待/通过但带噪声
    sig = suspicious_signals({"steps": [
        {"index": 1, "status": "pass", "locator_hit": 2},
        {"index": 2, "status": "pass", "wait_ms": 5000},
        {"index": 3, "status": "pass", "console_errors": ["warn"]}]})
    kinds = {s["signal"] for s in sig}
    assert {"degraded_locator", "long_wait", "passed_with_noise"} <= kinds


# ---------- §15 探索器 ----------

def test_explorer_15():
    from aitestharness_tools.explore.explorer import (BudgetGuard, extract_routes,
                                                       detect_stack, extract_controls,
                                                       action_policy, ExplorationReport,
                                                       controls_to_test_points, DEFAULT_BUDGET)
    # ① 环境建档：JS bundle 路由表解析（零 LLM，最高价值）
    js = 'routes:[{path:"/login",component:()=>import("./Login.vue")},{path:"/orders/:id"}];' \
         'const r=<Link to="/users/list"/>'
    rt = extract_routes(js)
    assert "/login" in rt["routes"] and "/orders/:id" in rt["routes"]
    assert rt["source"] == "js_bundle"
    assert detect_stack('<div id="app">vue createApp')["spa"] is True
    # ② 结构巡检：规则提取控件 + 指纹
    ctrl = extract_controls({"interactive": [
        {"tag": "input", "type": "text", "name": "user", "id": "u1", "testid": "login-username"},
        {"tag": "button", "text": "登录"}]})
    assert ctrl["control_count"] == 2
    assert ctrl["controls"][0]["fingerprints"]["testid"] == "login-username"
    assert ctrl["controls"][0]["fingerprints"]["css"] == "#u1"
    # ③ 硬预算：超限直接拒
    bg = BudgetGuard(inspect_pages=2, probe_pages=1, actions_per_page=2)
    assert bg.can_inspect("/a")[0] and bg.can_inspect("/a")[0]
    bg.consume_inspect("/a")
    bg.consume_inspect("/b")
    assert not bg.can_inspect("/c")[0]
    bg.consume_probe("/a"); bg.consume_probe("/a")
    assert not bg.can_probe("/a")[0]                 # 每页动作上限
    assert not bg.can_probe("/b")[0]                 # 试触页数上限
    # 收益递减终止
    bg2 = BudgetGuard()
    for _ in range(5):
        bg2.consume_probe("/x", gained_info=False)
    assert bg2.stop_reason([]) == "no_new_info"
    # 路由全覆盖终止
    bg3 = BudgetGuard()
    bg3.consume_inspect("/a"); bg3.consume_inspect("/b")
    assert bg3.stop_reason(["/a", "/b"]) == "routes_covered"
    # ④ 危险动作白名单：默认只读，提交类需显式开启 + 页面白名单
    assert action_policy("navigate")["allowed"]
    assert not action_policy("submit_payment")["allowed"]
    assert not action_policy("submit_order", mode="readwrite", page="/cart",
                             allow_submit_on=["/checkout"])["allowed"]
    assert action_policy("submit_order", mode="readwrite", page="/checkout",
                         allow_submit_on=["/checkout"])["allowed"]
    # 探索度报告：让"没探索完"可见可解释
    rep = ExplorationReport(total_routes=52)
    rep.inspected = ["/a"] * 1
    rep.probed = {"/a": 3}
    rep.pending_queue = [{"route": "/b"}]
    r = rep.render("budget_exhausted(inspect_pages)")
    assert "1/52" in r["inspected"] and "未探索队列 1 项" in r["statement"]
    # 控件 → 首版测试点（映射确定性，只补缺口）
    tps = controls_to_test_points("/login", ctrl)
    assert all(t["source"] == "exploration" for t in tps) and len(tps) > 0


def test_pools_117():
    ps = PoolScheduler(capacities={"api_pool": 2})
    # 混合用例 → 主 driver 池 + 辅助资源记账
    plan = {"main_driver": "api", "steps": [
        {"driver": "api", "request": "POST /x"},
        {"driver": "web", "action": "goto", "target": {"kind": "web"}}]}
    d = ps.submit(plan)
    assert d["pool"] == "api_pool" and d["aux"] == [{"driver": "web", "pool": "web_pool"}]
    assert ps.lease("api_pool") and ps.lease("api_pool")
    assert not ps.lease("api_pool")            # 容量 2 已满
    ps.release("api_pool")
    # 设备池默认 1（单设备串行）
    assert ps.lease("device_pool") and not ps.lease("device_pool")
    # web 池默认 = CPU 核心数
    import os
    assert ps.caps["web_pool"] == os.cpu_count()


def test_version_stamp_247():
    """§24.7：版本戳入 exec IR + 版本不一致不参与 flaky 判定 + 执行期冻结。"""
    from aitestharness_tools.common.version import (
        CapabilityRegistry, runtime_stamp, stamps_differ, manifest_compat,
        VersionFreezeError, ENGINE_VERSION, SCHEMA_VERSION, default_registry)
    from aitestharness_tools.regression.selector import (judge_samples,
                                                         verdict_of_samples)

    # 1) stamp 形状
    reg = CapabilityRegistry({"kb-control-dimension": "2.3.0"})
    reg.register("popup-policy", "1.1.0", kind="policy")
    st = runtime_stamp(reg)
    assert st["engine_version"] == ENGINE_VERSION and st["schema_version"] == SCHEMA_VERSION
    assert st["capability_versions"] == {"kb-control-dimension": "2.3.0",
                                         "popup-policy": "1.1.0"}
    # 2) 执行期冻结：会话内改能力包必须抛错
    with reg.frozen_scope():
        assert reg.frozen
        try:
            reg.register("sneaky", "9.9.9")
            raise AssertionError("执行期应拒绝变更能力包")
        except VersionFreezeError:
            pass
    assert not reg.frozen and reg.register("ok", "1.0.0") is None   # 会话后可改
    # 3) 非法 kind / 非法版本号早失败
    for bad in (lambda: reg.register("x", "1.0.0", kind="hack"),
                lambda: reg.register("y", "1.0")):
        try:
            bad()
            raise AssertionError("应拒绝非法 kind 或版本号")
        except (ValueError, RuntimeError):
            pass

    # 4) stamps_differ 三态
    a = {"verdict": "pass", "engine_version": "1.0.0", "capability_versions": {"k": "2.3.0"}}
    b = dict(a)
    c = {"verdict": "pass", "engine_version": "1.1.0", "capability_versions": {"k": "2.3.0"}}
    d = {"verdict": "pass", "engine_version": "1.0.0", "capability_versions": {"k": "2.4.0"}}
    n = {"verdict": "pass"}                                     # 老产物无版本戳
    assert stamps_differ([a, b])["consistent"]
    assert not stamps_differ([a, c])["consistent"]
    assert not stamps_differ([a, d])["consistent"]               # 能力包变了也算版本漂移
    no_stamp = stamps_differ([n, n])
    assert no_stamp["consistent"] and no_stamp["available"] is False

    # 5) 版本不一致 → inconclusive(version_changed)，绝不判 flaky
    j = judge_samples([a, c, c])                                 # 有 pass 有版本差
    assert j["verdict"] == "inconclusive" and j["reason"] == "version_changed"
    assert "不计入 flaky" in j["action"] and "1.1.0" in str(j["version_check"]["detail"])
    assert verdict_of_samples(["pass", "pass"], records=[a, c]) == "inconclusive"
    # 5) 版本字段是「执行事实」：agent 提交 exec 时不许自己写版本戳
    #    （否则可伪造"跑的是新版本"，把版本漂移洗成 pass）
    from aitestharness_tools.irval.ownership import strip_forbidden
    dirty = {"verdict": "pass", "engine_version": "9.9.9",
             "capability_versions": {"kb": "9.9.9"}, "steps": []}
    clean, res = strip_forbidden(dirty, "agent:exec_agent")
    assert not res.accepted
    assert "engine_version" not in clean and "capability_versions" not in clean
    blocked = {f.field for f in res.findings}
    assert {"verdict", "engine_version", "capability_versions"} <= blocked
    ok, res2 = strip_forbidden(dirty, "program:exec_engine")
    assert res2.accepted and ok["engine_version"] == "9.9.9"

    # 6) 同版本抖动才叫 flaky；无版本戳照判但标记不可验证
    assert judge_samples([a, {**b, "verdict": "fail"}])["verdict"] == "flaky"
    nv = judge_samples([{"verdict": "pass"}, {"verdict": "fail"}])
    assert nv["verdict"] == "flaky" and nv["version_verified"] is False

    # 7) §24.6 兼容性门：区间不满足 / 缺签名 / 正常
    ok_manifest = {"name": "p", "version": "1.2.0", "requires_engine": ">=1.0,<2.0",
                   "signature": "sig"}
    assert manifest_compat(ok_manifest)["ok"]
    assert not manifest_compat({**ok_manifest, "requires_engine": ">=2.0"})["ok"]
    no_sig = {k: v for k, v in ok_manifest.items() if k != "signature"}
    assert not manifest_compat(no_sig)["ok"]                     # 内网离线包同样强制签名

    # 8) 引擎产出的 exec IR 真的带上了版本戳；执行后注册表解冻
    import json as _json, threading
    from http.server import BaseHTTPRequestHandler, HTTPServer
    from aitestharness_tools.exec.api_engine import run_plan

    class H(BaseHTTPRequestHandler):
        def do_POST(self):
            body = _json.dumps({"code": 0}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *a):
            pass

    srv = HTTPServer(("127.0.0.1", 0), H)
    port = srv.server_address[1]
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    plan = {"lineage": {"id": "plan-0099", "version": 1}, "driver": "api",
            "steps": [{"request": "POST /ping",
                       "assert": [{"type": "json_path", "path": "$.code",
                                   "matcher": "equals", "expected": "0",
                                   "decide": True, "source": "tp-1"}]}]}
    ex = run_plan(plan, f"http://127.0.0.1:{port}", registry=reg)
    srv.shutdown()
    assert ex["verdict"] == "pass"
    assert ex["engine_version"] == ENGINE_VERSION and ex["schema_version"] == SCHEMA_VERSION
    assert ex["capability_versions"]["popup-policy"] == "1.1.0"
    assert not reg.frozen                                         # 会话结束解冻
    assert default_registry() is not None


def test_model_capability_109():
    """§10.9：LLM 能力由用户配置的模型决定 → 任务模式随档位降级，但契约不变。"""
    from aitestharness_tools.common.model_capability import (
        plan_tasks, calibrate, detect_signals, profile_for, TASKS, TIERS,
        TaskPlanError)

    # 1) 四档 × 五任务：任何档位都不允许"LLM 必须可用"这种硬依赖
    for tier in TIERS:
        p = plan_tasks(tier)
        assert set(p["tasks"]) == set(TASKS)
        for t, v in p["tasks"].items():
            assert v["mode"] in ("auto", "assisted", "manual")
            assert v["fallback"], f"{tier}/{t} 缺确定性兜底路径"
    assert plan_tasks("S")["auto_count"] == len(TASKS)      # 强模型全自动
    assert plan_tasks("N")["auto_count"] == 0               # 无模型全退人工/规则
    # 弱模型：步骤补全退到 assisted（只能在候选集里选），需求抽取退 manual
    b = plan_tasks("B")["tasks"]
    assert b["case_step_fill"]["mode"] == "assisted"
    assert b["case_step_fill"]["constraint"] == "strict_candidates"
    assert b["requirement_extract"]["mode"] == "manual"
    # A 档：常规任务全自动，但超长 PRD（>4 万字）的抽取不在 A 档能力内 → 强制分片
    a = plan_tasks("A")
    assert a["tasks"]["requirement_extract"]["mode"] == "auto"
    assert a["split_required"]["requirement_extract"] is True

    # 2) 实测退化：自报强模型但确实不行 → 只降不升
    bad = [{"ok": True, "schema_valid": False} for _ in range(5)] + \
          [{"ok": False, "error": "timeout"} for _ in range(5)]
    sig = detect_signals(bad)
    assert sig["degraded"] and "schema_instability" in sig["reasons"]
    cal = calibrate("S", bad)
    assert cal["declared"] == "S" and cal["effective"] in ("B", "N")
    assert plan_tasks(cal["effective"])["auto_count"] < plan_tasks("S")["auto_count"]
    # 样本全好 → 不升档（仍按声明，因为样本不能证明更强）
    good = [{"ok": True, "schema_valid": True, "citation_ok": True}]
    assert calibrate("A", good)["effective"] == "A"
    assert calibrate("S", good)["effective"] == "S"
    # 无样本/调用全失败 → N
    assert calibrate("S", [])["effective"] == "N"
    assert calibrate("S", [{"ok": False, "error": "401"}])["effective"] in ("B", "N")

    # 3) 画像只影响"谁填字段"，不影响产物形状：五档都需要同一套下游校验
    for tier in TIERS:
        p = plan_tasks(tier)
        assert p["summary"].endswith("（产物契约与校验链不变）")

    # 4) 非法档位按 N 处理（不抛错，避免配置错就打不开）
    assert plan_tasks("ZZZ")["tier"] == "ZZZ"
    assert plan_tasks("ZZZ")["auto_count"] == 0
    assert profile_for(None) == profile_for("N")


def test_knowledge_maps_1010():
    """§10.10 项目知识层 + 环境事实资产：md 资料库 → 结构化知识；探测 → maps 资产。"""
    from aitestharness_tools.knowledge.extract import (
        split_clauses, normalize_item, dedupe_items, build_knowledge,
        check_gaps, find_references, KNOWLEDGE_TYPES)
    from aitestharness_tools.knowledge.maps import (
        build_maps, diff_maps, scope_coverage, maps_staleness, affected_cases)

    md = """# 优惠券系统
## 业务规则
退款金额不得超过原订单实付金额。
- 优惠券不可叠加使用
## 术语
| 术语 | 定义 |
| --- | --- |
| 分摊 | 多券时按比例摊到各商品 |
"""
    cl = split_clauses(md, "coupon.md")
    # 段落、列表项、表格数据行都成为条款；表头与分隔线必须被跳过
    assert len(cl) == 3, [c["text"][:20] for c in cl]
    assert all("术语 | 定义" not in c["text"] for c in cl)
    assert cl[0]["section_path"].endswith("业务规则") and cl[0]["location"]["line"] == 3
    assert cl[2].get("cells") == ["分摊", "多券时按比例摊到各商品"]

    # 知识项校验：无原文位置 / 非法类型 一律丢弃（不可定位=不可信）
    assert normalize_item({"type": "rule", "name": "无出处", "statement": "没有位置"}) is None
    assert normalize_item({"type": "bogus", "name": "x", "statement": "类型非法",
                           "source": {"file": "a.md", "line": 1}}) is None
    ok = normalize_item({"type": "rule", "name": "退款上限",
                         "statement": "退款金额不得超过原订单实付金额",
                         "clause_id": "c0001"}, {c["clause_id"]: c for c in cl})
    assert ok and ok["source"] == {"file": "coupon.md", "line": 3}

    # 去重按 type+statement，不按 name（同一规则被起两个名字仍是重复）
    items = [
        {"type": "rule", "name": "不可叠加", "statement": "优惠券不可叠加使用", "clause_id": "c0002"},
        {"type": "rule", "name": "禁止叠加", "statement": "优惠券不可叠加使用", "clause_id": "c0002"},
        {"type": "rule", "name": "无出处", "statement": "没有位置的规则"},
    ]
    k = build_knowledge("proj-coupon", items, cl, version=3)
    assert k["stats"]["items"] == 1 and k["stats"]["duplicates"] == 1
    assert k["stats"]["dropped"] == 1
    assert k["content_hash"] == build_knowledge("proj-coupon", items, cl, version=3)["content_hash"]

    # 知识缺口：默认只认显式标记（引号/书名号）+ 外部词表，不猜中文名词
    gap = check_gaps("用户下单叠加“优惠券”，退款需校验“分摊金额”", k)
    assert "优惠券" in gap["gaps"] and "用户下单" not in gap["gaps"]
    assert check_gaps("纯文本没有任何显式术语标记", k)["gap_count"] == 0
    assert check_gaps("校验分摊", k, glossary=["积分抵扣"])["gaps"] == ["积分抵扣"]

    # 引用反查（变更影响分析入口）
    assert any(r["type"] == "rule" for r in find_references("优惠券不可叠加使用", k))

    # ---- 环境事实资产 ----
    ctrl = {"/login": {"control_count": 2, "controls": [
        {"control_type": "input", "name": "username"},
        {"control_type": "button", "name": "btn-submit"}]}}
    m1 = build_maps("proj-a", "test", ["/login", "/order/list"], ctrl,
                    apis=[{"method": "POST", "path": "/api/login", "module": "auth"}],
                    login={"form_detected": True, "captcha_type": "none",
                           "session_saved": True})
    assert m1["stats"]["pages"] == 2 and m1["stats"]["pages_registered"] == 1
    # 只有路由没有控件 → 未建档（这是"知道有这页"和"知道页面上有什么"的区别）
    assert [p["route"] for p in m1["pages"] if not p["registered"]] == ["/order/list"]
    try:
        build_maps("p", "e", ["/x"], [{"bad": 1}])
        raise AssertionError("controls_by_page 类型错应报错")
    except TypeError as exc:
        assert "controls_by_page" in str(exc)

    m2 = build_maps("proj-a", "test", ["/login", "/cart"], ctrl)
    d = diff_maps(m1, m2)
    assert d["pages_added"] == ["/cart"] and d["pages_removed"] == ["/order/list"]
    assert d["apis_removed"] == ["POST /api/login"] and d["breaking"] is True

    cov = scope_coverage({"pages": ["/login", "/cart"], "apis": ["GET /api/x"]}, m1)
    assert not cov["ok"] and cov["missing_pages"] == ["/cart"]
    assert cov["missing_apis"] == ["GET /api/x"] and "未建档" in cov["advice"]

    assert maps_staleness(m1, "2026-12-30T00:00:00Z")["stale"] is True
    assert maps_staleness(m1, "2026-11-15T00:00:00Z")["stale"] is False

    cases = [{"id": "c1", "touched": {"pages": ["/order/list"]}},
             {"id": "c2", "touched": {"pages": ["/login"]}},
             {"id": "c3", "touched": {"apis": ["POST /api/login"]}}]
    af = affected_cases(d, cases)
    assert af["retired"] == ["c1", "c3"]      # 页面/接口已消失 → 退场，不是 fail
    # 无变化的用例不许被误报（否则每次地图变更都全量重跑，回归集失去意义）
    assert "c2" not in af["must_rerun"]
    # /login 控件数变化 → 触及该页的用例必须重跑
    ctrl2 = {"/login": {"control_count": 5, "controls": []}}
    m4 = build_maps("proj-a", "test", ["/login"], ctrl2,
                    apis=[{"method": "POST", "path": "/api/login", "module": "auth"}])
    af2 = affected_cases(diff_maps(m1, m4), cases)
    assert "c2" in af2["must_rerun"] and af2["reason_by_case"]["c2"].startswith("触及变更")


def test_context_assembler_1010():
    """§10.10 上下文装配：按 scope 切片 + 预算裁剪 + 记账（可追溯"基于哪版资料"）。"""
    from aitestharness_tools.knowledge.extract import build_knowledge
    from aitestharness_tools.knowledge.maps import build_maps
    from aitestharness_tools.common.context_assembler import (assemble, est_tokens,
                                                              DEFAULT_BUDGET_TOKENS)

    items = []
    for i in range(20):
        items.append({"type": "rule", "name": f"规则{i}",
                      "statement": f"第{i}条业务规则的判定条件与边界说明",
                      "source": {"file": "a.md", "line": i + 1},
                      "tags": ["order"] if i % 2 else ["stock"]})
    items.append({"type": "term", "name": "分摊", "statement": "多券按比例摊到各商品",
                  "source": {"file": "a.md", "line": 99}, "tags": []})
    k = build_knowledge("proj", items, version=7)
    m = build_maps("proj", "test", ["/login", "/order/list"],
                   {"/login": {"control_count": 1, "controls": [
                        {"control_type": "input", "name": "username"}]}},
                   apis=[{"method": "POST", "path": "/api/login", "module": "auth"}],
                   login={"form_detected": True, "captcha_type": "slide",
                          "session_saved": False})

    # 1) scope 只给 pages：知识项保守全量装载（pages 只能过滤地图，判不了规则归属）
    r = assemble({"pages": ["/login"]}, k, m)
    assert r["context_refs"]["knowledge"]["loaded"] == r["context_refs"]["knowledge"]["total"]
    assert r["context_refs"]["maps"]["pages_loaded"] == 1     # 地图按 pages 精确过滤
    assert len(r["context"]["environment"]) == 3              # 页面 + 接口 + 登录各一条

    # 2) 给 modules：只装相关模块 + 无标签的通用项
    r2 = assemble({"pages": ["/login"], "modules": ["order"]}, k, m)
    loaded = r2["context_refs"]["knowledge"]["loaded"]
    assert 0 < loaded < r["context_refs"]["knowledge"]["loaded"]

    # 3) 预算裁剪：高优先级（rule/constraint）留下，裁掉的必须记账
    r3 = assemble({"modules": ["order"]}, k, m, budget_tokens=200)
    assert r3["dropped"] and r3["tokens_est"] <= 200
    assert all(d["reason"] == "budget_exceeded" for d in r3["dropped"])
    assert r3["context_refs"]["dropped_count"] == len(r3["dropped"])
    kinds = {e["kind"] for e in r3["dropped"]}
    assert kinds <= {"kb:rule", "kb:term", "map:page", "map:api", "map:login", "extra"}

    # 4) 记账：版本 + 内容指纹 + 装载量，写入 plan.lineage 后可回答"基于哪版跑的"
    refs = r2["context_refs"]
    assert refs["knowledge"]["version"] == 7 and refs["knowledge"]["content_hash"]
    assert refs["maps"]["content_hash"] and refs["maps"]["env"] == "test"
    assert refs["scope"]["pages"] == ["/login"] and set(refs) >= {
        "scope", "knowledge", "maps", "dropped_count", "tokens_est", "budget"}

    # 5) scope 覆盖率：未建档的页面在执行前就报出来
    assert r2["coverage"]["ok"] is True
    r4 = assemble({"pages": ["/cart"]}, k, m)
    assert r4["coverage"]["ok"] is False and r4["coverage"]["missing_pages"] == ["/cart"]

    # 6) 同样的输入必须产出同样结果（可复现的前提）
    a, b = assemble({"pages": ["/login"]}, k, m), assemble({"pages": ["/login"]}, k, m)
    assert a["context"] == b["context"] and a["tokens_est"] == b["tokens_est"]
    assert est_tokens("中文四个字") == 5 and est_tokens("") == 0
    assert DEFAULT_BUDGET_TOKENS > 1000


def test_bootstrap_1010():
    """项目建档链路：给地址 → maps IR + 报告（零 LLM）。全部断言针对真实 HTTP 服务。"""
    import json as _json
    import threading
    from http.server import BaseHTTPRequestHandler, HTTPServer

    from aitestharness_tools.onboard.bootstrap import (bootstrap, normalize_route,
                                                       normalize_routes, probe_site, write_bundle)

    # 0) 编码：无 charset 声明时必须先试 UTF-8 再退 GB18030
    #    （requests 对 text/* 默认 ISO-8859-1，直接把中文解得不可读——踩过的坑）
    from aitestharness_tools.onboard.bootstrap import _decode
    assert _decode("删除订单".encode("utf-8"), "text/html") == "删除订单"
    assert _decode("删除订单".encode("gb18030"), "text/html") == "删除订单"
    assert _decode("hi".encode(), "text/html; charset=utf-8") == "hi"
    assert _decode('<meta charset="gbk">删除'.encode("gb18030"), "text/html").endswith("删除")

    # 1) 路由归一化：实例路由必须收敛，否则页面数虚高几十倍
    assert normalize_route("/order/123") == "/order/:id"
    assert normalize_route("/order/8f3a1c2e-1111-2222-3333-444455556666/detail") == "/order/:id/detail"
    assert normalize_route("/order/:id?x=1#h") == "/order/:id"
    assert normalize_route("/order/") == "/order"
    # 业务编号也要收敛（T-2026-0001 / PO20260101），但 v2 这类版本段必须保留
    assert normalize_route("/stock/check/T-2026-0001") == "/stock/check/:id"
    assert normalize_route("/v2/order/list") == "/v2/order/list"
    assert normalize_route("/list") == "/list"
    nr = normalize_routes(["/order/1", "/order/2", "/order/:id", "/user/me"])
    assert nr["count"] == 2 and nr["raw_count"] == 4
    assert "/order/:id" in nr["collapsed"]          # 被合并的实例路由要留痕

    # 2) 编程式跳转必须抓到；拼接前缀不得冒充页面
    from aitestharness_tools.explore.explorer import extract_routes
    js = ("const routes=[{path:'/login'},{path:'/order/:id'}];"
          "router.push('/order/123');navigateTo('/report/daily');"
          "router.push('/order/' + id + '/detail')")
    rt = extract_routes(js)
    assert "/report/daily" in rt["routes"]          # 编程式跳转（旧实现漏抓）
    assert "/order/" in rt["prefixes"]              # 拼接前缀单列
    assert "/order/" not in rt["routes"]

    index = """<html><head><script src="/a.js"></script></head><body>
    <div id="app"></div><form><input type="text" name="u">
    <input type="password" name="p">
    <input type="text" name="verifyCode"><img src="/captcha.jpg" id="cimg">
    </form><button>删除订单</button></body></html>"""
    app_js = ("import {createRouter} from 'vue-router';const routes=[{path:'/login'},"
              "{path:'/order/:id'}];router.push('/order/7')")
    spec = {"openapi": "3.0.1", "paths": {
        "/api/order/list": {"get": {"summary": "列表"}},
        "/api/v1/user/{id}": {"get": {"summary": "用户"}}}}

    class H(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def do_GET(self):
            body, ctype = None, "text/html"
            if self.path == "/":
                body = index.encode()
            elif self.path == "/a.js":
                body, ctype = app_js.encode(), "application/javascript"
            elif self.path == "/openapi.json":
                body, ctype = _json.dumps(spec).encode(), "application/json"
            if body is None:
                self.send_response(404)
                self.end_headers()
                return
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    srv = HTTPServer(("127.0.0.1", 0), H)
    port = srv.server_address[1]
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{port}"

    site = probe_site(base)
    assert site["ok"] and site["stack"]["stack"] == "vue"     # 从路由声明形态识别框架
    assert "/order/:id" in site["routes"]

    r = bootstrap("proj-x", "test", base)
    assert r["ok"] and r["maps"]["type"] == "maps"
    rep = r["report"]
    assert rep["routes"]["count"] == 2 and rep["routes"]["raw_count"] == 3
    # 接口模块必须跳过 api/v1 噪声段，否则模块标签全变成 "api"
    assert rep["apis"]["modules"] == ["order", "user"]
    assert rep["apis"]["count"] == 2 and rep["apis"]["source_url"].endswith("/openapi.json")
    # 登录探测：验证码线索在 <img src> 上，漏判会让登录器不启用策略链
    assert rep["login"]["is_login"] is True and rep["login"]["username_field"] == "u"
    assert rep["login"]["captcha_type"] == "image" and rep["login"]["captcha_imgs"] == 1
    from aitestharness_tools.onboard.bootstrap import probe_login
    assert probe_login('<input type="password" name="p"><img src="/vcode.png">')["captcha_type"] == "image"
    assert probe_login('<input type="password" name="p"><div class="slider"></div>')["captcha_type"] == "slider"
    assert probe_login('<input type="password" name="p"><button>获取验证码</button>')["captcha_type"] == "sms"
    assert probe_login('<input type="password" name="p">')["captcha_type"] == "none"
    # 静态抓取拿不到控件 → 必须如实标未建档，不能假装已建档
    assert rep["pages"]["registered"] == 0 and rep["pages"]["total"] == 2
    assert r["maps"]["stats"]["pages_registered"] == 0
    # 危险文案进告警
    assert any("删除" in w for w in rep["warnings"])
    assert any("只读" in s for s in rep["next_steps"])

    # 3) 落盘：原子写 + 文件可用
    out = tempfile.mkdtemp(prefix="aip-bootstrap-")
    paths = write_bundle(out, r["maps"], rep)
    import yaml
    saved = yaml.safe_load(open(paths["maps"], encoding="utf-8"))
    assert saved["stats"]["pages"] == 2 and saved["env"] == "test"
    md = open(paths["report"], encoding="utf-8").read()
    assert "项目建档报告" in md and "下一步" in md

    # 4) 不可达站点：必须明确失败并给可执行建议，而不是抛异常
    bad = bootstrap("proj-x", "test", "http://127.0.0.1:9/")   # 9 端口必然拒绝
    assert bad["ok"] is False and "首页不可达" in " ".join(bad["report"]["warnings"])
    srv.shutdown()


def test_onboard_runtime_cli():
    """onboard.bootstrap 走 runtime_cli：这是产品建档按钮唯一的执行入口。

    产品侧（服务端环境服务）spawn 的就是 `runtime_cli onboard.bootstrap`，
    所以这里必须验证"给 out 落盘、不给 out 只回结构、失败不落盘"三条契约——
    少任何一条，建档按钮都会要么写不出 maps，要么在失败时留下半份产物。
    """
    import json, threading
    from http.server import BaseHTTPRequestHandler, HTTPServer
    from aitestharness_tools.runtime_cli import invoke

    html = ("<html><body><form><input type='text' name='u'>"
            "<input type='password' name='p'><img src='/captcha.jpg'></form></body></html>")

    class H(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def do_GET(self):
            body = html.encode() if self.path == "/" else b""
            if not body:
                self.send_response(404); self.end_headers(); return
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    srv = HTTPServer(("127.0.0.1", 0), H)
    port = srv.server_address[1]
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{port}"

    # 1) 给 out：落盘 maps + 报告，路径回传
    out = tempfile.mkdtemp(prefix="bootstrap-cli-")
    result = invoke("onboard.bootstrap", {"project": "proj-cli", "env": "uat",
                                          "target_url": base, "out": out})
    assert result["ok"] is True and result["maps"]["env"] == "uat"
    assert os.path.exists(result["paths"]["maps"]) and os.path.exists(result["paths"]["report"])
    assert result["paths"]["maps"].endswith("maps-uat.yaml")

    # 2) 不给 out：只回结构，不写任何文件（run 内调用不留散落产物）
    bare = invoke("onboard.bootstrap", {"project": "proj-cli", "env": "uat", "target_url": base})
    assert bare["ok"] is True and "paths" not in bare

    # 3) 失败不落盘：地址不可达时 ok=False 且没有 paths，不能留半份 maps
    failed = invoke("onboard.bootstrap", {"project": "proj-cli", "env": "uat",
                                          "target_url": "http://127.0.0.1:9/",
                                          "out": tempfile.mkdtemp(prefix="bootstrap-cli-bad-")})
    assert failed["ok"] is False and failed["paths"] is None and failed["maps"] is None
    srv.shutdown()


def test_knowledge_runtime_cli():
    """批次 3 的四个入口走 runtime_cli：条款化 / 版本 diff / 引用反查 / 上下文装配。

    服务端只需要一个"能 spawn 的确定性入口"，不需要理解 Python 侧数据形状；
    这里把四条契约钉死：没有原文位置的知识项必须被丢弃、表述变更不得触发重算、
    引用反查要给出知识项身份、装配被裁掉的项必须出现在 dropped 里。
    """
    from aitestharness_tools.runtime_cli import invoke

    text = "# 退款\n\n## 上限\n\n单笔退款不超过 500 元。\n\n- 已支付订单才可退款\n"
    extracted = invoke("knowledge.extract", {
        "project": "proj-kb", "source": "退款规则.md", "text": text,
        "items": [
            {"type": "rule", "name": "退款上限", "statement": "单笔退款不超过 500 元", "clause_id": "c0001"},
            {"type": "rule", "name": "无位置", "statement": "这条没有原文位置"},   # 必须丢弃
            {"type": "bogus", "name": "x", "statement": "类型不合法"},              # 必须丢弃
        ],
    })
    clauses, knowledge = extracted["clauses"], extracted["knowledge"]
    assert [c["clause_id"] for c in clauses] == ["c0001", "c0002"]
    assert clauses[0]["location"] == {"file": "退款规则.md", "line": 5}
    assert [it["name"] for it in knowledge["items"]] == ["退款上限"]
    assert knowledge["items"][0]["source"] == {"file": "退款规则.md", "line": 5}
    assert knowledge["stats"]["dropped"] == 2, "不可定位的知识项必须计入 dropped，不能静默进库"

    old = {"items": [{"id": "kb-1", "type": "rule", "name": "退款上限",
                      "statement": "单笔退款不超过 500 元", "fingerprint": "fp-a"}]}
    same_semantics = {"items": [{"id": "kb-1", "type": "rule", "name": "退款上限",
                                 "statement": "单笔退款 不超过 500 元", "fingerprint": "fp-a"}]}
    wording = invoke("knowledge.diff", {"old": old, "new": same_semantics})
    assert wording["stats"]["wording_only"] == 1 and wording["triggers_recompute"] is False, \
        "只改了空格/表述就触发重算，增量机制等于没有"

    changed = invoke("knowledge.diff", {"old": old, "new": {"items": [
        {"id": "kb-1", "type": "rule", "name": "退款上限",
         "statement": "单笔退款不超过 200 元", "fingerprint": "fp-b"}]}})
    assert changed["stats"]["semantic_changed"] == 1 and changed["triggers_recompute"] is True
    assert changed["semantic_changed"][0]["change_ratio"] > 0.8

    refs = invoke("knowledge.references", {"text": "验证退款上限这条规则", "knowledge": knowledge})
    assert refs["count"] == 1 and refs["hits"][0]["knowledge_id"] == knowledge["items"][0]["id"]

    # 预算压到装不下两条：必须只装高优先级的 rule，并把裁掉的项记在 dropped 里
    big = {"content_hash": "abc", "_build_meta": {"version": 3}, "items": [
        {"id": "kb-rule-1", "type": "rule", "name": "退款上限", "statement": "单笔退款不超过 500 元",
         "tags": ["退款"], "fingerprint": "f1"},
        {"id": "kb-flow-1", "type": "flow", "name": "退款流转", "statement": "退款审批后 3 个工作日到账，"
         "超时需人工介入并记录到台账，以免客户重复催办", "tags": ["退款"], "fingerprint": "f2"},
    ]}
    packed = invoke("context.assemble", {"scope": {"keywords": ["退款"]}, "knowledge": big,
                                        "budget_tokens": 30})
    assert packed["tokens_est"] <= packed["budget"]
    assert packed["context_refs"]["knowledge"]["version"] == 3
    assert packed["context_refs"]["knowledge"]["total"] == 2
    assert packed["context_refs"]["knowledge"]["loaded"] == 1, packed["context_refs"]
    assert len(packed["dropped"]) == 1 and packed["dropped"][0]["reason"], "被裁掉的项必须给出原因"


def test_knowledge_build_multi_source():
    """多份资料一起条款化：条款 id 必须带来源前缀，知识项的原文位置不能串到别人家。

    这是「原文位置可见」这件事的地基。两份资料各自从 `c0001` 起编时，`s02-c0001` 会
    被解析成第一份资料的第 5 行——页面照样显示"退款规则.md 第 5 行"，看起来有据可查，
    实际指向的是另一份文件。同一输入两次构建的 content_hash 也必须一致，否则
    "同一输入结果可复现"就只是一句话。
    """
    from aitestharness_tools.runtime_cli import invoke

    sources = [
        {"name": "退款规则.md", "text": "# 退款\n\n## 上限\n\n单笔退款不超过 500 元。\n"},
        {"name": "登录规则.md", "text": "# 登录\n\n## 锁定\n\n连续五次失败锁定十五分钟。\n"},
    ]
    items = [
        {"type": "rule", "name": "退款上限", "statement": "单笔退款不超过 500 元", "clause_id": "s01-c0001"},
        {"type": "rule", "name": "锁定时长", "statement": "连续五次失败锁定十五分钟", "clause_id": "s02-c0001"},
        # 同一指纹（type+statement）只留一条，与 name 这个人类标签无关。
        {"type": "rule", "name": "退款上限（旧写法）", "statement": "单笔退款不超过 500 元", "clause_id": "s01-c0001"},
        {"type": "rule", "name": "无位置", "statement": "这条没有原文位置"},   # 必须丢弃
    ]
    built = invoke("knowledge.build", {"project": "proj-kb", "version": 2, "sources": sources, "items": items})
    clauses, knowledge = built["clauses"], built["knowledge"]

    ids = [c["clause_id"] for c in clauses]
    assert ids == ["s01-c0001", "s02-c0001"], ids
    assert len(set(ids)) == len(ids), "条款 id 撞了，知识项会定位到别人的行"
    assert [c["location"] for c in clauses] == [
        {"file": "退款规则.md", "line": 5}, {"file": "登录规则.md", "line": 5},
    ]

    by_name = {it["name"]: it for it in knowledge["items"]}
    assert set(by_name) == {"退款上限", "锁定时长"}, by_name
    assert by_name["锁定时长"]["source"] == {"file": "登录规则.md", "line": 5}, \
        "知识项定位到了错误的资料：原文位置不能当装饰"
    assert by_name["锁定时长"]["section"] == "登录 / 锁定"
    assert knowledge["stats"]["dropped"] == 1, "无位置的知识项必须计入 dropped"
    assert knowledge["stats"]["duplicates"] == 1, "同一条规则写两遍应判重复而不是入库两条"
    assert knowledge["_build_meta"]["version"] == 2

    again = invoke("knowledge.build", {"project": "proj-kb", "version": 2, "sources": sources, "items": items})
    assert again["knowledge"]["content_hash"] == knowledge["content_hash"], "同一输入必须给出同一 content_hash"


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
