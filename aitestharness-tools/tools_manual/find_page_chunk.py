"""在浏览器里就地检索：找到"用户管理"页面的 chunk，捞出创建/注销调的是什么接口。

为什么不用猜：创建与注销的接口路径决定了两件事——
  · 等待条件（`request_done` 的 pattern）能不能等到；
  · 以及"点了确认"到底打了后端还是只关了弹窗。
猜错的表现是：用例 pass，但数据其实没写进去（或没删掉）。

同源脚本可以在页面内 fetch，不需要落盘再 grep。
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
DUMP_JSON = os.path.join(OUT, "page-chunk-dump.json")

SCAN = """async (needles) => {
  // 路由页是动态 import 的 chunk：它不会出现在 <script src> 里，
  // 只会出现在性能资源表里。只扫 script 标签会扫到 0 命中，看起来像"代码里没这段"。
  const srcs = Array.from(new Set([
    ...Array.from(document.querySelectorAll('script[src]')).map(s => s.src),
    ...performance.getEntriesByType('resource')
      .map(e => e.name)
      .filter(n => n.indexOf('.js') >= 0),
  ]));
  const found = {};
  for (const src of srcs) {
    let text = '';
    try {
      const res = await fetch(src, {cache: 'force-cache'});
      text = await res.text();
    } catch (e) { continue; }
    for (const needle of needles) {
      if (!text.includes(needle)) continue;
      const at = text.indexOf(needle);
      found[needle] = found[needle] || [];
      found[needle].push({src: src.split('/').pop(), around: text.slice(Math.max(0, at - 260), at + 260)});
    }
  }
  return {scripts: srcs.length, found};
}"""


def main() -> int:
    if not os.path.exists(STATE_JSON):
        print("NO_SESSION", flush=True)
        return 2
    needles = ["确认要注销该账户", "createRegUser", "userLogout", "添加系统用户"]
    with BrowserHost() as host:
        driver = host.new_driver(BASE, storage_state=STATE_JSON)
        driver.open(TARGET_PATH)
        driver._page.wait_for_timeout(3000)
        if "/login" in driver.url():
            print("SESSION_EXPIRED", flush=True)
            return 3
        data = driver._page.evaluate(SCAN, needles)
    with open(DUMP_JSON, "w", encoding="utf-8") as handle:
        json.dump(data, handle, ensure_ascii=False, indent=2)
    print("scripts scanned =", data["scripts"])
    for needle, hits in (data["found"] or {}).items():
        print(f"\n## {needle}  ({len(hits)} hits)")
        for hit in hits[:2]:
            print("   chunk:", hit["src"])
            print("   ...", hit["around"].replace("\n", " ")[:420])
    missing = [n for n in needles if n not in (data["found"] or {})]
    print("\nmissing:", missing)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
