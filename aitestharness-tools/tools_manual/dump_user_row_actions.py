"""只读探测：用户列表的行结构、行内按钮、"更多"下拉菜单。

为什么要探这个：列表页的行操作里**没有"删除"**，只有 编辑信息/注销/锁定/编辑角色/重置密码。
"创建后清理"这条要求的可行性完全取决于：
  · 注销 = 软删（状态改成已注销、用户名仍占位）还是硬删？
  · "+5 更多" 里有没有藏删除/批量操作？

本脚本**不点任何会改变数据的按钮**：只看 DOM、只点 "+5 更多" 这种展开型控件，
展开后立刻 Escape。
"""
from __future__ import annotations

import json
import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from aitestharness_tools.exec.web_driver import BrowserHost

BASE = "https://local.console.gov-bid.com"
TARGET_PATH = "/bbiao-admin/system/user/index"
OUT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..",
                                   "output", "probe-bbiao-20261119"))
STATE_JSON = os.path.join(OUT, "session-state.json")
DUMP_JSON = os.path.join(OUT, "row-actions-dump.json")

ROW_SCAN = """() => {
  const rows = Array.from(document.querySelectorAll('.el-table__body-wrapper tr'));
  if (!rows.length) return {rows: 0};
  const first = rows[0];
  const cells = Array.from(first.querySelectorAll('td')).map(td => (td.innerText || '').trim());
  const buttons = Array.from(first.querySelectorAll('button')).map(b => ({
    text: (b.innerText || '').trim(),
    cls: (typeof b.className === 'string' ? b.className : '').slice(0, 80),
    aria: b.getAttribute('aria-label'),
    title: b.getAttribute('title'),
  }));
  return {
    rows: rows.length,
    row_class: first.className,
    cells: cells,
    buttons: buttons,
    has_more: buttons.some(b => b.text.indexOf('更多') >= 0),
    more_btn_cls: (buttons.find(b => b.text.indexOf('更多') >= 0) || {}).cls || null,
    row_html: first.outerHTML.slice(0, 2200),
  };
}"""

MENU_SCAN = """() => {
  const pops = Array.from(document.querySelectorAll(
    '.el-dropdown-menu, .el-popper, .el-menu--vertical'));
  return pops.filter(p => !!(p.offsetWidth || p.offsetHeight)).map(p => ({
    cls: (typeof p.className === 'string' ? p.className : '').slice(0, 90),
    items: Array.from(p.querySelectorAll('li, .el-dropdown-menu__item, button'))
      .map(el => (el.innerText || '').trim()).filter(Boolean),
  }));
}"""


def main() -> int:
    if not os.path.exists(STATE_JSON):
        print("NO_SESSION_STATE", flush=True)
        return 1
    result: dict = {}
    with BrowserHost() as host:
        driver = host.new_driver(BASE, storage_state=STATE_JSON)
        driver.open(TARGET_PATH)
        page = driver._page
        page.wait_for_timeout(3000)
        if "/login" in page.url:
            print("SESSION_EXPIRED", page.url, flush=True)
            return 2

        result["row"] = page.evaluate(ROW_SCAN)

        # 只展开"更多"，看里面有什么；展开后立刻关闭，不点任何项
        more = page.get_by_role("button", name="更多")
        if more.count():
            more.first.click()
            page.wait_for_timeout(600)
            result["menu"] = page.evaluate(MENU_SCAN)
            page.screenshot(path=os.path.join(OUT, "row-more-menu.png"))
            page.keyboard.press("Escape")
            page.wait_for_timeout(300)
        else:
            result["menu"] = []

        with open(DUMP_JSON, "w", encoding="utf-8") as handle:
            json.dump(result, handle, ensure_ascii=False, indent=2)

        row = result["row"]
        print("rows =", row.get("rows"), "| row_class =", row.get("row_class"))
        print("cells =", row.get("cells"))
        print("buttons =", json.dumps(row.get("buttons"), ensure_ascii=False))
        print("has_more =", row.get("has_more"), "| more_btn_cls =", row.get("more_btn_cls"))
        print("menu =", json.dumps(result["menu"], ensure_ascii=False))
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
