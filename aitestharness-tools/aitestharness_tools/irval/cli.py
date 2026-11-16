"""IR 产物校验器（M1 切片：S + M + X 三层，23 条规则）。

用法：
    python -m irval validate fixtures/plan.valid.yaml
    python -m irval validate fixtures/plan.valid.yaml --store fixtures
    python -m irval check-payload payload.yaml --writer agent:test_case_agent
    python -m irval suite
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from . import errors as E
from . import loader, ownership, pipeline
from .store import Store


def build_store(directory: str) -> Store:
    """把目录下所有合规产物装入内存库，供 X 层与 V-37 查询。"""
    store = Store()
    for path in sorted(Path(directory).glob("*.yaml")):
        if path.name.startswith("_"):
            continue
        try:
            doc = loader.load_file(str(path))
        except E.LoadError:
            continue
        if isinstance(doc, dict) and "id" in doc and "type" in doc:
            store.add(doc)
    return store


def cmd_validate(path: str, store_dir: str | None = None,
                 registry: set[tuple[str, int]] | None = None) -> int:
    try:
        doc = loader.load_file(path)
    except E.LoadError as exc:
        result = E.Result(False, [exc.to_finding()])
    else:
        store = build_store(store_dir) if store_dir else None
        result = pipeline.validate(doc, store=store, registry=registry)

    print(json.dumps(result.to_dict(), ensure_ascii=False, indent=2))
    return 0 if result.accepted else 1


def cmd_check_payload(path: str, writer: str) -> int:
    try:
        doc = loader.load_file(path)
    except E.LoadError as exc:
        print(json.dumps(E.Result(False, [exc.to_finding()]).to_dict(),
                         ensure_ascii=False, indent=2))
        return 1

    if not isinstance(doc, dict):
        print(json.dumps({"result": "rejected", "code": "SCHEMA_HEADER_MISSING"},
                         ensure_ascii=False))
        return 1

    cleaned, result = ownership.strip_forbidden(doc, writer)
    out = result.to_dict()
    out["cleaned_keys"] = sorted(cleaned)
    print(json.dumps(out, ensure_ascii=False, indent=2))
    return 0 if result.accepted else 1


def cmd_suite(verbose: bool) -> int:
    from suite.runner import render, run_all

    summary = run_all()
    print(render(summary, verbose=verbose))
    return 0 if summary.failed == 0 else 1


USAGE = """IR 产物校验器 (M1 切片)

命令：
  validate <file> [--store <dir>]                    校验单份产物
  check-payload <file> --writer agent:<name>         校验 agent 提交片段的分权
  suite [-q]                                         跑全量用例集

说明：
  --store 指定产物库目录；不指定则跳过 X 层跨产物检查。
  闸（V-17）与 X 层引用（V-27/V-30/V-31）需要它才有意义。

示例：
  python -m irval validate fixtures/plan.valid.yaml --store fixtures
  python -m irval suite
"""


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    if not argv or argv[0] in {"-h", "--help", "help"}:
        print(USAGE)
        return 0

    cmd = argv[0]

    if cmd == "validate":
        if len(argv) < 2:
            print(USAGE)
            return 2
        store_dir = argv[argv.index("--store") + 1] if "--store" in argv else None
        registry: set[tuple[str, int]] | None = None
        if "--registry-existing" in argv:
            idx = argv.index("--registry-existing")
            registry = set()
            for token in argv[idx + 1:]:
                if token.startswith("--"):
                    break
                if "@" in token:
                    pid, ver = token.rsplit("@", 1)
                    registry.add((pid, int(ver)))
        return cmd_validate(argv[1], store_dir, registry)

    if cmd == "check-payload":
        if len(argv) < 2 or "--writer" not in argv:
            print(USAGE)
            return 2
        writer = argv[argv.index("--writer") + 1]
        return cmd_check_payload(argv[1], writer)

    if cmd == "suite":
        return cmd_suite(verbose="-q" not in argv)

    print(f"未知命令：{cmd}\n")
    print(USAGE)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
