"""Playwright 驱动：**只提供原语，不做判断**。

职责边界（与 probe 层的分工一致）：

  · 这里回答"这个指纹命中几个元素""这个元素现在是什么状态""点它会发生什么"；
  · 不回答"该等多久""该不该重试""这条用例算不算失败"——那些在 web_engine 与
    locator 里，是纯函数，改判定逻辑不用开浏览器；
  · 不调模型、不做自愈、不截图判视觉（M2b 的活）。

为什么每个执行单元一个新 context
--------------------------------
浏览器进程很贵（数百毫秒 + 内存），context 很便宜（几十毫秒）。所以 BrowserHost 复
用一个浏览器，每个计划/每一轮开一个新 context：cookie、localStorage、sessionStorage
全部隔离。复用 context 会让"未登录访问应被拦截"这类负向用例从第 2 轮起假失败，而
这类失败会被记到产品头上——与 replay 层"轮间隔离引擎实例"是同一个理由。

`import playwright` 一律延迟导入：没有浏览器的机器上，web_engine 的单测（用假驱动）
必须照样跑得起来。
"""
from __future__ import annotations

import importlib.util
import json
import time
from typing import Any
from urllib.parse import urlsplit

__all__ = ["BrowserHost", "PlaywrightDriver", "playwright_available",
           "DriverUnavailable", "MAX_TEXT"]

MAX_TEXT = 4000          # 元素文本进证据的上限，防整页文本灌进 exec IR


class DriverUnavailable(RuntimeError):
    """浏览器不可用（未装 Playwright / 启动失败）。属环境问题，不该判产品失败。"""


def playwright_available() -> bool:
    try:
        return importlib.util.find_spec("playwright.sync_api") is not None
    except (ImportError, ValueError):
        return False


def _css_string(value: str) -> str:
    """把值安全地塞进 CSS 属性选择器。json.dumps 的转义对 CSS 字符串同样有效。"""
    return json.dumps(str(value), ensure_ascii=False)


def _load_state(storage_state: Any) -> Any:
    """把 storageState 统一成 dict：接受 dict、文件路径、None。

    为什么支持路径：会话是"一次登录、多次复用"的东西，天然要跨进程落盘。
    调用方不该被迫在每次跑之前读一遍 JSON。
    """
    if storage_state is None:
        return None
    if isinstance(storage_state, dict):
        return storage_state
    return json.loads(open(str(storage_state), "r", encoding="utf-8").read())


class BrowserHost:
    """浏览器进程宿主。可以当上下文管理器用，`new_driver()` 出隔离的会话。"""

    def __init__(self, *, headless: bool = True, viewport: tuple[int, int] = (1440, 900),
                 ignore_https_errors: bool = True, nav_timeout_ms: int = 15000):
        self.headless = headless
        self.viewport = viewport
        self.ignore_https_errors = ignore_https_errors
        self.nav_timeout_ms = nav_timeout_ms
        self._pw = None
        self._browser = None
        self._drivers: list[PlaywrightDriver] = []

    def start(self) -> "BrowserHost":
        if self._browser is not None:
            return self
        if not playwright_available():
            raise DriverUnavailable(
                "未安装 Playwright：pip install playwright && playwright install chromium")
        from playwright.sync_api import sync_playwright
        try:
            self._pw = sync_playwright().start()
            self._browser = self._pw.chromium.launch(headless=self.headless)
        except Exception as error:
            self.close()
            raise DriverUnavailable(f"浏览器启动失败：{type(error).__name__}: {error}")
        return self

    def new_driver(self, base_url: str = "", *, storage_state: Any = None,
                   **overrides) -> "PlaywrightDriver":
        """新建一个 driver（= 一个独立 context）。

        `storage_state` 可以是 dict，也可以是 storageState 的文件路径。它解决的
        是"登录不可确定性自动化"的系统：登录环节带随机验证码，无法零 LLM 重放，
        于是把登录隔离成一次性动作、落盘会话，之后每个剧本复用它——
        被测功能的执行路径仍然是确定性的。
        """
        self.start()
        driver = PlaywrightDriver(self, base_url, storage_state=storage_state, **overrides)
        self._drivers.append(driver)
        return driver

    def _new_context(self, storage_state: Any = None):
        return self._browser.new_context(
            viewport={"width": self.viewport[0], "height": self.viewport[1]},
            ignore_https_errors=self.ignore_https_errors,
            storage_state=storage_state,
        )

    def close(self) -> None:
        for driver in list(self._drivers):
            try:
                driver.close()
            except Exception:
                pass
        self._drivers.clear()
        for closer in (lambda: self._browser and self._browser.close(),
                       lambda: self._pw and self._pw.stop()):
            try:
                closer()
            except Exception:
                pass
        self._browser = self._pw = None

    def __enter__(self) -> "BrowserHost":
        return self.start()

    def __exit__(self, *exc) -> None:
        self.close()


class PlaywrightDriver:
    """单个会话（context + page）上的原语集合。"""

    def __init__(self, host: BrowserHost, base_url: str = "", *,
                 nav_timeout_ms: int | None = None, storage_state: Any = None):
        self.host = host
        self.base_url = (base_url or "").rstrip("/")
        self.nav_timeout_ms = nav_timeout_ms or host.nav_timeout_ms
        self._context = host._new_context(_load_state(storage_state))
        self._page = self._context.new_page()
        self._page.set_default_timeout(self.nav_timeout_ms)
        self._pending: set[Any] = set()
        self._done: list[dict] = []
        # 表头文本 → 列序号。只缓存"找到了"的结果：页面尚未渲染出表头时缓存了
        # "找不到"，后续等待会一直失败，而失败原因会指向"元素不存在"。
        self._column_cache: dict[str, int] = {}
        self._wire_network()

    # ---- 生命周期 --------------------------------------------------------
    def _wire_network(self) -> None:
        page = self._page

        def on_request(request):
            try:
                if request.url.split(":", 1)[0] in ("http", "https"):
                    self._pending.add(request)
            except Exception:
                pass

        def on_done(request):
            self._pending.discard(request)

        def on_response(response):
            try:
                request = response.request
                url = request.url
                if url.split(":", 1)[0] not in ("http", "https"):
                    return
                # 只留 METHOD + path：query 里的时间戳/签名每轮都不同，
                # 留着会让 request_done 的 pattern 永远匹配不上
                parsed = urlsplit(url)
                self._done.append({"method": request.method, "path": parsed.path or "/",
                                   "status": response.status if response else None})
            except Exception:
                pass

        page.on("request", on_request)
        page.on("requestfinished", on_done)
        page.on("requestfailed", on_done)
        page.on("response", on_response)

    def reset(self) -> None:
        """换一个干净 context：清 cookie / storage，页面回到未登录态。"""
        try:
            self._context.close()
        except Exception:
            pass
        self._context = self.host._new_context()
        self._page = self._context.new_page()
        self._page.set_default_timeout(self.nav_timeout_ms)
        self._pending.clear()
        self._done.clear()
        self._column_cache.clear()
        self._wire_network()

    def close(self) -> None:
        try:
            self._context.close()
        except Exception:
            pass
        self._page = None

    # ---- 地址 ------------------------------------------------------------
    def absolute(self, url_or_path: str) -> str:
        text = str(url_or_path)
        if text.startswith(("http://", "https://", "file://", "about:")):
            return text
        if not text.startswith("/"):
            text = "/" + text
        return f"{self.base_url}{text}"

    def url(self) -> str:
        return self._page.url if self._page else ""

    def open(self, url_or_path: str, timeout_ms: int | None = None) -> dict:
        target = self.absolute(url_or_path)
        # 换页即失效：不同页面的表头不同，沿用上一页的列序号会静默定位到错误的列
        self._column_cache.clear()
        try:
            self._page.goto(target, wait_until="domcontentloaded",
                            timeout=timeout_ms or self.nav_timeout_ms)
            return {"ok": True, "url": target}
        except Exception as error:
            return {"ok": False, "url": target, "error": f"{type(error).__name__}: {error}"}

    # ---- 定位 ------------------------------------------------------------
    def _locator(self, query: dict, base=None):
        """按查询描述构造 locator。

        `base` 用于**相对定位**：作用域内筛出的容器本身就是一个 locator，内层元素
        要相对它找。Playwright 的 `get_by_*` 在 Locator 上同样可用，所以十种策略
        都能相对容器解析，不需要退化成拼 CSS 字符串。
        """
        kind, value = query.get("kind"), query.get("value")
        page = base if base is not None else self._page
        if kind == "scoped":
            return self._scoped_locator(query, base)
        if kind == "testid":
            return page.get_by_test_id(value)
        if kind == "role":
            if query.get("name"):
                # exact=True：name 模糊匹配会把"登录"同时命中"登录中…"，制造假 ambiguous
                return page.get_by_role(value, name=query["name"], exact=True)
            return page.get_by_role(value)
        if kind == "label":
            return page.get_by_label(value, exact=True)
        if kind == "text":
            return page.get_by_text(value, exact=True)
        if kind == "placeholder":
            return page.get_by_placeholder(value, exact=True)
        if kind == "id":
            return page.locator(f"[id={_css_string(value)}]")
        if kind == "name":
            return page.locator(f"[name={_css_string(value)}]")
        if kind == "css":
            return page.locator(value)
        if kind == "alt":
            return page.locator(f"[alt={_css_string(value)}]")
        if kind == "title":
            return page.locator(f"[title={_css_string(value)}]")
        raise ValueError(f"不支持的定位类型：{kind}（locator.py 与驱动映射不同步）")

    def _scoped_locator(self, query: dict, base=None):
        """作用域定位：容器 → 按条件筛容器 → 容器内定位元素。

        筛选用 `filter(has=...)` 而不是把条件拼进 CSS：拼 CSS 的写法一旦被照抄，
        "第 3 列"这类位置耦合就会扩散；而这里列序号是**运行时**按表头文本解析的。
        """
        scope = query["scope"]
        container = self._locator(scope["container"], base=base)
        cell = scope.get("cell") or "td"
        for clause in scope.get("where") or []:
            if clause["kind"] == "text":
                container = container.filter(has_text=clause["text"])
                continue
            if clause["kind"] == "column":
                index = clause["index"]
            else:
                index = self._column_index(clause["name"])
                if not index:
                    raise ValueError(
                        f"表头里找不到列 {clause['name']!r}："
                        f"当前表头={self._header_texts()}"
                        f"（按语义定位失效说明页面改版或该页无表头，别退回写列序号）")
            inner = self._page.locator(f"{cell}:nth-child({index})").filter(
                has_text=clause["text"])
            container = container.filter(has=inner)
        if not query.get("inner"):
            # 没有内层指纹 = 要的就是筛出来的容器本身（"用户名列是探针账号的那一行"）
            return container
        return self._locator(query["inner"], base=container)

    def _header_texts(self) -> list[str]:
        try:
            cells = self._page.evaluate(
                """() => Array.from(document.querySelectorAll('thead th, .el-table__header th'))
                     .map(th => (th.innerText || th.textContent || '').replace(/\\s+/g, ' ').trim())
                     .filter(Boolean)"""
            )
            return list(cells or [])
        except Exception:
            return []

    def _column_index(self, name: str) -> int | None:
        """按表头文本解析列序号。命中了才缓存：找不到时要能在页面稍后渲染出来时重试。"""
        cached = self._column_cache.get(name)
        if cached:
            return cached
        for index, header in enumerate(self._header_texts(), 1):
            if name in header:
                self._column_cache[name] = index
                return index
        return None

    def counts(self, queries: list[dict]) -> list[int]:
        """按顺序返回每个指纹的命中数。查询失败按 0 计（元素不存在不是驱动故障）。"""
        results = []
        for query in queries:
            try:
                results.append(self._locator(query).count())
            except Exception:
                results.append(0)
        return results

    def probe(self, query: dict) -> dict:
        """一次取回单元素的全部可观测事实；多命中/未命中如实返回，不擅自取第一个。"""
        try:
            locator = self._locator(query)
            count = locator.count()
        except Exception as error:
            return {"ok": False, "count": 0, "error": f"{type(error).__name__}: {error}"}
        if count != 1:
            return {"ok": False, "count": count}
        element = locator.first
        info: dict = {"ok": True, "count": 1}
        for name, reader in (("visible", element.is_visible),
                             ("enabled", element.is_enabled),
                             ("text", lambda: element.inner_text()[:MAX_TEXT]),
                             ("value", lambda: self._read_value(element)),
                             ("box", element.bounding_box)):
            try:
                info[name] = reader()
            except Exception as error:
                info[name] = None
                info.setdefault("unreadable", {})[name] = f"{type(error).__name__}"
        return info

    @staticmethod
    def _read_value(element) -> Any:
        """读"当前值"，并对组件库的 select 做一次适配。

        为什么不能直接用 `input_value()`：Element Plus 的 `el-select` 内部是一个
        `readOnly` 的搜索框，选中后 `value` 始终是空串，真正的选中文本在
        `.el-select__tags-text` / `.el-select__selected-item` 里。直接读 value 的表现是
        "明明选了，断言却说没选"——而且这种失败会被记成产品缺陷。
        """
        return element.evaluate(
            """(node) => {
              const host = node.closest && node.closest('.el-select, .ant-select');
              if (host) {
                const shown = host.querySelector(
                  '.el-select__tags-text, .el-select__selected-item, .ant-select-selection-item');
                if (shown) {
                  const text = (shown.innerText || shown.textContent || '').trim();
                  if (text) return text;
                }
              }
              return node.value === undefined ? null : node.value;
            }"""
        )

    # ---- 动作 ------------------------------------------------------------
    ACTIONS = ("click", "fill", "press", "select", "hover", "scroll", "check", "uncheck")

    def act(self, kind: str, query: dict | None, *, value: str | None = None,
            key: str | None = None, timeout_ms: int | None = None) -> dict:
        """执行动作。失败是**正常结果**（元素被遮挡、只读），返回而不抛，由剧本层判。"""
        if kind not in self.ACTIONS:
            raise ValueError(f"动作不在封闭枚举内：{kind!r}（允许 {', '.join(self.ACTIONS)}）")
        timeout = timeout_ms or self.nav_timeout_ms
        try:
            if kind == "scroll" and query is None:
                self._page.mouse.wheel(0, int(value or 800))
                return {"ok": True}
            element = self._locator(query).first
            if kind == "click":
                element.click(timeout=timeout)
            elif kind == "fill":
                element.fill(str(value if value is not None else ""), timeout=timeout)
            elif kind == "press":
                element.press(key or "Enter", timeout=timeout)
            elif kind == "select":
                element.select_option(str(value), timeout=timeout)
            elif kind == "hover":
                element.hover(timeout=timeout)
            elif kind == "scroll":
                element.scroll_into_view_if_needed(timeout=timeout)
            elif kind == "check":
                element.check(timeout=timeout)
            elif kind == "uncheck":
                element.uncheck(timeout=timeout)
            return {"ok": True}
        except Exception as error:
            return {"ok": False, "error": f"{type(error).__name__}: {error}"}

    # ---- 网络观测（等待条件用）------------------------------------------
    def _pump(self) -> None:
        """让同步 API 派发已排队的事件。

        Playwright 的同步封装只在**发生一次 API 调用**时才处理协议消息，`page.on(...)`
        注册的回调也只在那个时候被调用。所以纯读自己维护的列表（完全不碰浏览器）永远
        读不到最新事件——表现是 request_done 的请求明明已经发出并返回，却一直等到超时。
        这里用一个最便宜的 evaluate 当泵，把队列里的回调推出来。
        """
        try:
            self._page.evaluate("() => 0")
        except Exception:
            pass

    def inflight(self) -> int:
        self._pump()
        return len(self._pending)

    def requests_seen(self) -> list[dict]:
        self._pump()
        return list(self._done)

    def clear_requests(self) -> None:
        self._done.clear()

    # ---- 页面级读取 ------------------------------------------------------
    def page_text(self) -> str:
        try:
            return (self._page.inner_text("body") or "")[:MAX_TEXT]
        except Exception:
            return ""

    def attribute(self, query: dict, name: str) -> str | None:
        try:
            return self._locator(query).first.get_attribute(name)
        except Exception:
            return None


def wait_until(predicate, timeout_ms: int, poll_ms: int = 100) -> dict:
    """通用轮询：返回是否满足 + 用时 + 末次观测。刻意不做 sleep-only 的兜底。

    predicate 返回 `{"ok": bool, ...}`；末次观测随结果一起带回，超时的排查才有料。
    """
    started = time.monotonic()
    deadline = started + max(timeout_ms, 0) / 1000.0
    attempts = 0
    while True:
        attempts += 1
        observed = predicate()
        elapsed = int((time.monotonic() - started) * 1000)
        if observed.get("ok"):
            return {"ok": True, "elapsed_ms": elapsed, "attempts": attempts,
                    "observed": observed}
        if time.monotonic() >= deadline:
            return {"ok": False, "elapsed_ms": elapsed, "attempts": attempts,
                    "observed": observed,
                    "reason": observed.get("reason") or "等待超时"}
        time.sleep(min(poll_ms / 1000.0, max(deadline - time.monotonic(), 0.001)))
