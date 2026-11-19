"""P4 Web 重放的固定数据集靶站：**确定性优先，仿真度其次**。

与 `mock_service.py`（纯 API 靶子）的分工
------------------------------------------
API 靶子只能验证"执行链路对 HTTP 的编排"；Web 靶子要验证的是另一层东西：定位是否
唯一、等待条件是否真的等到了、动作之后页面有没有变成预期状态。所以它必须有真实
DOM、真实导航、真实 XHR——这三样缺一个，`click` + `element_visible` + `request_done`
那套东西就等于没测。

刻意的确定性约束（与 API 靶子同一套理由）
------------------------------------------
  1. **固定 token**：`tk-fixed-001`，不按会话签发，sessionStorage 里也就没有随机串；
  2. **固定订单号**：`POST /api/orders` 永远返回 2001，不递增；页面本地追加一行，
     刷新即回到 2 行——每轮重放的起始页面逐字相同；
  3. **固定金额与状态**：99.00 / created 写死；
  4. **无时间戳、无随机数**：页面渲染不读 `Date`，避免文本断言每轮差一个字符。

路由
----
    GET  /  /login  /orders   → index.html（路径路由，前端按 pathname 分视图）
    POST /api/auth/login      正确凭据 200 {code:0,data:{token}}；错误 401 code=1001
    GET  /api/orders          无 Bearer → 401；有 → 200 两条固定订单
    POST /api/orders          无 Bearer → 401；有 → 200 返回固定订单 2001

用法：
    with WebTarget() as site:
        WebEngine(driver, data).run_plan(plan)   # driver 的 base_url = site.base_url
"""
from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

__all__ = ["WebTarget", "FIXED_TOKEN", "FIXED_ORDER_ID", "SEED_ORDERS", "SITE_DIR"]

FIXED_TOKEN = "tk-fixed-001"
FIXED_ORDER_ID = 2001
SEED_ORDERS = (
    {"id": 1001, "amount": "128.50", "status": "paid"},
    {"id": 1002, "amount": "66.00", "status": "created"},
)
SITE_DIR = Path(__file__).resolve().parent / "fixtures" / "web"
_PAGE_ROUTES = ("/", "/login", "/orders", "/index.html")


class _Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    # ---- 基础 ------------------------------------------------------------
    def _json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _body(self) -> dict:
        """必须把请求体读干净（哪怕不用）：残留字节会被 keep-alive 当成下个请求的起始行。"""
        length = int(self.headers.get("content-length") or 0)
        raw = self.rfile.read(length) if length else b""
        if not raw:
            return {}
        try:
            return json.loads(raw.decode("utf-8"))
        except ValueError:
            return {}

    def _authed(self) -> bool:
        header = self.headers.get("authorization") or ""
        return header.strip() == f"Bearer {FIXED_TOKEN}"

    def _page(self) -> None:
        try:
            body = (SITE_DIR / "index.html").read_bytes()
        except OSError as error:
            return self._json(500, {"code": 500, "msg": f"靶站文件缺失：{error}"})
        self.send_response(200)
        self.send_header("content-type", "text/html; charset=utf-8")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args) -> None:      # 静音：靶站的访问日志只会污染测试输出
        return

    # ---- 路由 ------------------------------------------------------------
    def do_GET(self) -> None:
        path = self.path.split("?")[0]
        if path in _PAGE_ROUTES:
            return self._page()
        # 详情页与列表页共用同一份 SPA 文件（前端按 pathname 分视图）
        if path.startswith("/orders/"):
            return self._page()
        if path == "/api/orders":
            if not self._authed():
                return self._json(401, {"code": 401, "msg": "未登录"})
            return self._json(200, {"code": 0, "msg": "ok",
                                    "data": {"orders": list(SEED_ORDERS)}})
        return self._json(404, {"code": 404, "msg": "not found"})

    def do_POST(self) -> None:
        path = self.path.split("?")[0]
        payload = self._body()
        if path == "/api/auth/login":
            if payload.get("username") == "qa" and payload.get("password") == "qa-pass":
                return self._json(200, {"code": 0, "msg": "ok",
                                        "data": {"token": FIXED_TOKEN,
                                                 "user": {"id": 7, "name": "qa"}}})
            return self._json(401, {"code": 1001, "msg": "用户名或密码错误"})
        if path == "/api/orders":
            if not self._authed():
                return self._json(401, {"code": 401, "msg": "未登录"})
            return self._json(200, {"code": 0, "msg": "ok",
                                    "data": {"id": FIXED_ORDER_ID, "amount": "99.00",
                                             "status": "created"}})
        return self._json(404, {"code": 404, "msg": "not found"})


class WebTarget:
    """本地静态站 + 固定接口。可以当上下文管理器用。"""

    def __init__(self, host: str = "127.0.0.1", port: int = 0):
        self._server = ThreadingHTTPServer((host, port), _Handler)
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)

    @property
    def base_url(self) -> str:
        host, port = self._server.server_address[:2]
        return f"http://{host}:{port}"

    def start(self) -> "WebTarget":
        self._thread.start()
        return self

    def stop(self) -> None:
        self._server.shutdown()
        self._server.server_close()
        self._thread.join(timeout=5)

    def __enter__(self) -> "WebTarget":
        return self.start()

    def __exit__(self, *exc) -> None:
        self.stop()
