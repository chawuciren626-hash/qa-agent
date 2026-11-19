"""探针层与探索流水线冒烟测试（M2a）。

这里**不装浏览器、不联网**：探针用测试替身（FakeProbe），HTTP 解析用固定 HTML 片段。
这正是分层的目的——判定逻辑必须能在没有浏览器的机器上验证，否则规则一改就得开浏览器，
成本高到没人愿意改。
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from aitestharness_tools.probe.base import (Bundle, FlatDom, PartialFailure,
                                            ProbeUnavailable, ScriptRef, WebProbe)
from aitestharness_tools.probe.http_probe import HttpProbe, parse_bundle
from aitestharness_tools.probe.playwright_probe import PlaywrightProbe
from aitestharness_tools.explore.explorer import BudgetGuard
from aitestharness_tools.explore.pipeline import explore

HTML = """<!doctype html><html><head>
<link rel="modulepreload" href="/assets/route-a.js">
<script src="/assets/app.js"></script>
<script>window.__BOOT__ = {path: '/inline-route'};</script>
</head><body><div id="app"></div></body></html>"""

JS = """const routes = [{path: '/orders', component: Order}, {path: '/users', component: Users}];
router.push('/reports');"""


class FakeProbe:
    """测试替身：四方法齐全，行为可控。"""

    name = "fake"

    def __init__(self, html=HTML, js=JS, fail_pages=(), no_dom=False):
        self.html = html
        self.js = js
        self.fail_pages = set(fail_pages)
        self.no_dom = no_dom
        self.dom_calls = []

    def fetch_bundle(self, url, *, timeout_ms=15000):
        return Bundle(url=url, status=200, html=self.html,
                      scripts=[ScriptRef(url="inline", text=self.js, inline=True)])

    def flat_dom(self, url, *, timeout_ms=15000):
        self.dom_calls.append(url)
        if self.no_dom:
            raise ProbeUnavailable("测试替身未启用结构巡检")
        if any(token in url for token in self.fail_pages):
            raise PartialFailure(url, "渲染超时", tried=["bundle", "dom"], detail={"token": "timeout"})
        return FlatDom(url=url, elements=[
            {"tag": "input", "type": "text", "name": "keyword", "placeholder": "搜索"},
            {"tag": "button", "text": "查询", "data-testid": "search-btn"},
            {"tag": "a", "text": "详情", "href": "/orders/1"},
        ], frames=[])

    def screenshot(self, url, *, full_page=True, timeout_ms=15000):
        raise ProbeUnavailable("测试替身不支持截图")

    def act(self, url, action, *, timeout_ms=15000):
        raise ProbeUnavailable("测试替身不支持动作")

    def close(self):
        return None


def test_parse_bundle_extracts_three_kinds():
    refs = parse_bundle(HTML, "https://demo.local/base/")
    urls = [ref.url for ref in refs]
    assert "https://demo.local/assets/app.js" in urls, urls
    assert "https://demo.local/assets/route-a.js" in urls, "modulepreload 里的路由 chunk 不能漏"
    assert any(ref.inline and "__BOOT__" in (ref.text or "") for ref in refs), "内联脚本必须取到原文"
    # 去重：同一 URL 出现两次只留一条
    assert len(urls) == len(set(urls))


def test_http_probe_refuses_browser_methods():
    probe = HttpProbe()
    for call in (lambda: probe.flat_dom("https://demo.local"),
                 lambda: probe.screenshot("https://demo.local"),
                 lambda: probe.act("https://demo.local", {"action": "click"})):
        try:
            call()
        except ProbeUnavailable:
            continue
        raise AssertionError("HttpProbe 必须明确拒绝需要浏览器的能力，而不是返回空结果")


def test_pipeline_marks_every_page_source():
    # max_routes 截断只巡检前 2 条：其余路由停在 source=bundle（"知道它在，但没看过里面"）
    maps = explore("https://demo.local/", FakeProbe(), max_routes=2)
    sources = {page["page"]: page["source"] for page in maps["pages"]}
    assert sources.get("/") == "dom", sources
    assert "bundle" in sources.values(), f"被预算截断的路由必须标 bundle：{sources}"
    assert maps["stats"]["inspected"] == 2, maps["stats"]
    assert maps["stats"]["controls"] > 0
    assert maps["stack"]["spa"] is True
    # controls=None 而不是空 dict：区分"没看过"与"看过但没控件"
    assert all(page["controls"] is None for page in maps["pages"] if page["source"] == "bundle")


def test_pipeline_keeps_unresolved_with_reason():
    maps = explore("https://demo.local/", FakeProbe(fail_pages=("/users",)))
    unresolved = {item["page"]: item for item in maps["unresolved"]}
    assert "/users" in unresolved
    assert unresolved["/users"]["reason"] == "渲染超时"
    assert unresolved["/users"]["tried"] == ["bundle", "dom"], "已试手段必须留痕，视觉兜底靠它判断"
    # 失败的页面不能出现在 pages 里冒充"已巡检但没控件"
    assert all(page["source"] != "unresolved" for page in maps["pages"])


def test_pipeline_degrades_without_driver():
    maps = explore("https://demo.local/", FakeProbe(no_dom=True))
    assert maps["stats"]["inspected"] == 0
    assert maps["unresolved"], "驱动不可用必须如实登记，不能给一张空地图"
    assert all(page["source"] == "bundle" for page in maps["pages"])
    reasons = " ".join(item["reason"] for item in maps["unresolved"])
    assert "驱动不可用" in reasons or "结构巡检" in reasons, reasons


def test_pipeline_budget_caps_inspection():
    guard = BudgetGuard(inspect_pages=1)
    maps = explore("https://demo.local/", FakeProbe(), budget=guard)
    assert maps["stats"]["inspected"] == 1, maps["stats"]
    assert any("预算" in item["reason"] for item in maps["unresolved"])


def test_pipeline_hash_is_stable():
    first = explore("https://demo.local/", FakeProbe())
    second = explore("https://demo.local/", FakeProbe())
    assert first["content_hash"] == second["content_hash"], "同输入必须同指纹，否则 G9 判不了 stale"


def test_pipeline_entry_failure_is_loud():
    class Broken(FakeProbe):
        def fetch_bundle(self, url, *, timeout_ms=15000):
            return Bundle(url=url, status=0, html="", error="ConnectionRefused")

    try:
        explore("https://demo.local/", Broken())
    except PartialFailure as failure:
        assert "入口页取不到" in failure.reason
        return
    raise AssertionError("入口页取不到时必须抛 PartialFailure，不能返回空地图")


def test_probe_protocol_is_structural():
    assert isinstance(FakeProbe(), WebProbe), "WebProbe 是结构化协议：实现四个方法即成立"


def test_act_rejects_unknown_action_without_browser():
    probe = PlaywrightProbe()
    result = probe.act("https://demo.local", {"action": "evaluate_js"})
    assert result.ok is False
    assert "封闭枚举" in (result.error or ""), "act 只接受枚举动作，任何任意脚本都必须被拒"
    probe.close()


def test_no_browser_import_in_judgement_layers():
    # 断言"判定层不依赖浏览器"：这是 M2a 能单测的前提，破坏它等于让所有 DOM 规则都得开浏览器验证。
    assert "playwright" not in sys.modules, "导入 pipeline 不能顺带导入 playwright（必须延迟导入）"


if __name__ == "__main__":
    fails = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_"):
            try:
                fn()
                print(f"PASS {name}")
            except Exception as error:
                fails += 1
                import traceback
                print(f"FAIL {name}: {error}")
                traceback.print_exc()
    print("ALL PASS" if fails == 0 else f"{fails} FAILED")
    sys.exit(1 if fails else 0)
