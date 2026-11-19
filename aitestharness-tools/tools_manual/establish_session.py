"""一次性建立登录会话并持久化 storageState。

验证码是随机算术图，登录环节天然不可确定性自动化。本脚本的做法：
  1 打开登录页，把验证码截图落盘；
  2 轮询 answer.txt 等待答案（供外部视觉/人工填入）；
  3 填表提交，等跳转成功；
  4 把 storageState 落盘，后续剧本全部复用，不再碰验证码。

用法：后台启动本脚本 → 读 captcha-live.png → 写 answer.txt → 脚本自行继续。
"""
from __future__ import annotations

import json
import os
import sys
import time

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from aitestharness_tools.exec.web_driver import BrowserHost

BASE = os.environ.get("AITH_SUT_BASE", "https://local.console.gov-bid.com").rstrip("/")
LOGIN_PATH = "/gateway-admin/login"
OUT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "output", "probe-20261119"))
CAPTCHA_PNG = os.path.join(OUT, "captcha-live.png")
ANSWER_TXT = os.path.join(OUT, "answer.txt")
STATE_JSON = os.path.join(OUT, "session-state.json")
RESULT_JSON = os.path.join(OUT, "session-result.json")


def main() -> int:
    os.makedirs(OUT, exist_ok=True)
    for path in (ANSWER_TXT, RESULT_JSON):
        if os.path.exists(path):
            os.remove(path)

    with BrowserHost() as host:
        driver = host.new_driver(BASE)
        opened = driver.open(LOGIN_PATH)
        if not opened.get("ok"):
            _write(RESULT_JSON, {"ok": False, "stage": "open", "detail": opened})
            return 1
        page = driver._page
        page.wait_for_selector("img.captcha-img", timeout=20000)
        page.wait_for_timeout(1200)

        page.locator("img.captcha-img").screenshot(path=CAPTCHA_PNG)
        print("CAPTCHA_READY", CAPTCHA_PNG, flush=True)

        answer = _wait_answer(timeout_s=240)
        if not answer:
            _write(RESULT_JSON, {"ok": False, "stage": "captcha_timeout"})
            return 2
        print("GOT_ANSWER", answer, flush=True)

        # 凭据只从环境变量取，不落仓库
        username = os.environ.get("AITH_SUT_USERNAME") or ""
        password = os.environ.get("AITH_SUT_PASSWORD") or ""
        if not username or not password:
            _write(RESULT_JSON, {"ok": False, "stage": "missing_credentials",
                                 "detail": "需要设置 AITH_SUT_USERNAME / AITH_SUT_PASSWORD"})
            return 4
        page.fill("input[placeholder='请输入用户名']", username)
        page.fill("input[placeholder='请输入密码']", password)
        page.fill("input[placeholder='请输入验证码']", answer)

        # 先记一份登录接口响应，便于判定成功与否到底卡在哪一层
        responses: list[dict] = []

        def on_response(response):
            try:
                url = response.url
                if "login" in url or "captcha" in url:
                    body = ""
                    try:
                        body = response.text()[:300]
                    except Exception:
                        body = "<unreadable>"
                    responses.append({"url": url.split("?")[0], "status": response.status,
                                      "body": body})
            except Exception:
                pass

        page.on("response", on_response)
        page.click("button.login-btn")

        deadline = time.time() + 25
        landed = False
        while time.time() < deadline:
            page.wait_for_timeout(400)
            url = page.url
            if LOGIN_PATH not in url and "/login" not in url:
                landed = True
                break
        page.wait_for_timeout(1500)

        payload = {
            "ok": landed,
            "stage": "submit",
            "answer": answer,
            "final_url": page.url,
            "title": page.title(),
            "responses": responses,
        }
        if landed:
            state = page.context.storage_state()
            with open(STATE_JSON, "w", encoding="utf-8") as handle:
                json.dump(state, handle, ensure_ascii=False, indent=2)
            payload["storage_state"] = STATE_JSON
            payload["state_summary"] = {
                "cookies": len(state.get("cookies") or []),
                "origins": [o.get("origin") for o in (state.get("origins") or [])],
                "local_keys": [
                    [k.get("name") for k in (o.get("localStorage") or [])]
                    for o in (state.get("origins") or [])
                ],
            }
        else:
            payload["body_text"] = (page.inner_text("body") or "")[:400]
        _write(RESULT_JSON, payload)
        print("RESULT", json.dumps(payload, ensure_ascii=False)[:800], flush=True)
        return 0 if landed else 3


def _wait_answer(timeout_s: int) -> str:
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        if os.path.exists(ANSWER_TXT):
            text = open(ANSWER_TXT, encoding="utf-8").read().strip()
            if text:
                return text
        time.sleep(0.4)
    return ""


def _write(path: str, payload: dict) -> None:
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)


if __name__ == "__main__":
    raise SystemExit(main())
