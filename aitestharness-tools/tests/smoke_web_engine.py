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


def run(driver, plan, **options):
    options.setdefault("locator_timeout_ms", 0)
    options.setdefault("poll_ms", 20)
    return WebEngine(driver, {"username": "qa", "password": "qa-pass", "order_id": "2001"},
                     **options).run_plan(plan)


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
            result = WebEngine(host.new_driver(site.base_url),
                               {"username": "qa", "password": "qa-pass"}).run_plan(plan)
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
        result = WebEngine(host.new_driver(site.base_url), {},
                           locator_timeout_ms=300).run_plan(plan)
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
        report = replay(plans, base_url=site.base_url, rounds=2, engine_factory=factory,
                        data={"username": "qa", "password": "qa-pass"})
    assert report["deterministic"] is True, report["divergence"]
    assert report["content_stable"] is True, "同一份固定数据，页面文本不该抖动"
    assert all(v == "pass" for v in report["per_round"][0]["verdicts"].values()), report["per_round"]


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
