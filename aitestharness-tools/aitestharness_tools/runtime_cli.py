"""Narrow JSON entry point for deterministic stage tools. No dynamic imports or eval."""
from __future__ import annotations

import json
import sys
from dataclasses import asdict


def invoke(tool_id: str, payload: dict) -> object:
    if tool_id == "requirement.testability":
        from .requirement.testability import check_testability
        return check_testability(payload["requirement"])
    if tool_id == "requirement.acceptance":
        from .requirement.acceptance import check_acceptance_observable
        return [asdict(item) for item in check_acceptance_observable(payload["requirement"])]
    if tool_id == "testpoint.coverage":
        from .testpoint.coverage import coverage_gaps
        return coverage_gaps(payload["requirements"], payload["test_points"],
                             payload.get("cases", []), enforce=payload.get("enforce", False))
    if tool_id == "plan.gates":
        from .plan.gates import compile_gates, gates_summary
        gates = compile_gates(payload["plan"], payload.get("case"))
        return {"gates": [asdict(item) for item in gates], "summary": gates_summary(gates)}
    if tool_id == "irval.check":
        from .irval.pipeline import validate
        result = validate(payload["document"])
        return asdict(result)
    if tool_id == "report.reviewer":
        from .report.reviewer import extract_facts
        return extract_facts(payload["execs"])
    if tool_id == "defect.evidence":
        from .defect.evidence import build_evidence_pack
        return build_evidence_pack(payload["exec_ir"], payload.get("failed_step"),
                                   payload.get("baseline"), payload.get("history"),
                                   False)
    if tool_id == "defect.tools":
        from .defect.tools import dedup_defects, identify_heisenbug
        result = {"dedup": dedup_defects(payload["evidence_packs"], payload.get("existing")),
                  "heisenbugs": identify_heisenbug(payload.get("history", []))}
        # 三分归因只在给了执行 IR 时才算：没有 IR 就没有可归因的失败，
        # 此时返回空结论比返回一个"看起来像结论"的默认值更安全。
        if payload.get("exec_ir"):
            from .defect.attribution import attribute_failure
            result["attribution"] = attribute_failure(
                payload["exec_ir"], preflight=payload.get("preflight"),
                replay=payload.get("replay"), history=payload.get("history"))
        return result
    if tool_id == "regression.impact":
        from .regression.impact import select_by_change
        return select_by_change(payload.get("explicit_ids"), payload.get("changed_requirements"),
                                payload.get("changed_modules"), payload.get("changed_fragments"),
                                payload.get("similar_cases"), payload.get("cases"),
                                set(payload.get("quarantine_ids", [])))
    if tool_id == "regression.select":
        from .regression.selector import select_regression
        return select_regression(payload["cases"], payload.get("tier", "smoke"), payload.get("budget_s"))
    if tool_id == "knowledge.extract":
        # 条款化：先把资料切成带原文位置（file+line+章节路径）的条款，再把外部抽取的
        # 知识项按条款回填位置。没有位置的知识项一律丢弃并计数——不可定位即不可信。
        from .knowledge.extract import split_clauses, build_knowledge
        source = payload.get("source") or "doc.md"
        clauses = split_clauses(payload["text"], source)
        knowledge = build_knowledge(
            payload["project"], payload.get("items") or [], clauses,
            version=int(payload.get("version") or 1),
            actor=payload.get("actor") or "agent:requirement_agent",
        )
        return {"clauses": clauses, "knowledge": knowledge}
    if tool_id == "knowledge.build":
        # 多份资料一起条款化再建知识：条款 id 带来源前缀（s01-c0003），
        # 否则两份资料各从 c0001 起编，知识项会"定位"到别人的同名行——
        # 这种错不报错，只会让「原文位置」变成假证据。
        from .knowledge.extract import split_sources, build_knowledge
        clauses = split_sources(payload.get("sources") or [])
        knowledge = build_knowledge(
            payload["project"], payload.get("items") or [], clauses,
            version=int(payload.get("version") or 1),
            actor=payload.get("actor") or "agent:requirement_agent",
        )
        return {"clauses": clauses, "knowledge": knowledge}
    if tool_id == "knowledge.diff":
        # 版本对账：四类结果分开报。wording_only 不得触发重算，否则增量机制等于全量。
        from .knowledge.incremental import diff_knowledge
        return diff_knowledge(payload.get("old") or {}, payload.get("new") or {},
                              float(payload.get("rename_threshold") or 0.86))
    if tool_id == "knowledge.references":
        # 引用反查：资料改了，哪些用例可能受影响。宁可多报，不能漏报。
        from .knowledge.extract import find_references
        hits = find_references(payload.get("text") or "", payload.get("knowledge") or {})
        return {"hits": hits, "count": len(hits)}
    if tool_id == "context.assemble":
        # 装配：按 scope 切片 + 预算裁剪 + 记账。被裁掉的项必须出现在 dropped 里。
        from .common.context_assembler import assemble
        return assemble(payload.get("scope") or {}, payload.get("knowledge") or {},
                        payload.get("maps") or {}, int(payload.get("budget_tokens") or 8000),
                        payload.get("extra") or [])
    if tool_id == "onboard.bootstrap":
        # 建档不是 run 内的阶段工具（没有 run/stage），所以它是本入口里唯一
        # 允许"产出文件"的分支：给 out 就落 maps + 报告，不给就只回结构。
        # 失败时一律不落盘——不生成"看起来成功"的半份产物。
        #
        # 进度走 stderr 的 @@step 行：stdout 必须保持"一个纯 JSON 信封"，任何
        # 混进来的日志都会让调用方解析失败。stderr 的每行都是可丢的播报。
        from .onboard.bootstrap import bootstrap, write_bundle

        def emit(event: dict) -> None:
            sys.stderr.write("@@step " + json.dumps(event, ensure_ascii=False) + "\n")
            sys.stderr.flush()

        result = bootstrap(
            payload["project"], payload.get("env") or "test", payload["target_url"],
            payload.get("openapi_url"),
            on_step=emit if payload.get("progress", True) else None,
        )
        out_dir = payload.get("out")
        if out_dir:
            if result.get("ok"):
                result["paths"] = write_bundle(out_dir, result["maps"], result["report"])
            else:
                result["paths"] = None
        return result
    raise ValueError("Tool is not exposed through the stage runtime")


def main() -> int:
    try:
        if sys.version_info < (3, 11):
            raise RuntimeError("Python 3.11+ required for stage tools")
        tool_id = sys.argv[1]
        payload = json.load(sys.stdin)
        if not isinstance(payload, dict):
            raise ValueError("Tool payload must be an object")
        print(json.dumps({"ok": True, "result": invoke(tool_id, payload)}, ensure_ascii=True))
        return 0
    except KeyError as error:
        print(json.dumps({"ok": False, "error_code": "TOOL_INPUT_MISSING", "message": str(error)}, ensure_ascii=True))
        return 2
    except (TypeError, ValueError) as error:
        print(json.dumps({"ok": False, "error_code": "TOOL_INPUT_INVALID", "message": str(error)}, ensure_ascii=True))
        return 2
    except RuntimeError as error:
        print(json.dumps({"ok": False, "error_code": "TOOL_RUNTIME_UNAVAILABLE", "message": str(error)}, ensure_ascii=True))
        return 2
    except Exception:
        print(json.dumps({"ok": False, "error_code": "TOOL_EXECUTION_FAILED", "message": "deterministic tool raised an unexpected error"}, ensure_ascii=True))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
