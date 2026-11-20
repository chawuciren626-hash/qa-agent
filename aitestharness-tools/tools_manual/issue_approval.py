"""人工签发写操作授权（P4 判据 3 的"人批"入口）。

    python tools_manual/issue_approval.py tests/fixtures/real/plan-bbiao-user-crud.yaml \
        --env-id bbiao-admin@local.console.gov-bid.com \
        --by "human:zdxadmin" --ttl 30 --out approval.json

为什么签发要单独一个脚本，而不是执行器自己造一条
--------------------------------------------
执行器自签 = 自己批自己，闸等于装饰。这里把"批准"做成一个**人工执行的动作**：
人跑这个脚本 → 看到它打印"你正在批准哪些动作、打在哪个环境、哪份计划"→ 产物落盘。
执行器只读产物，不生成。

所以 `run_real_plan.py` 里没有 `--approve`，只有 `--approval <文件>`。
这个不对称是刻意的：**能批准的和能执行的不是同一段代码**。

能力边界（别把它当安全机制）
--------------------------
产物没有签名，同一用户可以伪造。它挡的是"忘了批就跑了"和"批的不是这份计划"，
挡不住有意伪造。真正的防伪造依赖签发方身份与密钥，属服务端（P5/M1）。
脚本会在输出里显式打印这一点，避免读者误判它的强度。
"""
from __future__ import annotations

import argparse
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import yaml

from aitestharness_tools.exec.authorization import (build_approval, plan_actions,
                                                    plan_fingerprint)


def main() -> int:
    parser = argparse.ArgumentParser(description="为一份计划签发写操作授权")
    parser.add_argument("plan", help="计划 YAML 路径")
    parser.add_argument("--env-id", required=True, help="绑定的环境标识，如 bbiao-admin@host")
    parser.add_argument("--by", required=True, help="签发人，如 human:zdxadmin")
    parser.add_argument("--ttl", type=int, default=30, help="有效期（分钟），默认 30")
    parser.add_argument("--actions", default="", help="收窄授权范围，逗号分隔（默认取计划实际动作）")
    parser.add_argument("--reusable", action="store_true", help="允许多次使用（默认单次）")
    parser.add_argument("--out", required=True, help="授权记录输出路径")
    parser.add_argument("--note", default="", help="备注，写进记录")
    args = parser.parse_args()

    plan = yaml.safe_load(open(args.plan, encoding="utf-8"))
    actions = [item.strip() for item in args.actions.split(",") if item.strip()] or None
    approval = build_approval(plan, env_id=args.env_id, issued_by=args.by,
                              actions=actions, ttl_minutes=args.ttl,
                              single_use=not args.reusable, note=args.note)

    detail = plan_actions(plan)
    print("=" * 68)
    print(f"计划       : {plan.get('lineage', {}).get('id')} "
          f"v{plan.get('lineage', {}).get('version')}")
    print(f"指纹       : {plan_fingerprint(plan)}")
    print(f"环境       : {args.env_id}")
    print(f"写动作     : {detail['mutating']}")
    print(f"动作分布   : step={sum(1 for s in detail['steps'] if s['phase'] == 'step' and s['mutating'])} "
          f"写 / session={sum(1 for s in detail['steps'] if s['phase'] == 'session' and s['mutating'])} 写 / "
          f"teardown={sum(1 for s in detail['steps'] if s['phase'] == 'teardown' and s['mutating'])} 写")
    print(f"有效期     : {args.ttl} 分钟（至 {approval.get('expires_at')}）")
    print(f"使用次数   : {'多次' if args.reusable else '单次'}")
    print(f"签发人     : {args.by}")
    print("=" * 68)
    print("注意：记录未签名，本闸防误操作、不防有意伪造。")

    directory = os.path.dirname(os.path.abspath(args.out))
    os.makedirs(directory, exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as handle:
        json.dump(approval, handle, ensure_ascii=False, indent=2)
    print(f"已写入 {args.out}")
    print(f"批准时请注意：{approval['id']} 只对上面这个指纹有效；"
          f"计划里改任何一个动作/目标，本授权自动失效。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
