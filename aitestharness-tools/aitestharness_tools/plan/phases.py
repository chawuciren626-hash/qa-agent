"""§5.4 / §5.5 阶段编排：七阶段状态机 + 前置产物契约校验。

解决两个具体的翻车模式：

    模式 A（§5.4）：跳过前置阶段，让 LLM 现场编造上游产物。
        表现——直接点「执行」，agent 自己编了一份"看起来像计划"的东西去跑，跑了 40 分钟
        没结果。根因：单阶段可跑的口子开了，但**没有校验前置产物在哪**。

    模式 B（§5.5）：把阶段合并成一次调用，只剩一个确认点。
        表现——需求、测试点、用例一次出，人只审一次，结果"需求理解错"和"测试点不全"
        两个问题混在一起，评审时无法分头定位。

本文件是这两条的代码承载：
    1. PHASES       九阶段定义 + 每阶段前置产物契约（必需字段）
    2. check_prereq 前置校验：缺了就拒绝执行，不给 LLM 编造机会
    3. PhaseState   状态机：start / finish / confirm；agent 不能确认、不能跳步
    4. invalidate   上游变更 → 下游 stale（保留产物，只标失效）

零 LLM：全部是状态与契约判断。
"""
from __future__ import annotations

from dataclasses import dataclass, field

__all__ = ["PHASES", "PHASE_ORDER", "CONFIRM_GATES", "check_prereq", "can_run",
           "PhaseState", "invalidate", "phase_plan", "KIND_TO_PHASE"]

# 每阶段定义：
#   requires —— 前置产物 kind 列表（空 = 可从零开始）
#   produces —— 本阶段产出的产物 kind
#   required —— 该产物必须具备的根字段（缺一即"没产出"，不是"产出得不好"）
#   confirm  —— 是否设人工确认卡点（§5.5 判据 ①）
PHASES: dict[str, dict] = {
    "onboard": {
        "title": "环境建档", "agent": "default_agent(入口)", "llm_calls": 0,
        "requires": [], "produces": "maps",
        "required": ["pages", "apis", "probed_at"], "confirm": False,
        "note": "零 LLM，10 秒级；只有路由无控件不算真建档（看 pages[].registered）",
    },
    "explore": {
        "title": "环境探索", "agent": "default_agent(探索子流程)",
        "llm_calls": "2/页（预算卡死）",
        "requires": ["maps"], "produces": "maps",
        "required": ["pages", "probed_at"], "confirm": False,
        "note": "有预算就停；产出探索度报告，未探索项进待探索队列",
    },
    "requirement": {
        "title": "需求分析", "agent": "requirement_analysis_agent", "llm_calls": 1,
        "requires": [], "produces": "requirements",
        "required": ["lineage", "items"], "confirm": True,
        "note": "输入只能是条款；每条必须挂原文位置，无位置即丢弃",
    },
    "testpoint": {
        "title": "测试点分析", "agent": "test_point_agent", "llm_calls": 1,
        "requires": ["requirements"], "produces": "testpoints",
        "required": ["lineage", "items", "matrix"], "confirm": True,
        "note": "矩阵由程序算，agent 只补空格子；必须完成验证方式分配",
    },
    "case": {
        "title": "用例生成", "agent": "test_case_agent", "llm_calls": 2,
        "requires": ["testpoints"], "produces": "cases",
        "required": ["lineage", "items"], "confirm": True,
        "note": "断言必须回指测试点；过条数预算与枚举对账",
    },
    "plan": {
        "title": "计划固化", "agent": "test_case_agent(编译段)", "llm_calls": "0（仅辅助命名）",
        "requires": ["cases", "maps"], "produces": "plans",
        "required": ["lineage", "steps", "gates", "touched"], "confirm": False,
        "note": "五道闸全过才允许入库；闸 5 编译期恒 pending",
    },
    "execute": {
        "title": "执行", "agent": "四个执行 agent", "llm_calls": 0,
        "requires": ["plans"], "produces": "exec",
        "required": ["verdict", "steps", "engine_version", "schema_version"],
        "confirm": False,
        "note": "重放零 LLM；缺计划应拒绝执行，而不是让 agent 自己编一份",
    },
    "defect": {
        "title": "缺陷分析", "agent": "defect_analysis_agent", "llm_calls": 1,
        "requires": ["exec"], "produces": "defects",
        "required": ["lineage", "items"], "confirm": False,
        "note": "取证包由程序组装；偶发 bug 要上报，不许自动改脚本",
    },
    "report": {
        "title": "报告", "agent": "test_report_agent", "llm_calls": 1,
        "requires": ["exec"], "produces": "reports",
        "required": ["facts", "verdict"], "confirm": False,
        "note": "数字只读；洞察可空；必须能回答回归三问",
    },
}

PHASE_ORDER = tuple(PHASES.keys())
CONFIRM_GATES = tuple(k for k, v in PHASES.items() if v["confirm"])

# 产物 kind -> 产出它的阶段（需求、计划等只由一处产出，一对一）
KIND_TO_PHASE: dict[str, str] = {v["produces"]: k for k, v in PHASES.items()}
# 例外：maps 由 onboard 与 explore 共同产出，取"更强"的那个阶段的契约做校验
KIND_TO_PHASE["maps"] = "explore"


def _required_of(kind: str) -> list[str]:
    owner = KIND_TO_PHASE.get(kind)
    return list(PHASES[owner]["required"]) if owner else []


def check_prereq(phase: str, artifacts: dict[str, dict] | None,
                 *, strict: bool = True) -> dict:
    """前置产物契约校验。**缺了就拒绝执行，不给 LLM 编造的机会（§5.4）。**

    artifacts: {kind: 产物}，如 {"plans": {...}, "maps": {...}}
    strict=True 时连必需字段一起查：产物存在但为空壳（刚建目录、没跑过）也算缺。
    这是实测坑——空 plans 目录被当成"已有计划"，然后跑出 0 步还标 pass。
    """
    spec = PHASES.get(phase)
    if not spec:
        return {"ok": False, "missing": [], "invalid": [],
                "advice": f"未知阶段 {phase!r}，合法值 {PHASE_ORDER}"}
    arts = artifacts or {}
    missing, invalid = [], []
    for need in spec["requires"]:
        art = arts.get(need)
        if not art:
            missing.append(need)
            continue
        if not strict:
            continue
        lack = [f for f in _required_of(need)
                if f not in art or art[f] is None or art[f] == ""]
        if lack:
            invalid.append({"kind": need, "missing_fields": lack})
    ok = not missing and not invalid
    if ok:
        advice = "前置产物齐备，可执行"
    elif missing:
        advice = (f"缺前置产物 {missing}：请先跑对应阶段。"
                  f"**不允许由 LLM 现场编造上游产物**（§5.4）")
    else:
        advice = ("前置产物是空壳（"
                  + "; ".join(f"{i['kind']} 缺 {i['missing_fields']}" for i in invalid)
                  + "）：视为未产出，请重跑对应阶段")
    return {"ok": ok, "phase": phase, "missing": missing, "invalid": invalid,
            "advice": advice}


def can_run(phase: str, artifacts: dict[str, dict] | None,
            confirmed: dict[str, bool] | set[str] | None = None) -> dict:
    """能否执行某阶段：前置齐备 + 上游确认卡点已过。"""
    pre = check_prereq(phase, artifacts)
    if not pre["ok"]:
        return pre
    done = set(confirmed or ())
    need = []
    for up in PHASES[phase]["requires"]:
        owner = KIND_TO_PHASE.get(up)
        if owner and PHASES[owner]["confirm"] and up not in done and owner not in done:
            need.append(up)
    if need:
        return {"ok": False, "phase": phase, "missing": [], "invalid": [],
                "blocked_by_confirm": need,
                "advice": f"上游确认卡点未过：{need}（§5.5 确认点不可省略）"}
    return {"ok": True, "phase": phase, "missing": [], "invalid": [],
            "advice": "可执行"}


@dataclass
class PhaseState:
    """七阶段状态机——替代"让 agent 用 LLM 决定下一步派给谁"。

    §17.3 原话：`test_agent` 的「派发决策从 LLM 判断改为状态机 + 规则表」，
    且**不得自行决定跳过阶段**。这个类就是那条规则的执行体。

    状态流转：pending → running → done；上游变更 → stale（产物保留）。
    """

    status: dict[str, str] = field(
        default_factory=lambda: {p: "pending" for p in PHASE_ORDER})
    confirmed_by_kind: set[str] = field(default_factory=set)
    artifacts: dict[str, dict] = field(default_factory=dict)
    history: list[dict] = field(default_factory=list)

    def start(self, phase: str) -> dict:
        if phase not in self.status:
            return {"ok": False, "error": f"unknown_phase:{phase}"}
        gate = can_run(phase, self.artifacts, self.confirmed_by_kind)
        if not gate["ok"]:
            return {"ok": False, "error": "prereq_failed", **gate}
        if self.status[phase] == "done":
            return {"ok": False, "error": "already_done",
                    "advice": "已完成；要重跑请先 invalidate 或 reset"}
        self.status[phase] = "running"
        self.history.append({"phase": phase, "event": "start"})
        return {"ok": True, "phase": phase, "status": "running"}

    def finish(self, phase: str, artifact: dict) -> dict:
        """阶段完成并登记产物。必需字段不到位就不许标 done。"""
        spec = PHASES.get(phase)
        if not spec:
            return {"ok": False, "error": f"unknown_phase:{phase}"}
        if self.status.get(phase) != "running":
            return {"ok": False, "error": "not_running",
                    "advice": f"当前状态 {self.status.get(phase)}，须先 start"}
        lack = [f for f in spec["required"]
                if not isinstance(artifact, dict) or f not in artifact
                or artifact[f] is None or artifact[f] == ""]
        if lack:
            return {"ok": False, "error": "artifact_incomplete",
                    "missing_fields": lack,
                    "advice": f"产物缺必需字段 {lack}，不允许标完成（§5.3 产物契约）"}
        self.artifacts[spec["produces"]] = artifact
        self.status[phase] = "done"
        self.history.append({"phase": phase, "event": "done"})
        return {"ok": True, "phase": phase, "status": "done",
                "needs_confirm": spec["confirm"], "next": self._next(phase)}

    def confirm(self, phase: str, by: str = "human") -> dict:
        """人工确认卡点（只有人能过，agent 自审不算）。"""
        if phase not in CONFIRM_GATES:
            return {"ok": False, "error": "no_confirm_gate", "phase": phase}
        if self.status.get(phase) != "done":
            return {"ok": False, "error": "not_done", "advice": "阶段未完成，不能确认"}
        if not str(by).startswith("human"):
            return {"ok": False, "error": "agent_cannot_confirm",
                    "advice": "确认卡点只能由人签（§5.5）：agent 自审等于没有确认"}
        self.confirmed_by_kind.add(PHASES[phase]["produces"])
        self.history.append({"phase": phase, "event": "confirmed", "by": by})
        return {"ok": True, "phase": phase,
                "confirmed": sorted(self.confirmed_by_kind)}

    def _next(self, phase: str) -> str | None:
        for p in PHASE_ORDER[PHASE_ORDER.index(phase) + 1:]:
            if self.status.get(p) != "done":
                return p
        return None

    def blocked(self) -> dict:
        """哪些阶段被卡住、卡在哪——给用户看的那一版。"""
        blocked = {}
        for p in PHASE_ORDER:
            if self.status[p] == "done":
                continue
            gate = can_run(p, self.artifacts, self.confirmed_by_kind)
            if not gate["ok"]:
                blocked[p] = gate.get("advice")
        return {"blocked": blocked,
                "runnable": [p for p in PHASE_ORDER
                             if self.status[p] in ("pending", "running")
                             and p not in blocked]}

    def snapshot(self) -> dict:
        return {"status": dict(self.status),
                "confirmed": sorted(self.confirmed_by_kind),
                "artifacts": sorted(self.artifacts),
                "history": list(self.history)}


def _downstream_of(changed: str) -> list[str]:
    """changed 变更后需要作废的下游阶段（传递闭包，按 PHASE_ORDER 顺序）。"""
    produced = PHASES[changed]["produces"]
    dirty_kinds = {produced}
    out = []
    for p in PHASE_ORDER[PHASE_ORDER.index(changed) + 1:]:
        if dirty_kinds & set(PHASES[p]["requires"]):
            out.append(p)
            dirty_kinds.add(PHASES[p]["produces"])
    return out


def invalidate(state: PhaseState, changed_phase: str,
               only: list[str] | None = None) -> dict:
    """上游变更 → 下游作废（§5.5 判据 ③ 可独立失效）。

    链式失效是物理事实，不能回避；能优化的是**只作废受影响的范围**（§6.2 增量重算
    的前置条件）——`only` 用于传入"实际受影响的子集"，不传则整段作废（保守）。

    作废 ≠ 删除：产物保留但标 stale，报告里必须写"结论基于旧版本"。
    """
    if changed_phase not in PHASES:
        return {"ok": False, "error": f"unknown_phase:{changed_phase}"}
    downstream = _downstream_of(changed_phase)
    if only is not None:
        downstream = [p for p in downstream if p in set(only)]
    staled = []
    for p in downstream:
        if state.status[p] == "done":
            state.status[p] = "stale"
            staled.append(p)
    state.confirmed_by_kind -= {PHASES[p]["produces"] for p in downstream}
    state.history.append({"phase": changed_phase, "event": "invalidate",
                          "staled": staled})
    return {"changed": changed_phase, "staled": staled,
            "note": ("产物保留但标记 stale，未删除；报告须标注结论基于旧版本"
                     if staled else "无下游已完成阶段受影响，无需作废")}


def phase_plan() -> list[dict]:
    """给前端 / 文档用的阶段清单（agent、LLM 调用数、前置、确认点）。"""
    return [{"phase": n, "title": s["title"], "agent": s["agent"],
             "llm_calls": s["llm_calls"], "requires": s["requires"],
             "confirm": s["confirm"], "note": s["note"]}
            for n, s in PHASES.items()]
