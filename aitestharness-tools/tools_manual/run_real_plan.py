"""在真实被测系统上跑一条剧本（复用会话，零 LLM）。

用途：E2E-1 的"执行段真实系统验证"。
  · 会话来自 storageState，登录（含随机算术验证码）只在建会话时发生一次；
  · 剧本执行路径不调任何模型，llm 守卫照常记录；
  · 结果落 run 目录，与自建靶站的产物同构；
  · **含写动作的剧本必须带 `--approval <文件>`**，且该文件只能由
    `issue_approval.py`（人跑）产出。这里没有 `--approve` 选项，是刻意的：
    能批准的和能执行的不能是同一段代码。

    python tools_manual/run_real_plan.py <plan.yaml> --approval approval.json
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from datetime import datetime, timezone
from urllib.parse import urlparse

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

import yaml

from aitestharness_tools.exec.authorization import authorize_plan
from aitestharness_tools.exec.web_driver import BrowserHost
from aitestharness_tools.exec.web_engine import WebEngine, validate_plan

BASE = os.environ.get("AITH_SUT_BASE", "https://local.console.gov-bid.com").rstrip("/")
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
PLAN = os.path.join(ROOT, "tests", "fixtures", "real", "plan-bbiao-user-add.yaml")
OUT = os.path.abspath(os.path.join(ROOT, "..", "output", "probe-bbiao-20261119"))
STATE_JSON = os.path.join(OUT, "session-state.json")
EXEC_JSON = os.path.join(OUT, "exec-result.json")


def default_env_id() -> str:
    """环境标识：显式优先，否则用主机名。

    授权绑定的是这个值，所以它必须是"人能认出的那个环境"。同一主机挂多套后台
    （bbiao-admin / gateway-admin）时用 `AITH_SUT_ENV_ID` 区分，别让两套后台
    共用一份授权。
    """
    explicit = os.environ.get("AITH_SUT_ENV_ID")
    if explicit:
        return explicit
    return urlparse(BASE).hostname or BASE


def _consume(approval_path: str, approval: dict, ir: dict) -> None:
    """执行过就把单次授权标记为已用。

    只判"有没有执行"，不判"执行是否成功"：失败的那次同样已经作用于被测数据
    （可能建了一半），把它当成没用过就能再跑一次，正是最该防的那种"再试一次"。
    """
    if not approval.get("single_use"):
        return
    if (ir.get("halt") or {}).get("stage") == "authorization":
        return                                  # 根本没执行，授权不该被消耗
    approval["used_at"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    with open(approval_path, "w", encoding="utf-8") as handle:
        json.dump(approval, handle, ensure_ascii=False, indent=2)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="真机执行一条剧本")
    parser.add_argument("plan", nargs="?", default=PLAN)
    parser.add_argument("--approval", default="",
                        help="授权记录路径（含写动作的剧本必需，由 issue_approval.py 产出）")
    parser.add_argument("--env-id", default=default_env_id())
    args = parser.parse_args(argv)

    plan_path = args.plan
    plan = yaml.safe_load(open(plan_path, encoding="utf-8"))
    errors = validate_plan(plan)
    if errors:
        print("PLAN_INVALID", errors, flush=True)
        return 1

    approval = None
    if args.approval:
        if not os.path.isfile(args.approval):
            print("APPROVAL_FILE_MISSING", args.approval, flush=True)
            return 4
        approval = json.load(open(args.approval, encoding="utf-8"))

    # 早退：把授权判定放在启动浏览器之前，避免"为了被拒绝而先开一个浏览器"。
    # 这道判定**不替代**引擎内的闸（引擎自己还会再判一次，防止调用方绕过），
    # 只是省掉无意义的资源开销。
    gate = authorize_plan(plan, approval, env_id=args.env_id)
    if not gate["allow"]:
        print("AUTHORIZATION_DENIED", flush=True)
        for reason in gate["reasons"]:
            print("  ·", reason, flush=True)
        print(f"  plan_hash = {gate['plan_hash']}", flush=True)
        print(f"  env_id    = {gate['env_id']}（绑定值：{(approval or {}).get('env_id')}）",
              flush=True)
        print("  未启动浏览器，未接触被测系统。", flush=True)
        return 3

    if not os.path.exists(STATE_JSON):
        print("NO_SESSION", flush=True)
        return 2

    model_modules = ("openai", "anthropic", "transformers", "torch", "dashscope", "zhipuai")
    present_before = [m for m in model_modules if m in sys.modules]

    started = time.time()
    with BrowserHost() as host:
        driver = host.new_driver(BASE, storage_state=STATE_JSON)
        # data 供剧本变量插值用（${...}）。当前剧本未引用，但不写死账号——
        # 写死了以后会被当成"这个环境的固定账号"抄进别的剧本。
        engine = WebEngine(driver, {"username": os.environ.get("AITH_SUT_USERNAME", "")},
                           env_id=args.env_id, authorization=approval)
        ir = engine.run_plan(plan)
        tag = os.path.splitext(os.path.basename(plan_path))[0]
        driver._page.screenshot(path=os.path.join(OUT, f"{tag}-final.png"))
        driver.close()

    loaded_during = [m for m in model_modules if m in sys.modules and m not in present_before]
    ir["llm"] = {"calls": 0, "loaded_during": loaded_during,
                 "guard": "pass" if not loaded_during else "fail"}
    ir["elapsed_ms"] = int((time.time() - started) * 1000)
    ir["plan_file"] = os.path.basename(plan_path)

    if args.approval and approval is not None:
        _consume(args.approval, approval, ir)

    out_json = EXEC_JSON if plan_path == PLAN else os.path.join(
        OUT, f"exec-{os.path.splitext(os.path.basename(plan_path))[0]}.json")
    with open(out_json, "w", encoding="utf-8") as handle:
        json.dump(ir, handle, ensure_ascii=False, indent=2)

    print("verdict =", ir.get("verdict"), "| halt =", ir.get("halt"), "| consistency =", ir.get("consistency"))
    print("authorization =", json.dumps(ir.get("authorization"), ensure_ascii=False)[:300])
    print("teardown =", json.dumps(ir.get("teardown"), ensure_ascii=False)[:400])
    if ir.get("needs_attention"):
        print("!!! NEEDS_ATTENTION =", json.dumps(ir["needs_attention"], ensure_ascii=False))
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
    for item in (ir.get("teardown") or {}).get("steps") or []:
        print(f"  [清理 {item['index']}] {item['action']:<6} {item['status']:<8} "
              f"kind={item.get('failure_kind')}")
        for a in item.get("assertions") or []:
            mark = "OK " if a["passed"] else "NG "
            print(f"       {mark}{a['type']:<14} exp={str(a.get('expected'))[:40]:<42} act={str(a.get('actual'))[:40]}")
    for check in (ir.get("teardown") or {}).get("verify") or []:
        print(f"  [反验] {check['name']}: remaining={check['remaining']} gone={check['gone']}")
    print("exec json =", out_json)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
