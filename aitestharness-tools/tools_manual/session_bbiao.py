"""bbiao-admin 会话建立 + 目标页控件采集（只读，不做任何写操作）。

设计要点：
  - 验证码是随机算术图，只在这一个环节需要视觉判断，之后全部复用 storageState；
  - 先填账号密码、再刷新验证码、再截图，把"截图到提交"的间隔压到最短；
  - 答案通过文件轮询传入，脚本本身不含任何凭据；
  - 登录成功后先验证会话可用（直接跳目标页），再采集控件指纹；
  - 只打开"添加用户"弹窗采集控件，**不填不提交**。

用法：
  AITH_SUT_USERNAME=... AITH_SUT_PASSWORD=... python tools_manual/session_bbiao.py
  脚本会在验证码就绪后打印 CAPTCHA_READY 并等待 answer.txt。
"""
from __future__ import annotations

import json
import os
import sys
import time

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from aitestharness_tools.exec.web_driver import BrowserHost

BASE = "https://local.console.gov-bid.com"
LOGIN_PATH = "/bbiao-admin/login"
TARGET_PATH = "/bbiao-admin/system/user/index"
OUT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "output", "probe-bbiao-20261119"))
CAPTCHA_PNG = os.path.join(OUT, "captcha-live.png")
ANSWER_TXT = os.path.join(OUT, "answer.txt")
STATE_JSON = os.path.join(OUT, "session-state.json")
RESULT_JSON = os.path.join(OUT, "session-result.json")
PAGE_JSON = os.path.join(OUT, "target-page.json")

USER_SEL = "input[placeholder='用户名']"
PASS_SEL = "input[placeholder='密码']"
CODE_SEL = "input[placeholder='验证码']"
SUBMIT_SEL = "button.el-button--primary"


def main() -> int:
    os.makedirs(OUT, exist_ok=True)
    for path in (ANSWER_TXT, RESULT_JSON, PAGE_JSON):
        if os.path.exists(path):
            os.remove(path)

    username = os.environ.get("AITH_SUT_USERNAME") or ""
    password = os.environ.get("AITH_SUT_PASSWORD") or ""
    if not username or not password:
        _write(RESULT_JSON, {"ok": False, "stage": "missing_credentials"})
        return 4

    with BrowserHost() as host:
        driver = host.new_driver(BASE)
        if not driver.open(LOGIN_PATH).get("ok"):
            _write(RESULT_JSON, {"ok": False, "stage": "open"})
            return 1
        page = driver._page
        page.wait_for_selector(CODE_SEL, timeout=25000)
        page.wait_for_timeout(1200)

        page.fill(USER_SEL, username)
        page.fill(PASS_SEL, password)

        # 刷新验证码，保证截图即提交时仍在有效期内
        captcha_img = _captcha_image(page)
        captcha_img.click()
        page.wait_for_timeout(900)
        captcha_img.screenshot(path=CAPTCHA_PNG)
        shot_at = time.time()
        print("CAPTCHA_READY", CAPTCHA_PNG, flush=True)

        answer = _wait_answer(timeout_s=180)
        if not answer:
            _write(RESULT_JSON, {"ok": False, "stage": "captcha_timeout"})
            return 2
        waited = time.time() - shot_at
        print(f"GOT_ANSWER {answer} after {waited:.1f}s", flush=True)

        page.fill(CODE_SEL, answer)

        captured: list[dict] = []

        def on_response(response):
            url = response.url
            if "login" in url.lower() or "captcha" in url.lower():
                try:
                    body = response.text()[:400]
                except Exception:
                    body = "<unreadable>"
                captured.append({"url": url.split("?")[0], "status": response.status, "body": body})

        page.on("response", on_response)
        page.click(SUBMIT_SEL)

        landed = False
        deadline = time.time() + 25
        while time.time() < deadline:
            page.wait_for_timeout(350)
            if "/login" not in page.url:
                landed = True
                break
        page.wait_for_timeout(1500)

        payload: dict = {
            "ok": landed, "stage": "submit", "answer": answer,
            "waited_s": round(waited, 1), "final_url": page.url, "title": page.title(),
            "responses": captured,
        }
        if not landed:
            payload["body_text"] = (page.inner_text("body") or "")[:300]
            payload["messages"] = page.evaluate(
                "() => Array.from(document.querySelectorAll('.el-message,.el-form-item__error'))"
                ".map(e => (e.innerText||'').trim()).filter(Boolean)")
            _write(RESULT_JSON, payload)
            print("RESULT", json.dumps(payload, ensure_ascii=False)[:700], flush=True)
            return 3

        state = page.context.storage_state()
        with open(STATE_JSON, "w", encoding="utf-8") as handle:
            json.dump(state, handle, ensure_ascii=False, indent=2)
        payload["state_summary"] = {
            "cookies": len(state.get("cookies") or []),
            "local_keys": [[k.get("name") for k in (o.get("localStorage") or [])]
                           for o in (state.get("origins") or [])],
        }
        print("LOGIN_OK", flush=True)

        # ---- 会话可用性验证：直接跳目标页，看是否被踢回登录 ----
        driver.open(TARGET_PATH)
        page = driver._page
        page.wait_for_timeout(3500)
        url = page.url
        payload["target_url"] = url
        payload["target_title"] = page.title()
        payload["session_valid"] = "/login" not in url

        if not payload["session_valid"]:
            _write(RESULT_JSON, payload)
            print("RESULT", json.dumps(payload, ensure_ascii=False)[:700], flush=True)
            return 5

        page.screenshot(path=os.path.join(OUT, "target.png"))
        page_dump = _dump_page(page)
        _write(PAGE_JSON, page_dump)
        payload["page"] = {"text": page_dump["text"][:300],
                           "inputs": len(page_dump["inputs"]),
                           "buttons": len(page_dump["buttons"])}

        # ---- 只打开"添加用户"弹窗，采集控件，不填不提交 ----
        dialog = _open_add_dialog(page)
        payload["dialog"] = dialog
        _write(RESULT_JSON, payload)
        print("RESULT", json.dumps(payload, ensure_ascii=False)[:1200], flush=True)
        return 0


def _captcha_image(page):
    return page.locator(CODE_SEL).locator(
        "xpath=ancestor::div[contains(@class,'el-form-item')]//img").first


def _wait_answer(timeout_s: int) -> str:
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        if os.path.exists(ANSWER_TXT):
            text = open(ANSWER_TXT, encoding="utf-8").read().strip()
            if text:
                return text
        time.sleep(0.2)
    return ""


def _dump_page(page) -> dict:
    return page.evaluate(
        """() => {
          const pick = (el) => ({
            tag: el.tagName.toLowerCase(),
            type: el.type || null,
            ph: el.placeholder || null,
            cls: (typeof el.className === 'string' ? el.className : '').slice(0, 80),
            text: (el.innerText || el.value || '').trim().slice(0, 30),
            aria: el.getAttribute('aria-label'),
            label: (() => {
              const item = el.closest('.el-form-item, .el-form-item--default');
              if (!item) return null;
              const lab = item.querySelector('.el-form-item__label');
              return lab ? lab.innerText.trim() : null;
            })(),
          });
          return {
            text: (document.body.innerText || '').replace(/\\n{2,}/g, '\\n').slice(0, 2500),
            inputs: Array.from(document.querySelectorAll('input,textarea,select')).map(pick),
            buttons: Array.from(document.querySelectorAll('button,.el-button')).map(pick),
            tables: Array.from(document.querySelectorAll('table')).length,
          };
        }""")


def _open_add_dialog(page) -> dict:
    """点击"添加用户"，采集弹窗控件。刻意不填写、不提交。"""
    clicked = False
    for name in ("添加用户", "新增用户", "添加"):
        locator = page.get_by_role("button", name=name)
        if locator.count() > 0:
            locator.first.click()
            clicked = True
            break
    if not clicked:
        return {"opened": False, "reason": "未找到添加用户按钮"}

    page.wait_for_timeout(1800)
    page.screenshot(path=os.path.join(OUT, "dialog.png"))
    dump = page.evaluate(
        """() => {
          const dlg = document.querySelector('.el-dialog, .el-drawer, [role=dialog]');
          if (!dlg) return {found: false};
          const pick = (el) => {
            const item = el.closest('.el-form-item');
            const lab = item ? item.querySelector('.el-form-item__label') : null;
            return {
              tag: el.tagName.toLowerCase(),
              type: el.type || null,
              ph: el.placeholder || null,
              label: lab ? lab.innerText.trim() : null,
              required: item ? item.classList.contains('is-required') : null,
              cls: (typeof el.className === 'string' ? el.className : '').slice(0, 60),
            };
          };
          return {
            found: true,
            title: (dlg.querySelector('.el-dialog__title, .el-drawer__title') || {}).innerText || null,
            text: (dlg.innerText || '').slice(0, 1200),
            inputs: Array.from(dlg.querySelectorAll('input,textarea')).map(pick),
            selects: Array.from(dlg.querySelectorAll('.el-select')).map(pick),
            buttons: Array.from(dlg.querySelectorAll('button')).map(b => (b.innerText||'').trim()),
          };
        }""")
    return {"opened": True, **dump}


def _write(path: str, payload: dict) -> None:
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)


if __name__ == "__main__":
    raise SystemExit(main())
