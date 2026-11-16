"""建档链路命令行入口。

用法：
    python -m aitestharness_tools.onboard --url http://127.0.0.1:8000 \
        --project demo --env test --out ./bootstrap-out

输出：控制台摘要 + maps-<env>.yaml + bootstrap-report-<env>.md
"""
from __future__ import annotations

import argparse
import json
import sys

from .bootstrap import Probe, bootstrap, render_report_markdown, write_bundle


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        prog="aitestharness-bootstrap",
        description="项目建档：给一个地址，产出环境事实资产（maps IR）+ 建档报告（零 LLM）")
    ap.add_argument("--url", required=True, help="被测系统首页地址")
    ap.add_argument("--project", required=True, help="项目标识")
    ap.add_argument("--env", default="test", help="环境标识（默认 test）")
    ap.add_argument("--openapi-url", default=None,
                    help="显式指定 OpenAPI 文档地址（默认自动尝试 6 个常见路径）")
    ap.add_argument("--out", default="./bootstrap-out", help="产物输出目录")
    ap.add_argument("--timeout", type=int, default=10, help="单请求超时秒数")
    ap.add_argument("--json", action="store_true", help="只输出 JSON 报告（便于编排层消费）")
    args = ap.parse_args(argv)

    result = bootstrap(project=args.project, env=args.env, url=args.url,
                       openapi_url=args.openapi_url, probe=Probe(timeout=args.timeout))

    if args.json:
        print(json.dumps({"ok": result["ok"],
                          "report": result["report"],
                          "trace": result["probe_trace"]},
                         ensure_ascii=False, indent=2))
        return 0 if result["ok"] else 2

    if not result["ok"]:
        print(f"[失败] 建档中断：{result['error']}", file=sys.stderr)
        print(render_report_markdown(result["report"]), file=sys.stderr)
        return 2

    paths = write_bundle(args.out, result["maps"], result["report"])
    rep = result["report"]
    print(f"[完成] 项目 {rep['project']} / 环境 {rep['env']}")
    print(f"  页面（归一化路由）: {rep['routes']['count']} 个"
          f"（原始字面量 {rep['routes']['raw_count']}）")
    print(f"  已建档页面        : {rep['pages']['registered']} / {rep['pages']['total']}")
    print(f"  接口              : {rep['apis']['count']} 个"
          + (f"（{rep['apis']['source_url']}）" if rep["apis"]["source_url"] else ""))
    print(f"  登录              : {rep['login'].get('is_login')}"
          f" 验证码={rep['login'].get('captcha_type')}")
    for w in rep["warnings"]:
        print(f"  [警告] {w}")
    print(f"  产物: {paths['maps']}")
    print(f"        {paths['report']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
