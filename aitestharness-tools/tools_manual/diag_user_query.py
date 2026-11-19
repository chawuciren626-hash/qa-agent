"""诊断：列表查询到底打哪个接口（只读）。

上一跑里 `request_done POST /userManage/page` 等 20s 没等到，说明接口路径与推断不符。
这里把"进页面""点查询"两次的网络记录都打出来，直接看真实路径。

同时输出：按用户名过滤后的行数与分页文案——
用来区分"账号确实不存在"与"过滤没生效、当前页里当然没有"。
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
USERNAME = sys.argv[1] if len(sys.argv) > 1 else "qa_probe_20261119"

STATE = """(username) => {
  const rows = Array.from(document.querySelectorAll('.el-table__body-wrapper tr.el-table__row'));
  const hit = rows.filter(tr => Array.from(tr.querySelectorAll('td'))
    .some(td => (td.innerText || '').trim() === username));
  const pager = document.querySelector('.el-pagination');
  return {
    rows: rows.length,
    matched: hit.length,
    cells: hit.map(tr => Array.from(tr.querySelectorAll('td')).map(td => (td.innerText || '').trim())),
    pager: pager ? (pager.innerText || '').replace(/\\n/g, ' ').slice(0, 80) : null,
    search_value: (document.querySelector('input[placeholder="输入用户名"]') || {}).value || null,
    empty_text: (document.querySelector('.el-table__empty-text') || {}).innerText || null,
  };
}"""


def main() -> int:
    if not os.path.exists(STATE_JSON):
        print("NO_SESSION", flush=True)
        return 2
    with BrowserHost() as host:
        driver = host.new_driver(BASE, storage_state=STATE_JSON)
        driver.open(TARGET_PATH)
        driver._page.wait_for_timeout(4000)
        if "/login" in driver.url():
            print("SESSION_EXPIRED", flush=True)
            return 3

        after_load = [(r["method"], r["path"]) for r in driver.requests_seen()]
        print("== 进页面后的请求 ==")
        for item in after_load:
            print("  ", item)
        print("state_before =", json.dumps(driver._page.evaluate(STATE, USERNAME), ensure_ascii=False), flush=True)

        driver.clear_requests()
        driver._page.get_by_placeholder("输入用户名", exact=True).fill(USERNAME)
        driver._page.get_by_role("button", name="查询").first.click()
        driver._page.wait_for_timeout(4000)
        after_query = [(r["method"], r["path"]) for r in driver.requests_seen()]
        print("== 点查询后的请求 ==")
        for item in after_query:
            print("  ", item)
        state_after = driver._page.evaluate(STATE, USERNAME)
        print("state_after =", json.dumps(state_after, ensure_ascii=False), flush=True)
        driver._page.screenshot(path=os.path.join(OUT, "diag-query.png"))
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
