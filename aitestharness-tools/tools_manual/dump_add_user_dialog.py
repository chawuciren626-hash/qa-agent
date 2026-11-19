"""复用会话采集「添加用户」弹窗的真实控件指纹（只读，不填写不提交）。

上一轮用 `.el-dialog` 容器没抓到内容：该弹窗不是标准 el-dialog 结构。
本轮改为"从标题文本反找容器"，并对整个可见 overlay 做控件 dump。

同时采集：列表页的查询区控件、分页控件、表格首行的操作按钮，
因为一条完整的"添加用户"用例需要先确认新增的数据能出现在列表里。
"""
from __future__ import annotations

import json
import os
import sys
import time

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from aitestharness_tools.exec.web_driver import BrowserHost

BASE = "https://local.console.gov-bid.com"
TARGET_PATH = "/bbiao-admin/system/user/index"
OUT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "output", "probe-bbiao-20261119"))
STATE_JSON = os.path.join(OUT, "session-state.json")
DUMP_JSON = os.path.join(OUT, "ui-dump.json")

PICK = """(el) => {
  const item = el.closest('.el-form-item');
  const lab = item ? item.querySelector('.el-form-item__label') : null;
  const wrapper = el.closest('.el-input, .el-select, .el-textarea');
  return {
    tag: el.tagName.toLowerCase(),
    type: el.type || null,
    ph: el.placeholder || null,
    label: lab ? lab.innerText.trim() : null,
    required: item ? item.classList.contains('is-required') : null,
    cls: (typeof el.className === 'string' ? el.className : '').slice(0, 70),
    value: (el.value || '').slice(0, 40),
    id: el.id || null,
    visible: !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length),
  };
}"""


def main() -> int:
    if not os.path.exists(STATE_JSON):
        print("NO_SESSION_STATE", flush=True)
        return 1

    with BrowserHost() as host:
        driver = host.new_driver(BASE, storage_state=STATE_JSON)
        driver.open(TARGET_PATH)
        page = driver._page
        page.wait_for_timeout(3500)
        if "/login" in page.url:
            print("SESSION_EXPIRED", page.url, flush=True)
            return 2

        result: dict = {"url": page.url, "title": page.title()}

        # ---- 列表页控件 ----
        result["list_page"] = page.evaluate(
            """(pickSrc) => {
              const pick = eval('(' + pickSrc + ')');
              return {
                inputs: Array.from(document.querySelectorAll('input,textarea')).map(pick).filter(x => x.visible),
                buttons: Array.from(document.querySelectorAll('button')).map(b => (b.innerText||'').trim()).filter(Boolean),
                pagination: (document.querySelector('.el-pagination') || {}).innerText || null,
                table_headers: Array.from(document.querySelectorAll('.el-table__header th')).map(t => (t.innerText||'').trim()).filter(Boolean),
                row_actions: Array.from(document.querySelectorAll('.el-table__body tr')).slice(0,1)
                  .flatMap(tr => Array.from(tr.querySelectorAll('button,.el-button')).map(b => (b.innerText||'').trim()).filter(Boolean)),
              };
            }""", PICK)

        # ---- 打开添加用户弹窗 ----
        page.get_by_role("button", name="添加用户").first.click()
        page.wait_for_timeout(2200)
        page.screenshot(path=os.path.join(OUT, "dialog2.png"))

        result["dialog"] = page.evaluate(
            """(pickSrc) => {
              const pick = eval('(' + pickSrc + ')');
              const all = Array.from(document.querySelectorAll('input,textarea'));
              // 找一个"看起来是弹窗"的容器：包含可见输入框、且不是整页
              const boxes = Array.from(document.querySelectorAll('div'))
                .filter(d => {
                  const t = d.innerText || '';
                  return t.indexOf('添加系统用户') === 0 || t.indexOf('添加系统用户') > -1;
                })
                .sort((a, b) => (a.innerText || '').length - (b.innerText || '').length);
              const box = boxes[0] || null;
              const scoped = box ? Array.from(box.querySelectorAll('input,textarea')) : [];
              return {
                container_found: !!box,
                container_cls: box ? (typeof box.className === 'string' ? box.className : '') : null,
                title_text: box ? (box.innerText || '').slice(0, 120) : null,
                inputs_in_container: scoped.map(pick),
                inputs_all_visible: all.map(pick).filter(x => x.visible),
                buttons: box ? Array.from(box.querySelectorAll('button')).map(b => (b.innerText||'').trim()).filter(Boolean) : [],
                tabs: Array.from(document.querySelectorAll('.el-tabs__item, .el-radio-button')).map(t => (t.innerText||'').trim()).filter(Boolean),
                selects: box ? Array.from(box.querySelectorAll('.el-select')).length : 0,
              };
            }""", PICK)

        with open(DUMP_JSON, "w", encoding="utf-8") as handle:
            json.dump(result, handle, ensure_ascii=False, indent=2)

        print("url =", result["url"])
        print("list inputs:", [(i["label"], i["ph"]) for i in result["list_page"]["inputs"]])
        print("list buttons:", result["list_page"]["buttons"])
        print("table headers:", result["list_page"]["table_headers"])
        print("pagination:", (result["list_page"]["pagination"] or "")[:80].replace("\n", " "))
        dialog = result["dialog"]
        print("dialog container_found =", dialog["container_found"], "| cls =", dialog["container_cls"])
        print("dialog tabs =", dialog["tabs"])
        print("dialog buttons =", dialog["buttons"])
        for item in dialog["inputs_in_container"]:
            print("  D-INPUT", json.dumps(item, ensure_ascii=False))
        print("inputs_all_visible =", len(dialog["inputs_all_visible"]))
        for item in dialog["inputs_all_visible"]:
            print("  ALL-INPUT", json.dumps(item, ensure_ascii=False))
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
