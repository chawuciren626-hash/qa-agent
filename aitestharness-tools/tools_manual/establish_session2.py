"""登录重试：压缩"截图 → 答案 → 提交"的间隔，避免验证码过期。

上一轮失败的可疑原因：验证码从截图到提交间隔近 60s，超时后服务端统一返回
"用户名或密码错误"（安全实践里验证码错误常被模糊化以阻断爆破）。
本轮做法：先点图刷新拿新鲜验证码 → 立即截图 → 外部给答案 → 立即提交。
"""
from __future__ import annotations

import json
import os
import sys
import time

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from aitestharness_tools.exec.web_driver import BrowserHost

BASE = "https://local.console.gov-bid.com"
LOGIN_PATH = "/gateway-admin/login"
OUT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "output", "probe-20261119"))
CAPTCHA_PNG = os.path.join(OUT, "captcha-live2.png")
ANSWER_TXT = os.path.join(OUT, "answer2.txt")
RESULT_JSON = os.path.join(OUT, "session-result2.json")


def main() -> int:
    os.makedirs(OUT, exist_ok=True)
    for path in (ANSWER_TXT, RESULT_JSON):
        if os.path.exists(path):
            os.remove(path)

    with BrowserHost() as host:
        driver = host.new_driver(BASE)
        driver.open(LOGIN_PATH)
        page = driver._page
        page.wait_for_selector("img.captcha-img", timeout=20000)
        page.wait_for_timeout(1000)

        username = os.environ.get("AITH_SUT_USERNAME") or ""
        password = os.environ.get("AITH_SUT_PASSWORD") or ""
        page.fill("input[placeholder='请输入用户名']", username)
        page.fill("input[placeholder='请输入密码']", password)

        # 点图刷新，取一张全新验证码（避免沿用页面初次加载时已接近过期的图）
        page.locator("img.captcha-img").click()
        page.wait_for_timeout(900)
        page.locator("img.captcha-img").screenshot(path=CAPTCHA_PNG)
        shot_at = time.time()
        print("CAPTCHA_READY", CAPTCHA_PNG, flush=True)

        answer = ""
        deadline = time.time() + 180
        while time.time() < deadline:
            if os.path.exists(ANSWER_TXT):
                text = open(ANSWER_TXT, encoding="utf-8").read().strip()
                if text:
                    answer = text
                    break
            time.sleep(0.2)
        if not answer:
            print("CAPTCHA_TIMEOUT", flush=True)
            return 2
        waited = time.time() - shot_at
        print(f"GOT_ANSWER {answer} after {waited:.1f}s", flush=True)

        page.fill("input[placeholder='请输入验证码']", answer)

        bodies: list[dict] = []
        page.on("request", lambda r: bodies.append({
            "url": r.url.split("?")[0],
            "query": dict(p.split("=", 1) for p in (r.url.split("?", 1) + [""])[1].split("&") if "=" in p),
        }) if "userlogin" in r.url else None)

        page.click("button.login-btn")

        final, ok = page.url, False
        end = time.time() + 25
        while time.time() < end:
            page.wait_for_timeout(300)
            if "/login" not in page.url:
                ok, final = True, page.url
                break
        page.wait_for_timeout(1200)

        payload = {
            "ok": ok, "answer": answer, "waited_s": round(waited, 1),
            "final_url": final, "title": page.title(),
            "body_text": (page.inner_text("body") or "")[:300],
            "request_query": bodies[0]["query"] if bodies else None,
        }
        if ok:
            state = page.context.storage_state()
            with open(os.path.join(OUT, "session-state.json"), "w", encoding="utf-8") as handle:
                json.dump(state, handle, ensure_ascii=False, indent=2)
            payload["state_summary"] = {
                "cookies": len(state.get("cookies") or []),
                "local_keys": [[k.get("name") for k in (o.get("localStorage") or [])]
                               for o in (state.get("origins") or [])],
            }
        with open(RESULT_JSON, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=2)
        print("RESULT", json.dumps(payload, ensure_ascii=False)[:700], flush=True)
        return 0 if ok else 3


if __name__ == "__main__":
    raise SystemExit(main())
