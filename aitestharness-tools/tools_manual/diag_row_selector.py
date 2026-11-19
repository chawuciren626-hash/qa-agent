"""测几种行作用域写法在真实表格上的命中数（只读）。

`td:text-is("x")` 在真实 DOM 上命中 0，说明这类"精确文本伪类"对含空白/Tab 的单元格
不成立。行作用域是清理步骤的安全边界，选错写法的后果不是"跑不过"，而是**可能点到
别人那一行**——所以必须实测出哪种写法真的只命中目标行，而不是找一种"看起来对"的。
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
USERNAME = "qa_probe_20261119"

CANDIDATES = [
    'tr.el-table__row:has(td:nth-child(3):has-text("qa_probe_20261119"))',
    'tr.el-table__row:has(td:nth-child(3):has-text("qa_probe_20261119")):has(td:nth-child(6):has-text("有效"))',
    'tr.el-table__row:has(td:has-text("qa_probe_20261119")):has(td:has-text("有效"))',
    'tr.el-table__row:has(td:has-text("sbkjadmin"))',
]

CANCEL = [
    'tr.el-table__row:has(td:has-text("qa_probe_20261119")) >> button:has-text("注销")',
    'tr.el-table__row:has(td:has-text("qa_probe_20261119")) >> role=button[name="注销"]',
    'tr.el-table__row:has-text("qa_probe_20261119") >> button:has-text("注销")',
]


def main() -> int:
    if not os.path.exists(STATE_JSON):
        print("NO_SESSION", flush=True)
        return 2
    result = {}
    with BrowserHost() as host:
        driver = host.new_driver(BASE, storage_state=STATE_JSON)
        driver.open(TARGET_PATH)
        page = driver._page
        page.wait_for_timeout(4000)
        if "/login" in driver.url():
            print("SESSION_EXPIRED", flush=True)
            return 3
        page.get_by_placeholder("输入用户名", exact=True).fill(USERNAME)
        page.get_by_role("button", name="查询").first.click()
        page.wait_for_timeout(3000)

        for selector in CANDIDATES + CANCEL:
            try:
                count = page.locator(selector).count()
            except Exception as error:
                count = f"ERR {type(error).__name__}: {str(error)[:80]}"
            result[selector] = count
            print(f"{count!s:>6}  {selector}")

        # 行内 td 的真实文本（带不可见字符时，精确匹配就会失效）
        result["cells_raw"] = page.evaluate(
            """() => {
              const tr = document.querySelector('.el-table__body-wrapper tr.el-table__row');
              return tr ? Array.from(tr.querySelectorAll('td')).map(td => JSON.stringify(td.innerText)) : null;
            }""")
        print("cells_raw =", json.dumps(result["cells_raw"], ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
