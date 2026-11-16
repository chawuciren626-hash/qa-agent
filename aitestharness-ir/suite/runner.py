"""用例执行器：判定标准是 `result` + `code`（+ `field`）三重匹配。

只比"是否 rejected"是不够的 —— 那样实现里所有规则统一返回一个 REJECTED
也能拿满分，那正是我们要防的假通过。

用例默认在一个**预置产物库**上运行（含基线 6 份 + 2 个桩），
X 层与 V-37 需要它；S/M 层不依赖。
"""

from __future__ import annotations

from dataclasses import dataclass

from irval import errors as E
from irval import loader, ownership, pipeline
from irval.store import Store

from .cases import CASES, Case, _load, _raw


def default_store() -> Store:
    """基线产物库：正例的引用必须全部可解析。"""
    from pathlib import Path

    from .cases import BASE

    store = Store()
    for path in sorted(Path(BASE).glob("*.yaml")):
        if path.name.startswith("_"):      # 用例基线，不属于产物库
            continue
        store.add(_load(path.name))
    return store


def store_for(case: Case) -> Store:
    """按用例需求组装产物库：基线 + 该用例自带的历史版本。"""
    store = default_store()
    for doc in case.store_extra:
        store.add(doc)
    return store


@dataclass
class Outcome:
    case: Case
    ok: bool
    actual: str
    actual_code: str | None
    actual_field: str | None
    message: str = ""


def run_case(c: Case) -> E.Result:
    if c.kind == "payload":
        assert c.payload is not None
        return ownership.check_agent_payload(c.payload, c.writer)

    if c.kind == "raw":
        text = c.text_mutate(_raw(c.base)) if c.text_mutate else _raw(c.base)
        try:
            doc = loader.load(text)
        except E.LoadError as exc:
            return E.Result(False, [exc.to_finding(rule=c.rule or "V-38")])
        return pipeline.validate(doc, store=store_for(c), registry=c.registry)

    doc = _load(c.base)
    if c.mutate:
        c.mutate(doc)
    return pipeline.validate(doc, store=store_for(c), registry=c.registry)


def judge(c: Case, res: E.Result) -> Outcome:
    actual = "accepted" if res.accepted else "rejected"
    actual_code = res.code
    actual_field = res.field

    if actual != c.expect:
        return Outcome(c, False, actual, actual_code, actual_field,
                       f"结果不符：期望 {c.expect}，实际 {actual}")

    if c.expect == "rejected":
        if actual_code != c.code:
            return Outcome(c, False, actual, actual_code, actual_field,
                           f"错误码不符：期望 {c.code}，实际 {actual_code}")
        if c.field is not None and actual_field != c.field:
            return Outcome(c, False, actual, actual_code, actual_field,
                           f"字段路径不符：期望 {c.field}，实际 {actual_field}")

    return Outcome(c, True, actual, actual_code, actual_field)


@dataclass
class Summary:
    outcomes: list[Outcome]

    @property
    def total(self) -> int:
        return len(self.outcomes)

    @property
    def passed(self) -> int:
        return sum(1 for o in self.outcomes if o.ok)

    @property
    def failed(self) -> int:
        return self.total - self.passed

    @property
    def neg_total(self) -> int:
        return sum(1 for o in self.outcomes if o.case.expect == "rejected")

    @property
    def neg_blocked(self) -> int:
        return sum(1 for o in self.outcomes if o.case.expect == "rejected" and o.ok)

    @property
    def pos_total(self) -> int:
        return sum(1 for o in self.outcomes if o.case.expect == "accepted")

    @property
    def pos_false_positive(self) -> int:
        return sum(1 for o in self.outcomes if o.case.expect == "accepted" and not o.ok)

    @property
    def rules_covered(self) -> int:
        return len({o.case.rule for o in self.outcomes if o.case.rule})


def run_all() -> Summary:
    return Summary([judge(c, run_case(c)) for c in CASES])


def render(summary: Summary, verbose: bool = True) -> str:
    lines: list[str] = []
    lines.append("=" * 84)
    lines.append(f"{'用例':<10}{'规则':<8}{'结果':<12}{'实际错误码':<36}{'判定'}")
    lines.append("-" * 84)
    for o in summary.outcomes:
        if not verbose and o.ok:
            continue
        flag = "PASS" if o.ok else "FAIL"
        lines.append(f"{o.case.name:<10}{o.case.rule:<8}{o.actual:<12}"
                     f"{str(o.actual_code or '-'):<36}{flag}")
        if not o.ok:
            lines.append(f"    ↳ {o.message}")
            if o.case.note:
                lines.append(f"    ↳ 设计意图：{o.case.note}")
    lines.append("=" * 84)

    neg = (summary.neg_blocked / summary.neg_total * 100) if summary.neg_total else 0.0
    lines.append(
        f"用例 {summary.passed}/{summary.total} 通过 | "
        f"反例拦截率 {summary.neg_blocked}/{summary.neg_total} = {neg:.0f}% | "
        f"正例误杀 {summary.pos_false_positive}/{summary.pos_total} | "
        f"规则覆盖 {summary.rules_covered} 条"
    )
    return "\n".join(lines)
