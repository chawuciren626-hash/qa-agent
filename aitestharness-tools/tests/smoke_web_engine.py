"""Web 执行引擎验收：定位规则 / 三类失败 / 等待 / 断言 / 跨步骤传值。

这一层的测试要守的是**判错的代价**，而不是"能不能跑通"：

  1. **多命中必须拒绝执行**——取第一个是最省事也最坑的写法，它在真机上表现为
     "偶尔点到旁边的按钮"，事后完全无法复现；
  2. **定位失败不能判产品缺陷**——脚本过期和产品没渲染在拿到基线之前无法区分，
     判 fail 就是把脚本维护成本转嫁成假缺陷；
  3. **observe 断言不影响 verdict**——采集事实与判定结论是两件事，混了就没法
     既"记录一切"又"只对关键点负责"。

前半段用假驱动（无浏览器、毫秒级、可造任意异常页面），后半段用真 Playwright + 本地
靶站跑三条剧本，顺带验证同一份计划连跑两轮结论一致。
"""
import glob
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.dirname(__file__))

import yaml

from aitestharness_tools.exec.authorization import build_approval
from aitestharness_tools.exec.web_engine import WebEngine, validate_plan

WEB_FIXTURES = os.path.join(os.path.dirname(__file__), "fixtures", "web")


# ---------------------------------------------------------------- 假驱动
def element(*keys, visible=True, enabled=True, text=None, value=None, box=None, attrs=None):
    return {"keys": list(keys), "visible": visible, "enabled": enabled,
            "text": text, "value": value, "box": box or {"x": 0, "y": 0, "w": 10, "h": 10},
            "attrs": attrs or {}}


class FakeDriver:
    """内存页面模型。只实现引擎用到的原语，行为与 Playwright 驱动对齐。"""

    def __init__(self, elements, url="http://fake/login", requests=None, inflight=0):
        self.elements = elements
        self._url = url
        self._requests = list(requests or [])
        # 引擎在计划开始时清一次请求记录，所以"计划期间发生的请求"必须由动作产生，
        # 而不是构造时塞进去——否则测的就不是 request_done，而是"清空后还剩什么"
        self.requests_on_act = []
        self._inflight = inflight
        self.opened = []
        self.actions = []
        self.base_url = "http://fake"

    def _match(self, query, element_):
        for key in element_["keys"]:
            if key.get("kind") != query.get("kind") or key.get("value") != query.get("value"):
                continue
            if query.get("kind") == "role" and key.get("name") != query.get("name"):
                continue
            return True
        return False

    def counts(self, queries):
        return [sum(1 for e in self.elements if self._match(q, e)) for q in queries]

    def probe(self, query):
        hits = [e for e in self.elements if self._match(query, e)]
        if len(hits) != 1:
            return {"ok": False, "count": len(hits)}
        item = hits[0]
        return {"ok": True, "count": 1, "visible": item["visible"],
                "enabled": item["enabled"], "text": item["text"],
                "value": item["value"], "box": item["box"]}

    def attribute(self, query, name):
        hits = [e for e in self.elements if self._match(query, e)]
        return hits[0]["attrs"].get(name) if len(hits) == 1 else None

    def act(self, kind, query, value=None, key=None, timeout_ms=None):
        self.actions.append({"kind": kind, "query": query, "value": value})
        self._requests.extend(self.requests_on_act)
        return {"ok": True}

    def open(self, url, timeout_ms=None):
        self.opened.append(self.absolute(url))
        self._url = self.absolute(url)
        return {"ok": True, "url": self._url}

    def absolute(self, url):
        text = str(url)
        return text if text.startswith("http") else f"{self.base_url}/{text.lstrip('/')}"

    def url(self):
        return self._url

    def inflight(self):
        return self._inflight

    def requests_seen(self):
        return list(self._requests)

    def clear_requests(self):
        self._requests.clear()

    def reset(self):
        self.actions.append({"kind": "reset_session"})


def plan_of(*steps):
    return {"lineage": {"id": "PLAN-FAKE", "version": 1}, "steps": list(steps)}


FIXTURE_ENV = "fixture-web"


def run(driver, plan, **options):
    """默认带一份**显式签发**的授权。

    注意这不是"把闸关掉"：`approval` 是这里主动 `build_approval` 出来的产物，
    有 id、有签发人、绑定本计划的指纹与环境。用例要测闸本身时，用 `authorization=`
    传入构造好的记录（或 `None`）覆盖。
    """
    options.setdefault("locator_timeout_ms", 0)
    options.setdefault("poll_ms", 20)
    env_id = options.pop("env_id", FIXTURE_ENV)
    approval = options.pop("authorization", "__default__")
    if approval == "__default__":
        approval = build_approval(plan, env_id=env_id, issued_by="test:smoke_web_engine")
    return WebEngine(driver, {"username": "qa", "password": "qa-pass", "order_id": "2001"},
                     env_id=env_id, authorization=approval, **options).run_plan(plan)


# ---------------------------------------------------------------- 定位规则
def test_locator_priority_and_degradation_recorded():
    driver = FakeDriver([element({"kind": "css", "value": "#x"}, text="ok")])
    result = run(driver, plan_of({
        "action": "click",
        "target": {"locators": [{"testid": "missing"}, {"role": "button", "name": "没有"},
                                {"css": "#x"}]},
    }))
    assert result["verdict"] == "pass", result
    locator = result["steps"][0]["locator"]
    assert locator["locator_hit"] == 3 and locator["degraded"] is True, \
        f"用第 3 个指纹跑通必须被记录：{locator}"
    assert locator["counts"] == [0, 0, 1]


def test_locator_ambiguity_blocks_instead_of_picking_first():
    driver = FakeDriver([element({"kind": "testid", "value": "row"}),
                         element({"kind": "testid", "value": "row"})])
    result = run(driver, plan_of({"action": "click", "target": {"testid": "row"}}))
    assert result["verdict"] == "inconclusive", f"多命中不能判失败，也不能放行：{result['verdict']}"
    step = result["steps"][0]
    assert step["status"] == "blocked" and step["failure_kind"] == "locator_ambiguous"
    assert step["attribution"] == "script"
    assert result["halt"]["attribution"] == "script"


def test_locator_not_found_blocks_not_fails():
    result = run(FakeDriver([]), plan_of({"action": "click", "target": {"testid": "nope"}}))
    assert result["verdict"] == "inconclusive"
    assert result["steps"][0]["failure_kind"] == "locator_not_found"


def test_unknown_locator_key_is_compile_error():
    problems = validate_plan(plan_of({"action": "click", "target": {"tstid": "typo"}}))
    assert any("未知键" in p for p in problems), problems


def test_compile_error_never_opens_browser():
    driver = FakeDriver([])
    result = run(driver, plan_of({"action": "upload", "target": {"css": "#f"}}))
    assert result["verdict"] == "inconclusive"
    assert result["halt"]["stage"] == "compile"
    assert result["steps"] == [] and driver.opened == []


# ---------------------------------------------------------------- 三类失败
def test_decide_assert_failure_is_product_fail():
    driver = FakeDriver([element({"kind": "testid", "value": "total"}, text="共 2 条")])
    result = run(driver, plan_of({
        "action": "click", "target": {"testid": "total"},
        "assert": [{"type": "text_equals", "target": {"testid": "total"},
                    "expected": "共 3 条", "level": "decide"}]}))
    assert result["verdict"] == "fail"
    assert result["steps"][0]["attribution"] == "product"
    assert result["halt"]["attribution"] == "product"


def test_observe_assert_failure_does_not_fail_run():
    driver = FakeDriver([element({"kind": "testid", "value": "total"}, text="共 2 条")])
    result = run(driver, plan_of({
        "action": "click", "target": {"testid": "total"},
        "assert": [{"type": "text_equals", "target": {"testid": "total"},
                    "expected": "共 3 条", "level": "observe"}]}))
    assert result["verdict"] == "pass", "observe 只采集事实，不能影响 verdict"
    assert result["steps"][0]["assertions"][0]["passed"] is False


def test_wait_timeout_fails_with_kind():
    driver = FakeDriver([element({"kind": "testid", "value": "table"}, visible=False)])
    result = run(driver, plan_of({
        "action": "click", "target": {"testid": "table"},
        "wait": [{"type": "element_visible", "target": {"testid": "table"},
                  "timeout_ms": 150, "poll_interval_ms": 20}]}))
    assert result["verdict"] == "fail"
    assert result["steps"][0]["failure_kind"] == "wait_timeout"
    assert result["steps"][0]["waits"][0]["ok"] is False


def test_action_failure_is_blocked_not_fail():
    class Refusing(FakeDriver):
        def act(self, *args, **kwargs):
            return {"ok": False, "error": "element is covered"}

    driver = Refusing([element({"kind": "testid", "value": "btn"})])
    result = run(driver, plan_of({"action": "click", "target": {"testid": "btn"}}))
    assert result["verdict"] == "inconclusive"
    assert result["steps"][0]["failure_kind"] == "action_failed"
    assert result["steps"][0]["status"] == "blocked"


def test_navigation_failure_is_env_error():
    class Dead(FakeDriver):
        def open(self, url, timeout_ms=None):
            return {"ok": False, "url": url, "error": "net::ERR_CONNECTION_REFUSED"}

    result = run(Dead([]), plan_of({"action": "goto", "target": {"url": "/login"}}))
    assert result["verdict"] == "inconclusive"
    assert result["steps"][0]["failure_kind"] == "env_unreachable"
    assert result["steps"][0]["attribution"] == "env"


# ---------------------------------------------------------------- 断言与传值
def test_count_equals_counts_ambiguity_instead_of_rejecting():
    rows = [element({"kind": "testid", "value": "row"}) for _ in range(3)]
    driver = FakeDriver(rows)
    ok = run(driver, plan_of({"action": "click", "target": {"testid": "row"},
                              "assert": [{"type": "count_equals", "target": {"testid": "row"},
                                          "expected": 3, "level": "decide"}]}))
    # 注意：click 本身因多命中被 blocked；count_equals 只在步骤已跑完时才有意义，
    # 所以这条用例直接断 count 取值能力
    assert ok["steps"][0]["status"] == "blocked"
    engine = WebEngine(driver, {}, locator_timeout_ms=0)
    assert engine._count_only({"testid": "row"}) == 3


def test_hidden_passes_when_element_absent():
    result = run(FakeDriver([]), plan_of({
        "action": "goto", "target": {"url": "/login"},
        "assert": [{"type": "hidden", "target": {"testid": "order-table"}, "level": "decide"}]}))
    assert result["verdict"] == "pass", "不存在也算 hidden：断言的是用户看不到"


def test_url_and_text_assertions():
    driver = FakeDriver([element({"kind": "testid", "value": "orders"}, text="共 2 条")],
                        url="http://fake/orders/2001")
    result = run(driver, plan_of({
        "action": "click", "target": {"testid": "orders"},
        "assert": [{"type": "url_contains", "value": "/orders", "level": "decide"},
                   {"type": "url_matches", "value": r"/orders/\d+$", "level": "decide"},
                   {"type": "value_equals", "target": {"testid": "orders"},
                    "expected": "共 2 条", "level": "observe"}]}))
    assert result["verdict"] == "pass", result["steps"][0]["assertions"]
    assert result["steps"][0]["assertions"][1]["passed"] is True


def test_extract_feeds_following_navigation():
    driver = FakeDriver([element({"kind": "testid", "value": "last-id"}, text="2001")])
    result = run(driver, plan_of(
        {"action": "click", "target": {"testid": "last-id"},
         "extract": {"order_id": {"from": "text", "target": {"testid": "last-id"}}}},
        {"action": "goto", "target": {"url": "/orders/${data.order_id}"}}))
    assert result["verdict"] == "pass", result
    assert driver.opened[-1].endswith("/orders/2001"), driver.opened
    assert result["steps"][0]["extracted_keys"] == ["order_id"]


def test_request_done_matches_method_and_path():
    driver = FakeDriver([element({"kind": "testid", "value": "btn"})])
    driver.requests_on_act = [{"method": "POST", "path": "/api/orders", "status": 200}]
    result = run(driver, plan_of({
        "action": "click", "target": {"testid": "btn"},
        "wait": [{"type": "request_done", "pattern": "POST /api/orders", "timeout_ms": 300}]}))
    assert result["verdict"] == "pass", result["steps"][0]["waits"]


def test_request_done_times_out_when_only_get_happened():
    driver = FakeDriver([element({"kind": "testid", "value": "btn"})])
    driver.requests_on_act = [{"method": "GET", "path": "/api/orders", "status": 200}]
    result = run(driver, plan_of({
        "action": "click", "target": {"testid": "btn"},
        "wait": [{"type": "request_done", "pattern": "POST /api/orders",
                  "timeout_ms": 150, "poll_interval_ms": 20}]}))
    assert result["verdict"] == "fail"
    assert result["steps"][0]["waits"][0]["observed"]["seen"] == ["GET /api/orders"]


# ---------------------------------------------------------------- 计划校验
def test_validate_rejects_sleep_and_unsupported_action():
    problems = validate_plan(plan_of(
        {"action": "upload", "target": {"css": "#f"}},
        {"action": "click", "target": {"css": "#g"}, "wait": [{"type": "sleep", "timeout_ms": 300}]}))
    assert any("不支持" in p for p in problems)
    assert any("sleep" in p for p in problems)


def test_validate_rejects_unknown_assert_type():
    problems = validate_plan(plan_of({"action": "goto", "target": {"url": "/x"},
                                      "assert": [{"type": "json_path", "level": "decide"}]}))
    assert any("json_path" in p for p in problems), problems


def test_consistency_is_not_claimed_for_web():
    driver = FakeDriver([element({"kind": "testid", "value": "btn"})])
    result = run(driver, plan_of({"action": "click", "target": {"testid": "btn"},
                                  "assert": [{"type": "url_contains", "value": "fake",
                                              "level": "decide"}]}))
    assert result["verdict"] == "pass"
    assert result["consistency"]["status"] == "not_verified", \
        "web 动作都有副作用，引擎内不能假装验证过一致性"


# ---------------------------------------------------------------- 复跑许可
def test_write_step_is_not_repeatable_without_declaration():
    from aitestharness_tools.exec.consistency import step_allows_repeat
    allowed, reason = step_allows_repeat({"request": "POST /api/orders",
                                          "assert": [{"decide": True}]}, "api")
    assert allowed is False and "非安全方法" in reason, reason


def test_read_step_is_repeatable():
    from aitestharness_tools.exec.consistency import pick_repeatable
    picked = pick_repeatable([
        {"request": "POST /api/orders", "assert": [{"decide": True}]},
        {"request": "GET /api/orders/1001", "assert": [{"decide": True}]},
    ], "api")
    assert picked and picked["index"] == 1, picked


def test_explicit_idempotent_overrides_inference():
    from aitestharness_tools.exec.consistency import step_allows_repeat
    allowed, _ = step_allows_repeat({"request": "PUT /api/orders/1", "idempotent": True}, "api")
    assert allowed is True
    allowed, reason = step_allows_repeat({"request": "GET /api/orders", "idempotent": False}, "api")
    assert allowed is False and "显式声明" in reason


# ---------------------------------------------------------------- 清理契约 teardown
def plan_with_teardown(steps, teardown_steps, verify=None):
    plan = plan_of(*steps)
    plan["teardown"] = {"steps": list(teardown_steps)}
    if verify:
        plan["teardown"]["verify_gone"] = verify
    return plan


def test_teardown_runs_even_when_main_step_fails():
    """失败的那一次才是最需要清理的那一次——只在 pass 时清理，数据就永久留下了。"""
    driver = FakeDriver([element({"kind": "testid", "value": "btn"})])
    plan = plan_with_teardown(
        [{"action": "click", "target": {"testid": "btn"},
          "assert": [{"type": "visible", "target": {"testid": "not-rendered"}, "level": "decide"}]}],
        [{"action": "click", "target": {"testid": "btn"}}])
    result = run(driver, plan)
    assert result["verdict"] == "fail"
    assert len(result["teardown"]["steps"]) == 1, "主步骤失败后清理没有执行"
    assert result["teardown"]["status"] == "pass", result["teardown"]


def test_teardown_halts_when_a_cleanup_step_cannot_act():
    """清理步骤带着失败的前提继续跑，最坏会作用到别人的数据。"""
    driver = FakeDriver([element({"kind": "testid", "value": "btn"})])
    plan = plan_with_teardown(
        [{"action": "click", "target": {"testid": "btn"}}],
        [{"action": "click", "target": {"testid": "not-there"}},
         {"action": "click", "target": {"testid": "btn"}}],
        verify=[{"name": "探针账号", "target": {"testid": "not-there"}}])
    result = run(driver, plan)
    teardown = result["teardown"]
    assert len(teardown["steps"]) == 1, "清理失败后仍继续执行了后续清理步骤"
    assert teardown["steps"][0]["status"] == "blocked"
    assert teardown["halt"]["failure_kind"] == "locator_not_found"
    assert [a["kind"] for a in driver.actions].count("click") == 1, "清理多点了"


def test_teardown_residue_is_surfaced_without_changing_verdict():
    """清理失败不改 verdict（verdict 判被测系统），但残留必须显式可见。"""
    driver = FakeDriver([element({"kind": "testid", "value": "btn"})])
    plan = plan_with_teardown(
        [{"action": "click", "target": {"testid": "btn"}}],
        [{"action": "click", "target": {"testid": "btn"}}],
        verify=[{"name": "探针账号", "target": {"testid": "btn"}}])
    result = run(driver, plan)
    assert result["verdict"] == "pass"
    assert result["teardown"]["status"] == "failed"
    assert result["teardown"]["residue"] == ["探针账号"], result["teardown"]
    assert result["needs_attention"]["kind"] == "residue"
    assert "探针账号" in result["needs_attention"]["because"]


def test_expired_cleanup_step_without_residue_is_not_an_alert():
    """清理步骤过期（按钮已经不存在）但反验证明无残留：是维护提示，不是事故。"""
    driver = FakeDriver([element({"kind": "testid", "value": "btn"})])
    plan = plan_with_teardown(
        [{"action": "click", "target": {"testid": "btn"}}],
        [{"action": "click", "target": {"testid": "already-gone"}}],
        verify=[{"name": "探针账号", "target": {"testid": "already-gone"}}])
    result = run(driver, plan)
    assert result["teardown"]["status"] == "failed"
    assert result["teardown"]["verified_no_residue"] is True
    assert "needs_attention" not in result, "无残留却报了需要人工介入"


def test_teardown_skipped_when_no_step_acted():
    """一步都没跑通 = 页面没被操作过，此时清理只会制造假告警。"""
    driver = FakeDriver([])
    plan = plan_with_teardown(
        [{"action": "click", "target": {"testid": "not-there"}}],
        [{"action": "click", "target": {"testid": "not-there"}}])
    result = run(driver, plan)
    assert result["teardown"]["status"] == "skipped"
    assert "未执行任何写动作" in result["teardown"]["reason"]


def test_plan_without_teardown_is_flagged_as_uncleaned():
    driver = FakeDriver([element({"kind": "testid", "value": "btn"})])
    result = run(driver, plan_of({"action": "click", "target": {"testid": "btn"}}))
    assert result["teardown"]["status"] == "skipped"
    assert "teardown" in result["teardown"]["reason"], result["teardown"]


def test_teardown_steps_are_compiled_too():
    """清理步骤写错了同样会点到别的数据，必须在开浏览器之前判掉。"""
    plan = plan_with_teardown(
        [{"action": "click", "target": {"testid": "btn"}}],
        [{"action": "submit", "target": {"testid": "btn"}}])
    result = run(FakeDriver([]), plan)
    assert result["verdict"] == "inconclusive"
    assert any("teardown[0]" in e for e in result["compile_errors"]), result["compile_errors"]


def test_request_done_ignores_requests_from_earlier_steps():
    """请求记录是计划级的：不划基线，"等提交成功"会被上一步的请求立刻满足。"""
    driver = FakeDriver([element({"kind": "testid", "value": "btn"})])
    driver.requests_on_act = [{"method": "POST", "path": "/api/orders"}]
    plan = plan_of(
        {"action": "click", "target": {"testid": "btn"}},
        {"action": "wait", "wait": [{"type": "request_done", "pattern": "POST /api/orders",
                                     "timeout_ms": 150}]},
    )
    result = run(driver, plan)
    assert result["steps"][1]["status"] == "fail", "把上一步的请求当成了这一步的"
    assert result["steps"][1]["waits"][0]["observed"]["baseline"] == 1


def test_request_done_matches_request_caused_by_the_same_step():
    driver = FakeDriver([element({"kind": "testid", "value": "btn"})])
    driver.requests_on_act = [{"method": "POST", "path": "/api/orders"}]
    plan = plan_of({"action": "click", "target": {"testid": "btn"},
                    "wait": [{"type": "request_done", "pattern": "POST /api/orders",
                              "timeout_ms": 500}]})
    result = run(driver, plan)
    assert result["steps"][0]["status"] == "pass", result["steps"][0]


def test_ambiguous_wait_target_is_blocked_not_product_fail():
    """等待条件写宽了（命中多个）是脚本问题，不能记成产品缺陷。"""
    driver = FakeDriver([element({"kind": "css", "value": ".row"}),
                         element({"kind": "css", "value": ".row"})])
    plan = plan_of({"action": "wait",
                    "wait": [{"type": "element_visible", "target": {"css": ".row"},
                              "timeout_ms": 150}]})
    result = run(driver, plan)
    step = result["steps"][0]
    assert step["status"] == "blocked", step
    assert step["failure_kind"] == "wait_locator_ambiguous"
    assert step["attribution"] == "script"
    assert result["verdict"] == "inconclusive"


# ---------------------------------------------------------------- 真浏览器
def _web_plans():
    files = sorted(glob.glob(os.path.join(WEB_FIXTURES, "plan-w*.yaml")))
    return [yaml.safe_load(open(path, encoding="utf-8")) for path in files]


def _browser_available():
    from aitestharness_tools.exec.web_driver import playwright_available
    return playwright_available()


def test_playwright_three_plans_pass():
    if not _browser_available():
        print("  (skip: playwright 未安装)")
        return
    from aitestharness_tools.exec.web_driver import BrowserHost
    from web_service import WebTarget

    plans = _web_plans()
    assert len(plans) == 3, f"应有 3 条 Web 剧本，实际 {len(plans)}"
    with WebTarget() as site, BrowserHost() as host:
        for plan in plans:
            result = WebEngine(
                host.new_driver(site.base_url), {"username": "qa", "password": "qa-pass"},
                env_id=FIXTURE_ENV,
                authorization=build_approval(plan, env_id=FIXTURE_ENV,
                                             issued_by="test:smoke_web_engine"),
            ).run_plan(plan)
            assert result["verdict"] == "pass", f"{plan['lineage']['id']}: {result['halt']}"


def test_playwright_locator_miss_blocks_but_does_not_fail():
    if not _browser_available():
        print("  (skip: playwright 未安装)")
        return
    from aitestharness_tools.exec.web_driver import BrowserHost
    from web_service import WebTarget

    plan = {"lineage": {"id": "PLAN-WEB-MISS", "version": 1}, "steps": [
        {"action": "goto", "target": {"url": "/login"}},
        {"action": "click", "target": {"locators": [{"testid": "not-exist"},
                                                    {"css": "#not-exist"}]}}]}
    with WebTarget() as site, BrowserHost() as host:
        result = WebEngine(
            host.new_driver(site.base_url), {}, locator_timeout_ms=300,
            env_id=FIXTURE_ENV,
            authorization=build_approval(plan, env_id=FIXTURE_ENV,
                                         issued_by="test:smoke_web_engine"),
        ).run_plan(plan)
    assert result["verdict"] == "inconclusive", result
    assert result["steps"][1]["failure_kind"] == "locator_not_found"
    assert result["steps"][1]["attribution"] == "script"


def test_playwright_two_rounds_identical():
    if not _browser_available():
        print("  (skip: playwright 未安装)")
        return
    from aitestharness_tools.exec.replay import replay
    from aitestharness_tools.exec.web_driver import BrowserHost
    from web_service import WebTarget

    plans = _web_plans()
    with WebTarget() as site, BrowserHost() as host:
        factory = lambda url, data: WebEngine(host.new_driver(url), data)
        report = replay(
            plans, base_url=site.base_url, rounds=2, engine_factory=factory,
            data={"username": "qa", "password": "qa-pass"}, env_id=FIXTURE_ENV,
            authorization_for=lambda p: build_approval(
                p, env_id=FIXTURE_ENV, issued_by="test:replay"),
        )
    assert report["deterministic"] is True, report["divergence"]
    assert report["content_stable"] is True, "同一份固定数据，页面文本不该抖动"
    assert all(v == "pass" for v in report["per_round"][0]["verdicts"].values()), report["per_round"]


def test_storage_state_accepts_dict_path_and_none():
    """会话既可以直接给 dict，也可以给落盘路径——跨进程复用是常态，调用方不该被迫自己读文件。"""
    import json
    import tempfile
    from aitestharness_tools.exec.web_driver import _load_state

    assert _load_state(None) is None
    payload = {"cookies": [], "origins": []}
    assert _load_state(payload) == payload

    with tempfile.TemporaryDirectory() as directory:
        path = os.path.join(directory, "state.json")
        with open(path, "w", encoding="utf-8") as handle:
            json.dump(payload, handle)
        assert _load_state(path) == payload


def test_select_value_reads_selected_label():
    """el-select 的 input 是 readOnly 搜索框，value 永远为空，选中文本在 span 里。

    这里用最小 DOM 复刻组件库结构：不需要真的装 Element Plus，
    但必须覆盖这条路径——否则"选了却说没选"会被记成产品缺陷。
    """
    if not _browser_available():
        print("  (skip: playwright 未安装)")
        return
    from aitestharness_tools.exec.locator import fingerprint_query
    from aitestharness_tools.exec.web_driver import BrowserHost

    with BrowserHost() as host:
        driver = host.new_driver("")
        driver._page.set_content(
            '<div class="el-select"><span class="el-select__tags-text">测试</span>'
            '<input readonly value=""></div>'
            '<input id="plain" value="hello">')
        selected = driver.probe(fingerprint_query({"css": ".el-select input"}))
        plain = driver.probe(fingerprint_query({"css": "#plain"}))
        driver.close()

    assert selected["ok"] is True, selected
    assert selected["value"] == "测试", f"应读选中标签文本而非空 value：{selected}"
    assert plain["value"] == "hello", f"普通输入框仍读 value：{plain}"


if __name__ == "__main__":
    import traceback
    fails = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_"):
            try:
                fn()
                print(f"PASS {name}")
            except Exception as error:
                fails += 1
                print(f"FAIL {name}: {error}")
                traceback.print_exc()
    print("ALL PASS" if fails == 0 else f"{fails} FAILED")
    sys.exit(1 if fails else 0)
