"""pytest 包装：每个用例一个 test，失败信息带设计意图。"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from suite.cases import CASES  # noqa: E402
from suite.runner import judge, run_case  # noqa: E402


@pytest.mark.parametrize("case", CASES, ids=[c.name for c in CASES])
def test_case(case):
    outcome = judge(case, run_case(case))
    assert outcome.ok, (
        f"{case.name} ({case.rule}) 失败：{outcome.message}\n"
        f"  设计意图：{case.note or '(无)'}"
    )


def test_suite_has_no_duplicate_case_names():
    names = [c.name for c in CASES]
    dupes = {n for n in names if names.count(n) > 1}
    assert not dupes, f"用例名重复：{dupes}"


def test_negative_cases_outnumber_positive():
    """反例应多于正例：漏拦的代价远大于多写几个反例。"""
    neg = sum(1 for c in CASES if c.expect == "rejected")
    pos = sum(1 for c in CASES if c.expect == "accepted")
    assert neg > pos, f"反例 {neg} 应多于正例 {pos}"
