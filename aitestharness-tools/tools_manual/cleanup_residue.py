"""清理补偿：单独把剧本里的 teardown 跑一遍（用于清理失败、或上一跑中断后的残留）。

为什么需要单独入口：
  · 清理失败时，报告里会留下 `needs_attention: residue`，但**人得真的去清**；
  · 而"再跑一次整个剧本"会先创建一个新账号——用制造新副作用的方式去清理旧残留，
    方向就反了。

实现方式刻意不另写逻辑：把 plan.teardown.steps 提升成主步骤、把 verify_gone 放进
teardown 位置，然后交给同一个引擎跑。步骤语义（失败即停、断言分级、证据）完全一致，
不会出现"补偿脚本和正式清理行为不一致"这种更糟的问题。

**清理也要授权**（P4 判据 3）
--------------------------
清理本身是写操作（点注销就是提交），所以它同样过闸。批准的是"这一份清理计划"，
与"创建那份计划"是两份不同的指纹——因为副作用不同。

这不是故意为难清理：若清理可以无授权执行，"删除数据"就成了绕过审批的后门。
代价是流程多一步，所以这里支持 `--dump-plan` 把清理计划导出，直接喂给
`issue_approval.py` 签发：

    # 1) 导出清理计划
    python tools_manual/cleanup_residue.py <plan.yaml> --dump-plan cleanup-plan.yaml
    # 2) 人工签发（人会看到它要注销谁）
    python tools_manual/issue_approval.py cleanup-plan.yaml \
        --env-id <env> --by "human:<name>" --out cleanup-approval.json
    # 3) 执行清理
    python tools_manual/cleanup_residue.py <plan.yaml> --approval cleanup-approval.json
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from urllib.parse import urlparse

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

import yaml

from aitestharness_tools.exec.authorization import authorize_plan
from aitestharness_tools.exec.web_driver import BrowserHost
from aitestharness_tools.exec.web_engine import WebEngine, validate_plan

BASE = os.environ.get("AITH_SUT_BASE", "https://local.console.gov-bid.com").rstrip("/")
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
OUT = os.path.abspath(os.path.join(ROOT, "..", "output", "probe-bbiao-20261119"))
STATE_JSON = os.path.join(OUT, "session-state.json")


def default_env_id() -> str:
    return os.environ.get("AITH_SUT_ENV_ID") or urlparse(BASE).hostname or BASE


def build_cleanup_plan(plan: dict) -> dict | None:
    teardown = plan.get("teardown") or {}
    steps = teardown.get("steps") or []
    if not steps:
        return None
    # 把清理步骤提升为主步骤；verify_gone 仍按"反验"跑（它在全部步骤之后独立执行）
    return {
        "lineage": {"id": (plan.get("lineage") or {}).get("id", "PLAN") + "-CLEANUP",
                    "version": 1},
        "title": "清理补偿（仅 teardown）",
        "driver": "web",
        "steps": steps,
        "teardown": {"steps": [], "verify_gone": teardown.get("verify_gone") or []},
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="单独执行剧本的 teardown（清理补偿）")
    parser.add_argument("plan")
    parser.add_argument("--approval", default="", help="清理授权记录（含写动作时必需）")
    parser.add_argument("--env-id", default=default_env_id())
    parser.add_argument("--dump-plan", default="", help="只导出清理计划，供签发授权用")
    args = parser.parse_args(argv)

    plan = yaml.safe_load(open(args.plan, encoding="utf-8"))
    cleanup_plan = build_cleanup_plan(plan)
    if cleanup_plan is None:
        print("NO_TEARDOWN_STEPS", flush=True)
        return 2

    if args.dump_plan:
        with open(args.dump_plan, "w", encoding="utf-8") as handle:
            yaml.safe_dump(cleanup_plan, handle, allow_unicode=True, sort_keys=False)
        print("cleanup plan ->", args.dump_plan, flush=True)
        print(f"下一步：issue_approval.py {args.dump_plan} --env-id {args.env_id} "
              f"--by \"human:<你的名字>\" --out cleanup-approval.json", flush=True)
        return 0

    errors = validate_plan(cleanup_plan)
    if errors:
        print("PLAN_INVALID", errors, flush=True)
        return 3

    approval = None
    if args.approval:
        if not os.path.isfile(args.approval):
            print("APPROVAL_FILE_MISSING", args.approval, flush=True)
            return 6
        approval = json.load(open(args.approval, encoding="utf-8"))

    gate = authorize_plan(cleanup_plan, approval, env_id=args.env_id)
    if not gate["allow"]:
        print("AUTHORIZATION_DENIED", flush=True)
        for reason in gate["reasons"]:
            print("  ·", reason, flush=True)
        print(f"  plan_hash = {gate['plan_hash']}", flush=True)
        print("  未启动浏览器。为清理签发授权的流程：", flush=True)
        print(f"    python tools_manual/cleanup_residue.py {args.plan} --dump-plan /tmp/cleanup.yaml",
              flush=True)
        print(f"    python tools_manual/issue_approval.py /tmp/cleanup.yaml --env-id {args.env_id} "
              f"--by \"human:<你的名字>\" --out /tmp/cleanup-approval.json", flush=True)
        return 3

    if not os.path.exists(STATE_JSON):
        print("NO_SESSION", flush=True)
        return 4

    started = time.time()
    with BrowserHost() as host:
        driver = host.new_driver(BASE, storage_state=STATE_JSON)
        ir = WebEngine(driver, {}, env_id=args.env_id,
                       authorization=approval).run_plan(cleanup_plan)
        driver._page.screenshot(path=os.path.join(OUT, "cleanup-residue-final.png"))
        driver.close()
    ir["elapsed_ms"] = int((time.time() - started) * 1000)

    if approval and approval.get("single_use"):
        approval["used_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        with open(args.approval, "w", encoding="utf-8") as handle:
            json.dump(approval, handle, ensure_ascii=False, indent=2)

    target = os.path.join(OUT, "cleanup-residue.json")
    with open(target, "w", encoding="utf-8") as handle:
        json.dump(ir, handle, ensure_ascii=False, indent=2)

    print("verdict =", ir["verdict"], "| halt =", ir.get("halt"))
    for step in ir["steps"]:
        print(f"  [{step['index']}] {step['action']:<6} {step['status']:<8} "
              f"kind={step.get('failure_kind')}")
        for a in step.get("assertions") or []:
            mark = "OK " if a["passed"] else "NG "
            print(f"       {mark}{a['type']:<14} exp={str(a.get('expected'))[:36]:<38} "
                  f"act={str(a.get('actual'))[:36]}")
    for check in (ir.get("teardown") or {}).get("verify") or []:
        print(f"  [反验] {check['name']}: remaining={check['remaining']} gone={check['gone']}")
    print("exec json =", target)
    teardown = ir.get("teardown") or {}
    residue = teardown.get("residue") or []
    if residue:
        return 5
    # 无残留即成功：清理步骤本身可能"过期"（账号已是注销状态、行内没有按钮），
    # 只要反验证明没有残留，工具就完成了我给它的任务
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
