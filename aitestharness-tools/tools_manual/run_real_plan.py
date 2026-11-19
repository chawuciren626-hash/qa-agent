"""在真实被测系统上跑一条剧本（复用会话，零 LLM）。

用途：E2E-1 的"执行段真实系统验证"。
  · 会话来自 storageState，登录（含随机算术验证码）只在建会话时发生一次；
  · 剧本执行路径不调任何模型，llm 守卫照常记录；
  · 结果落 run 目录，与自建靶站的产物同构。
"""
from __future__ import annotations

import json
import os
import sys
import time

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

import yaml

from aitestharness_tools.exec.web_driver import BrowserHost
from aitestharness_tools.exec.web_engine import WebEngine, validate_plan

BASE = "https://local.console.gov-bid.com"
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
PLAN = os.path.join(ROOT, "tests", "fixtures", "real", "plan-bbiao-user-add.yaml")
OUT = os.path.abspath(os.path.join(ROOT, "..", "output", "probe-bbiao-20261119"))
STATE_JSON = os.path.join(OUT, "session-state.json")
EXEC_JSON = os.path.join(OUT, "exec-result.json")


def main() -> int:
    plan = yaml.safe_load(open(PLAN, encoding="utf-8"))
    errors = validate_plan(plan)
    if errors:
        print("PLAN_INVALID", errors, flush=True)
        return 1
    if not os.path.exists(STATE_JSON):
        print("NO_SESSION", flush=True)
        return 2

    model_modules = ("openai", "anthropic", "transformers", "torch", "dashscope", "zhipuai")
    present_before = [m for m in model_modules if m in sys.modules]

    started = time.time()
    with BrowserHost() as host:
        driver = host.new_driver(BASE, storage_state=STATE_JSON)
        engine = WebEngine(driver, {"username": "zdxadmin"})
        ir = engine.run_plan(plan)
        driver._page.screenshot(path=os.path.join(OUT, "exec-final.png"))
        driver.close()

    loaded_during = [m for m in model_modules if m in sys.modules and m not in present_before]
    ir["llm"] = {"calls": 0, "loaded_during": loaded_during,
                 "guard": "pass" if not loaded_during else "fail"}
    ir["elapsed_ms"] = int((time.time() - started) * 1000)

    with open(EXEC_JSON, "w", encoding="utf-8") as handle:
        json.dump(ir, handle, ensure_ascii=False, indent=2)

    print("verdict =", ir.get("verdict"), "| halt =", ir.get("halt"), "| consistency =", ir.get("consistency"))
    print("elapsed_ms =", ir["elapsed_ms"], "| llm =", ir["llm"])
    for step in ir.get("steps") or []:
        print(f"  [{step['index']}] {step['action']:<6} {step['status']:<8} "
              f"kind={step.get('failure_kind')} attr={step.get('attribution')}")
        for a in step.get("assertions") or []:
            mark = "OK " if a["passed"] else "NG "
            print(f"       {mark}{a['type']:<14} exp={str(a.get('expected'))[:40]:<42} act={str(a.get('actual'))[:40]}")
        for w in step.get("waits") or []:
            print(f"       wait {w['type']:<18} ok={w['ok']} {w.get('reason') or ''}")
        if step.get("locator"):
            print(f"       locator {step['locator']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
