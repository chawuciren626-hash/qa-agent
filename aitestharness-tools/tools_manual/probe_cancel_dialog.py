"""零风险探测：注销的确认框长什么样。

为什么需要这一步：行内操作没有"删除"，只有 注销/锁定/重置密码，而"创建后清理"要靠注销。
确认框的容器类名、按钮文案、是否二次输入密码，这些**猜错的代价是清理静默失败**
（账号留在真实系统里，报告却显示 pass）。

安全设计（重点）：
  1. `page.route("**/*")` 拦截**所有**发往后端主机的请求并 `abort()`——
     即使"注销"是即点即生效、没有确认框，服务端也收不到任何东西；
  2. 挑一行**不是当前登录账号**（避免万一前端自己清了 token，登录要过算术验证码）；
  3. 点完之后：取消/关闭弹层，重新查一次列表，**逐字比对那一行的单元格**，
     证明没有动过任何数据；
  4. 全程记录被阻断的请求清单，作为"没打后端"的证据。
"""
from __future__ import annotations

import json
import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from aitestharness_tools.exec.web_driver import BrowserHost

BASE = os.environ.get("AITH_SUT_BASE", "https://local.console.gov-bid.com").rstrip("/")
TARGET_PATH = "/bbiao-admin/system/user/index"
OUT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..",
                                   "output", "probe-bbiao-20261119"))
STATE_JSON = os.path.join(OUT, "session-state.json")
DUMP_JSON = os.path.join(OUT, "cancel-dialog-dump.json")

API_HOSTS = ("dev.api.v2.gov-bid.com", "/bbiao-backend")

ROWS = """() => Array.from(document.querySelectorAll('.el-table__body-wrapper tr.el-table__row'))
  .map((tr, i) => ({
    index: i,
    cells: Array.from(tr.querySelectorAll('td')).map(td => (td.innerText || '').trim()),
    buttons: Array.from(tr.querySelectorAll('button')).map(b => (b.innerText || '').trim()),
  }))"""

DIALOG = """() => {
  const nodes = Array.from(document.querySelectorAll(
    '.el-message-box, .el-dialog, .el-overlay-message-box, .el-popconfirm'));
  return nodes.filter(n => n.offsetWidth || n.offsetHeight).map(n => ({
    cls: (typeof n.className === 'string' ? n.className : '').slice(0, 140),
    text: (n.innerText || '').trim().slice(0, 300),
    buttons: Array.from(n.querySelectorAll('button')).map(b => ({
      text: (b.innerText || '').trim(),
      cls: (typeof b.className === 'string' ? b.className : '').slice(0, 90),
    })),
    inputs: Array.from(n.querySelectorAll('input')).map(i => ({
      ph: i.placeholder || null, type: i.type, cls: (typeof i.className === 'string' ? i.className : '').slice(0, 60),
    })),
  }));
}"""


def main() -> int:
    if not os.path.exists(STATE_JSON):
        print("NO_SESSION", flush=True)
        return 2
    result: dict = {}
    blocked: list[str] = []

    with BrowserHost() as host:
        driver = host.new_driver(BASE, storage_state=STATE_JSON)
        page = driver._page

        def guard(route, request):
            url = request.url
            if any(host_ in url for host_ in API_HOSTS):
                blocked.append(f"{request.method} {url.split('?')[0]}")
                route.abort()
            else:
                route.continue_()

        driver.open(TARGET_PATH)
        page.wait_for_timeout(3500)
        if "/login" in page.url:
            print("SESSION_EXPIRED", page.url, flush=True)
            return 3

        # 先让页面把列表接口正常打完，再装拦截——否则列表自己是空的，
        # 探测的不是"注销点了会怎样"，而是"表格没数据"
        page.unroute("**/*")
        page.route("**/*", guard)

        before = page.evaluate(ROWS)
        result["rows_before"] = before
        # 选一行不是当前登录账号的（登录账号是 zdxadmin，选别的行）
        target_index = next((r["index"] for r in before
                             if r["cells"][2] not in ("zdxadmin",) and "注销" in r["buttons"]), None)
        if target_index is None:
            print("NO_SAFE_ROW rows =", len(before), flush=True)
            for item in before[:3]:
                print("   row", item["index"], item["cells"], item["buttons"], flush=True)
            return 4
        row = before[target_index]
        result["target_row"] = row
        print("probe row =", row["cells"], flush=True)

        page.locator('.el-table__body-wrapper tr.el-table__row').nth(target_index) \
            .get_by_role("button", name="注销").first.click()
        page.wait_for_timeout(1500)
        result["dialog"] = page.evaluate(DIALOG)
        page.screenshot(path=os.path.join(OUT, "cancel-dialog.png"))
        print("dialog =", json.dumps(result["dialog"], ensure_ascii=False), flush=True)

        # 关闭：优先"取消"，否则 Escape
        closed_by = None
        for name in ("取消", "关闭"):
            button = page.get_by_role("button", name=name)
            if button.count():
                button.first.click()
                closed_by = name
                break
        if closed_by is None:
            page.keyboard.press("Escape")
            closed_by = "Escape"
        page.wait_for_timeout(1200)
        result["closed_by"] = closed_by
        result["dialog_after_close"] = page.evaluate(DIALOG)

        # 复核：先拆掉拦截再刷新，否则列表接口同样被 abort，复核会变成"0 行"
        page.unroute("**/*")
        driver.open(TARGET_PATH)
        page.wait_for_timeout(3000)
        after = page.evaluate(ROWS)
        same_row = next((r for r in after if r["cells"][2] == row["cells"][2]), None)
        result["rows_after_count"] = len(after)
        result["row_after"] = same_row
        result["row_unchanged"] = bool(same_row and same_row["cells"] == row["cells"])
        blocked_unique = sorted(set(blocked))
        result["blocked_requests"] = blocked_unique
        result["blocked_count"] = len(blocked)

        with open(DUMP_JSON, "w", encoding="utf-8") as handle:
            json.dump(result, handle, ensure_ascii=False, indent=2)

        print("closed_by =", closed_by, flush=True)
        print("row_unchanged =", result["row_unchanged"], "| row_after =",
              (same_row or {}).get("cells"), flush=True)
        print("blocked requests =", len(blocked), "unique", len(blocked_unique), flush=True)
        for item in blocked_unique[:12]:
            print("   BLOCKED", item, flush=True)
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
