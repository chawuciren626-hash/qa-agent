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
        return {"dedup": dedup_defects(payload["evidence_packs"], payload.get("existing")),
                "heisenbugs": identify_heisenbug(payload.get("history", []))}
    if tool_id == "regression.impact":
        from .regression.impact import select_by_change
        return select_by_change(payload.get("explicit_ids"), payload.get("changed_requirements"),
                                payload.get("changed_modules"), payload.get("changed_fragments"),
                                payload.get("similar_cases"), payload.get("cases"),
                                set(payload.get("quarantine_ids", [])))
    if tool_id == "regression.select":
        from .regression.selector import select_regression
        return select_regression(payload["cases"], payload.get("tier", "smoke"), payload.get("budget_s"))
    if tool_id == "onboard.bootstrap":
        # 建档不是 run 内的阶段工具（没有 run/stage），所以它是本入口里唯一
        # 允许"产出文件"的分支：给 out 就落 maps + 报告，不给就只回结构。
        # 失败时一律不落盘——不生成"看起来成功"的半份产物。
        from .onboard.bootstrap import bootstrap, write_bundle
        result = bootstrap(
            payload["project"], payload.get("env") or "test", payload["target_url"],
            payload.get("openapi_url"),
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
