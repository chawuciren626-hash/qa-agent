"""P4 重放的固定数据集靶子：**确定性优先，仿真度其次**。

为什么自己起服务而不接真实环境
------------------------------
判据要的是"同样输入跑 N 次，结论一致"。真实环境每跑一次就脏一点，脏了以后就分不
清"结论变了"是产品改了还是数据变了——这恰恰是可比性链要消灭的那种不可归因。
靶子自己可控，才能把"内容漂移"与"结论漂移"分开：脚本连跑 5 轮时，任何一次结论
变化都只能来自执行链路本身。

三条刻意的确定性约束
--------------------
  1. **固定 token**：不按会话签发。签发时间/随机串会让每次响应不同，虽然断言不
     比这个值，但 evidence 一比就全是噪音；
  2. **固定订单号**：`POST /api/orders` 永远返回 2001，不递增。递增 id 等于每轮
     都换一份数据，"同一份数据跑 5 次"就不成立了；
  3. **固定金额**：99.0 / 128.5 写死，避免浮点或随机折扣引入抖动。

接口面（三条剧本各打一处，不多给）
----------------------------------
    POST /api/auth/login   正确凭据 → 200 {code:0, data:{token,user}}；错误 → 401 code=1001
    GET  /api/orders/<id>  无 Authorization → 401 code=401；有 → 200 {code:0, data:{...}}
    POST /api/orders       无 Authorization → 401 code=401；有 → 200 {code:0, data:{id:2001,...}}

用法：
    with MockService() as svc:
        run_plan(plan, svc.base_url, data={...})
"""
from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

__all__ = ["MockService", "FIXED_TOKEN", "FIXED_ORDER_ID", "ORDERS"]

FIXED_TOKEN = "tk-fixed-001"
FIXED_ORDER_ID = 2001

ORDERS = {
    1001: {"id": 1001, "amount": 128.5, "status": "paid"},
    FIXED_ORDER_ID: {"id": FIXED_ORDER_ID, "amount": 99.0, "status": "created"},
}


class _Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):            # 静音：5 轮 × 多条请求会把输出淹掉
        return

    def _json(self, code: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _authed(self) -> bool:
        return self.headers.get("authorization", "") == f"Bearer {FIXED_TOKEN}"

    def _body(self) -> dict:
        length = int(self.headers.get("content-length") or 0)
        raw = self.rfile.read(length) if length else b""
        try:
            parsed = json.loads(raw or b"{}")
        except ValueError:
            return {}
        return parsed if isinstance(parsed, dict) else {}

    def do_POST(self):
        # 先把请求体读干净再分支：HTTP/1.1 是长连接，没读掉的 body 会被当成
        # 下一个请求的起始行，报出来的错是"Bad request syntax" 400——
        # 一个与真实原因毫无关系的假失败，排查代价极高。这条坑踩过一次就够。
        payload = self._body()
        if self.path == "/api/auth/login":
            if payload.get("username") == "qa" and payload.get("password") == "qa-pass":
                return self._json(200, {"code": 0, "msg": "ok", "data": {
                    "token": FIXED_TOKEN,
                    "user": {"id": 7, "name": "qa"},
                }})
            # 故意区分 401 与业务失败：剧本要能断言"错密码不是 500"
            return self._json(401, {"code": 1001, "msg": "用户名或密码错误"})
        if self.path == "/api/orders":
            if not self._authed():
                return self._json(401, {"code": 401, "msg": "未登录"})
            return self._json(200, {"code": 0, "msg": "ok", "data": ORDERS[FIXED_ORDER_ID]})
        return self._json(404, {"code": 404, "msg": "not found"})

    def do_GET(self):
        if self.path.startswith("/api/orders/"):
            if not self._authed():
                return self._json(401, {"code": 401, "msg": "未登录"})
            try:
                order_id = int(self.path.rsplit("/", 1)[-1])
            except ValueError:
                return self._json(400, {"code": 400, "msg": "订单号非法"})
            order = ORDERS.get(order_id)
            if order is None:
                return self._json(404, {"code": 404, "msg": "订单不存在"})
            return self._json(200, {"code": 0, "msg": "ok", "data": order})
        return self._json(404, {"code": 404, "msg": "not found"})


class MockService:
    """起在随机空闲端口上的确定性 HTTP 靶子，支持上下文管理。"""

    def __init__(self) -> None:
        self._server = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
        self._server.daemon_threads = True
        self._thread: threading.Thread | None = None

    @property
    def base_url(self) -> str:
        host, port = self._server.server_address[:2]
        return f"http://{host}:{port}"

    def start(self) -> "MockService":
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
        self._thread.start()
        return self

    def stop(self) -> None:
        self._server.shutdown()
        self._server.server_close()
        if self._thread is not None:
            self._thread.join(timeout=5)

    def __enter__(self) -> "MockService":
        return self.start()

    def __exit__(self, *exc) -> None:
        self.stop()
