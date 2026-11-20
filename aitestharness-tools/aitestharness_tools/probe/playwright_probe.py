"""Playwright 探针：② 结构巡检 / ③ 截图 / ④ 受控动作（M2a 主路径）。

只干"取原料"，不做任何判断：

    · 这里不判断哪个元素可点、不比对上一次快照、不做等待策略决策——那些在 exec/snapshot.py
      与 explore/pipeline.py 里，是纯函数，改起来不用开浏览器；
    · 这里不做自愈、不重试业务动作（只重试导航失败一次），自愈在 exec/infra.py 分级处理；
    · 这里不调模型。视觉兜底（M2b）由 agent 经 MCP 拿 `screenshot` 去做，探针不掺和。

`import playwright` 是**延迟导入**的：判定层与 pipeline 单测在没装浏览器的机器上必须能跑，
所以模块顶层不 import playwright，`playwright_available()` 只用 importlib 探测。
"""
from __future__ import annotations

import importlib.util
from contextlib import contextmanager
from typing import Any

from .base import (ActResult, Bundle, FlatDom, PartialFailure, ProbeUnavailable,
                   SOURCE_DOM)

__all__ = ["PlaywrightProbe", "playwright_available", "MAX_PAGE_ELEMENTS", "COLLECT_JS"]

MAX_PAGE_ELEMENTS = 800     # 与 exec/snapshot.MAX_ELEMENTS 对齐：超了多半是异常页面（整表展开）

COLLECT_JS = r"""
() => {
  const MAX = %d;
  const SEL = 'input,textarea,select,button,a,table,form,label,details,[role],[data-testid],[contenteditable="true"]';
  const out = [];
  const labelOf = (el) => {
    if (el.id) return '#' + el.id;
    const tid = el.getAttribute('data-testid') || el.getAttribute('data-test');
    if (tid) return '[data-testid="' + tid + '"]';
    return (el.tagName || '').toLowerCase();
  };
  const push = (el, host) => {
    if (out.length >= MAX) return;
    const tag = (el.tagName || '').toLowerCase();
    const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    out.push({
      tag: tag,
      text: text,
      id: el.id || undefined,
      name: el.getAttribute('name') || undefined,
      type: el.getAttribute('type') || undefined,
      role: el.getAttribute('role') || undefined,
      'aria-label': el.getAttribute('aria-label') || undefined,
      placeholder: el.getAttribute('placeholder') || undefined,
      'data-testid': el.getAttribute('data-testid') || el.getAttribute('data-test') || undefined,
      href: el.getAttribute('href') || undefined,
      disabled: (el.disabled === true || el.getAttribute('aria-disabled') === 'true') || undefined,
      shadow_host: host || undefined,
      visible: !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length)
    });
  };
  const walk = (root, host) => {
    let nodes = [];
    try { nodes = Array.from(root.querySelectorAll(SEL)); } catch (e) { nodes = []; }
    for (const el of nodes) push(el, host);
    // shadow DOM 必须显式下钻：不标注宿主时，同一份 css 在宿主内外各命中一次 → ambiguous（经典假失败）
    let all = [];
    try { all = Array.from(root.querySelectorAll('*')); } catch (e) { all = []; }
    for (const el of all) {
      if (el.shadowRoot) walk(el.shadowRoot, host ? host + '>' + labelOf(el) : labelOf(el));
    }
  };
  walk(document, null);
  return { elements: out, truncated: out.length >= MAX };
}
""" % MAX_PAGE_ELEMENTS


def playwright_available() -> bool:
    """只探测，不导入：证明"这台机器能不能跑浏览器"，不产生副作用。"""
    try:
        return importlib.util.find_spec("playwright.sync_api") is not None
    except (ImportError, ValueError):
        return False


class PlaywrightProbe:
    """一个页面一个 context，按需导航；`close()` 释放浏览器。

    可以当上下文管理器用：
        with PlaywrightProbe() as probe:
            dom = probe.flat_dom("https://example.com")
    """

    name = "playwright"

    def __init__(self, *, headless: bool = True, viewport: tuple[int, int] = (1440, 900),
                 ignore_https_errors: bool = True, nav_timeout_ms: int = 15000,
                 max_elements: int = MAX_PAGE_ELEMENTS):
        self.headless = headless
        self.viewport = viewport
        self.ignore_https_errors = ignore_https_errors
        self.nav_timeout_ms = nav_timeout_ms
        self.max_elements = max_elements
        self._pw = None
        self._browser = None
        self._context = None
        self._page = None
        self._url = None

    # ---- 生命周期 --------------------------------------------------------
    def _ensure_page(self):
        if self._page is not None and not self._page.is_closed():
            return self._page
        if not playwright_available():
            raise ProbeUnavailable("未安装 Playwright：`pip install playwright && playwright install chromium`")
        from playwright.sync_api import sync_playwright
        if self._pw is None:
            self._pw = sync_playwright().start()
            self._browser = self._pw.chromium.launch(headless=self.headless)
            self._context = self._browser.new_context(
                viewport={"width": self.viewport[0], "height": self.viewport[1]},
                ignore_https_errors=self.ignore_https_errors,
            )
            self._context.set_default_timeout(self.nav_timeout_ms)
        self._page = self._context.new_page()
        return self._page

    def _goto(self, url: str, timeout_ms: int):
        """导航失败重试一次后抛 PartialFailure：带 url + 原因，供上层决定是否上视觉兜底。"""
        page = self._ensure_page()
        last: Exception | None = None
        for _ in range(2):
            try:
                page.goto(url, wait_until="domcontentloaded", timeout=timeout_ms or self.nav_timeout_ms)
                self._url = url
                return page
            except Exception as error:      # playwright 的 Error 类型不在公开 API 里稳定导出
                last = error
        raise PartialFailure(url, f"导航失败：{last}", tried=[SOURCE_DOM],
                             detail={"driver": self.name})

    def close(self) -> None:
        for closer in (lambda: self._context and self._context.close(),
                       lambda: self._browser and self._browser.close(),
                       lambda: self._pw and self._pw.stop()):
            try:
                closer()
            except Exception:
                pass
        self._context = self._browser = self._pw = self._page = None

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()

    # ---- ① 静态解析：交给 HTTP，不为了取原文开浏览器 ----------------------
    def fetch_bundle(self, url: str, *, timeout_ms: int = 15000) -> Bundle:
        # 取原文不需要浏览器：即使手里有 Playwright 也走 HTTP，省下启动成本与不确定性。
        from .http_probe import HttpProbe
        return HttpProbe().fetch_bundle(url, timeout_ms=timeout_ms)

    # ---- ② 结构巡检 ------------------------------------------------------
    def flat_dom(self, url: str, *, timeout_ms: int = 15000) -> FlatDom:
        page = self._goto(url, timeout_ms)
        frames: list[str] = []
        elements: list[dict[str, Any]] = []
        truncated = False
        for frame in page.frames:
            selector = None
            if frame != page.main_frame:
                selector = self._frame_selector(frame)
                frames.append(selector)
            try:
                payload = frame.evaluate(COLLECT_JS)
            except Exception as error:
                raise PartialFailure(url, f"frame 取 DOM 失败：{error}", tried=[SOURCE_DOM],
                                     detail={"driver": self.name, "frame": selector or "main"})
            truncated = truncated or bool(payload.get("truncated"))
            for element in payload.get("elements") or []:
                if selector:
                    element["frames"] = [{"selector": selector}]
                elements.append(element)
        if not elements and not frames:
            raise PartialFailure(url, "页面无任何可交互元素（可能渲染失败或全 canvas）",
                                 tried=[SOURCE_DOM], detail={"driver": self.name})
        return FlatDom(url=url, elements=elements[: self.max_elements], frames=frames,
                       source=SOURCE_DOM, truncated=truncated or len(elements) > self.max_elements)

    @staticmethod
    def _frame_selector(frame) -> str:
        try:
            handle = frame.frame_element()
            ident = handle.get_attribute("id")
            name = handle.get_attribute("name")
            if ident:
                return f"iframe#{ident}"
            if name:
                return f'iframe[name="{name}"]'
            return f"iframe[src~=\"{frame.url}\"]" if frame.url else "iframe"
        except Exception:
            return "iframe"

    # ---- ③ 截图（视觉兜底 / 人工排查用） ---------------------------------
    def screenshot(self, url: str, *, full_page: bool = True, timeout_ms: int = 15000) -> bytes:
        page = self._goto(url, timeout_ms)
        try:
            return page.screenshot(full_page=full_page, type="png")
        except Exception as error:
            raise PartialFailure(url, f"截图失败：{error}", tried=[SOURCE_DOM],
                                 detail={"driver": self.name})

    # ---- ④ 受控动作（封闭枚举，不接受任意脚本） --------------------------
    ACTIONS = ("navigate", "click", "fill", "press", "wait_for", "scroll")

    def act(self, url: str, action: dict[str, Any], *, timeout_ms: int = 15000) -> ActResult:
        kind = str(action.get("action") or action.get("kind") or "").strip()
        if kind not in self.ACTIONS:
            return ActResult(ok=False, action=kind or "(空)", url=url,
                             error=f"动作不在封闭枚举内：{kind!r}（允许 {', '.join(self.ACTIONS)}）")
        try:
            page = self._goto(url, timeout_ms)
            selector = action.get("selector")
            if kind == "navigate":
                page.goto(str(action.get("url") or url), wait_until="domcontentloaded",
                          timeout=timeout_ms)
            elif kind == "click":
                page.locator(str(selector)).first.click(timeout=timeout_ms)
            elif kind == "fill":
                page.locator(str(selector)).first.fill(str(action.get("value") or ""),
                                                       timeout=timeout_ms)
            elif kind == "press":
                page.locator(str(selector)).first.press(str(action.get("key") or "Enter"),
                                                        timeout=timeout_ms)
            elif kind == "wait_for":
                page.locator(str(selector)).first.wait_for(state=str(action.get("state") or "visible"),
                                                           timeout=timeout_ms)
            elif kind == "scroll":
                page.mouse.wheel(0, int(action.get("delta") or 800))
            return ActResult(ok=True, action=kind, url=page.url,
                             detail={"selector": selector, "value": action.get("value")})
        except PartialFailure:
            raise
        except Exception as error:
            # 动作失败是正常结果（元素不在/不可点），不是探针故障：返回而不抛，由剧本层判定。
            return ActResult(ok=False, action=kind, url=url, error=f"{type(error).__name__}: {error}")


@contextmanager
def probe_session(**kwargs):
    """便捷上下文：`with probe_session() as probe:`，异常也保证关浏览器。"""
    probe = PlaywrightProbe(**kwargs)
    try:
        yield probe
    finally:
        probe.close()
