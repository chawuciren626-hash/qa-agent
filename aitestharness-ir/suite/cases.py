"""S 层校验用例集（V-01~V-08、V-38、PERM）。

设计纪律：**每个反例只改一处**。
若一个反例改了三个字段，就无法证明是哪条规则拦住的 —— 这是测试设计的基本盘，
也是最容易被"快点写完"破坏的地方。

`kind` 三种：
- doc     ：加载基线对象 → 深拷贝 → 单点变异（大多数用例）
- raw     ：改写 YAML **原文**再加载（V-38 必须在解析阶段捕获，对象层测不出来）
- payload ：agent 提交的片段（PERM 分权检查）
"""

from __future__ import annotations

import copy
from dataclasses import dataclass, field as dc_field
from pathlib import Path
from typing import Callable

from irval import loader

BASE = Path(__file__).resolve().parent.parent / "fixtures"


def _load(name: str) -> dict:
    return copy.deepcopy(loader.load_file(str(BASE / name)))


def _raw(name: str) -> str:
    return (BASE / name).read_text(encoding="utf-8")


@dataclass
class Case:
    name: str
    kind: str                      # doc | raw | payload
    expect: str                    # accepted | rejected
    code: str | None = None
    field: str | None = None
    rule: str = ""
    base: str | None = None
    mutate: Callable[[dict], None] | None = None
    text_mutate: Callable[[str], str] | None = None
    payload: dict | None = None
    writer: str = "agent:test_case_agent"
    registry: set[tuple[str, int]] | None = None
    #: 追加进产物库的额外文档（V-40 需要同一 ID 的历史版本才能算变更次数）
    store_extra: list[dict] = dc_field(default_factory=list)
    note: str = ""


def doc(name, base, mutate=None, **kw) -> Case:
    return Case(name=name, kind="doc", base=base, mutate=mutate, **kw)


def raw(name, base, text_mutate, **kw) -> Case:
    return Case(name=name, kind="raw", base=base, text_mutate=text_mutate, **kw)


def payload(name, body, **kw) -> Case:
    return Case(name=name, kind="payload", payload=body, **kw)


# ------------------------------------------------------------------ 变异器

def _del(key: str):
    def f(d):
        d.pop(key, None)
    return f


def _set(path: str, value):
    """按 `a.b[0].c` 形式设置值。"""
    def f(d):
        cur = d
        parts = path.replace("[", ".").replace("]", "").split(".")
        for p in parts[:-1]:
            cur = cur[int(p)] if p.isdigit() else cur[p]
        last = parts[-1]
        if last.isdigit():
            cur[int(last)] = value
        else:
            cur[last] = value
    return f


def _unset(path: str):
    """按路径删除键（用于"字段缺失"类变异，区别于"设为 null"）。"""
    def f(d):
        cur = d
        parts = path.replace("[", ".").replace("]", "").split(".")
        for p in parts[:-1]:
            cur = cur[int(p)] if p.isdigit() else cur[p]
        last = parts[-1]
        if last.isdigit():
            cur.pop(int(last))
        else:
            cur.pop(last, None)
    return f


ACCEPT = "accepted"
REJECT = "rejected"


# ---------------------------------------------------------- v1.1 用例辅助

def _tp_expectation_state(state: str) -> dict:
    """覆盖产物库里的 TP-0045-02@1，把 E-01 的 `state` 设成指定值。

    同 id 同 version 进 Store 会覆盖基线那份，这是刻意的：
    用它模拟"这条预期被人显式标过状态"，v1.0 产物则完全没有这个字段。
    """
    d = _load("test_point.valid.yaml")
    d["expected"][0]["state"] = state
    d["expected"][0]["source"] = {"type": "doc", "ref": "PRD-v3 §3.2 第2段",
                                  "quote": "满 100 减 10"}
    return d


def _tp_history(values: list[str], last_state: str | None = None) -> list[dict]:
    """构造同一 ID 的若干历史版本，`E-01` 的 value 依次取 `values`。

    V-40 只看「实质内容变过几次」，所以每次改 value 就够——
    改 statement 也行，但改 `source`/`state` 不该计入（那是补溯源，不是改预期）。
    """
    docs = []
    for i, value in enumerate(values, start=1):
        d = _load("test_point.provenanced.yaml")
        d["version"] = i
        d["expected"][0]["value"] = value
        if last_state and i == len(values):
            d["expected"][0]["state"] = last_state
        docs.append(d)
    return docs


def _as_current_version(version: int, state: str | None = None):
    """把基线改造成"当前提交的这一版"。"""
    def f(d: dict) -> None:
        d["version"] = version
        if state:
            d["expected"][0]["state"] = state
    return f


CASES: list[Case] = [
    # ---------------- V-01 公共头 ----------------
    doc("V01-N01", "plan.valid.yaml", expect=ACCEPT, rule="V-01",
        note="基线完整，应通过"),
    doc("V01-N02", "plan.valid.yaml", _set("derived_from", []), expect=ACCEPT, rule="V-01",
        note="derived_from 为空数组合法（探索产物无上游），空≠缺失"),
    doc("V01-A01", "plan.valid.yaml", _del("derived_from"), expect=REJECT,
        code="SCHEMA_HEADER_MISSING", field="derived_from", rule="V-01",
        note="缺血缘上游，变更传播会失效"),
    doc("V01-A02", "plan.valid.yaml", _del("content_hash"), expect=REJECT,
        code="SCHEMA_HEADER_MISSING", field="content_hash", rule="V-01",
        note="缺语义指纹，表述变更也会触发全量重算"),
    doc("V01-A03", "plan.valid.yaml", _set("approved_by", []), expect=REJECT,
        code="SCHEMA_APPROVED_NEEDS_APPROVER", field="approved_by", rule="V-01",
        note="approved 无人工确认人"),

    # ---------------- V-02 枚举封闭 ----------------
    doc("V02-N01", "exec.valid.yaml", expect=ACCEPT, rule="V-02",
        note="verdict=fail 在枚举内"),
    doc("V02-A01", "exec.valid.yaml", _set("verdict", "基本通过"), expect=REJECT,
        code="SCHEMA_ENUM_INVALID", field="verdict", rule="V-02",
        note="LLM 自造结论，这一条拦不住五档结论就形同虚设"),
    doc("V02-A02", "plan.valid.yaml", _set("steps[2].wait[0].type", "sleep"), expect=REJECT,
        code="SCHEMA_ENUM_INVALID", field="steps[2].wait[0].type", rule="V-02",
        note="sleep 不是合法等待类型"),
    doc("V02-A03", "plan.valid.yaml", _set("steps[2].wait[0].type", "waitForTimeout"),
        expect=REJECT, code="SCHEMA_ENUM_INVALID", field="steps[2].wait[0].type",
        rule="V-02", note="Playwright 专有写法，DSL 不允许"),

    # ---- V-02 end 端标签（重构方案 §4：设计产物带端标签）----
    doc("V02-N04", "test_point.valid.yaml", _set("end", "web"), expect=ACCEPT,
        rule="V-02", note="测试点带合法端标签"),
    doc("V02-N05", "case.valid.yaml", _set("end", "api"), expect=ACCEPT,
        rule="V-02", note="用例带合法端标签"),
    doc("V02-N06", "test_point.valid.yaml", _set("end", ""), expect=ACCEPT,
        rule="V-02", note="空串=未指定，不是非法值"),
    doc("V02-N07", "test_point.valid.yaml", expect=ACCEPT, rule="V-02",
        note="缺省 end 合法：v1.0 旧产物没有该字段，不得因缺省被拒"),
    doc("V02-N08", "test_point.valid.yaml", _set("end", "web_admin"), expect=ACCEPT,
        rule="V-02", note="多端项目：管理后台端"),
    doc("V02-N09", "case.valid.yaml", _set("end", "app"), expect=ACCEPT,
        rule="V-02", note="多端项目：移动端"),
    doc("V02-N10", "test_point.valid.yaml", _set("end", "miniprogram"), expect=ACCEPT,
        rule="V-02", note="多端项目：小程序端"),
    doc("V02-N11", "case.valid.yaml", _set("end", "desktop"), expect=ACCEPT,
        rule="V-02", note="多端项目：桌面端"),
    doc("V02-A04", "test_point.valid.yaml", _set("end", "小程序"), expect=REJECT,
        code="SCHEMA_ENUM_INVALID", field="end", rule="V-02",
        note="中文端名不在封闭枚举内，按端统计锚定率会分叉"),
    doc("V02-A05", "case.valid.yaml", _set("end", "h5"), expect=REJECT,
        code="SCHEMA_ENUM_INVALID", field="end", rule="V-02",
        note="自造端名：h5 应归入 web，枚举封闭不允许别名"),
    doc("V02-A06", "test_point.valid.yaml", _set("end", "Web"), expect=REJECT,
        code="SCHEMA_ENUM_INVALID", field="end", rule="V-02",
        note="枚举大小写敏感，Web 不等于 web"),

    # ---------------- V-03 ID ----------------
    doc("V03-N01", "test_point.valid.yaml", expect=ACCEPT, rule="V-03"),
    doc("V03-A01", "test_point.valid.yaml", _set("id", "TESTPOINT-0045-02"), expect=REJECT,
        code="SCHEMA_ID_PREFIX_INVALID", field="id", rule="V-03",
        note="前缀非法"),
    doc("V03-A02", "case.valid.yaml", _set("id", "CASE-123"), expect=REJECT,
        code="SCHEMA_ID_FORMAT_INVALID", field="id", rule="V-03",
        note="CASE 需 5 位序号"),
    doc("V03-N02", "case.valid.yaml", _set("version", 2), expect=ACCEPT, rule="V-03",
        registry={("CASE-00123", 1)},
        note="同 ID 新版本不是重复导入，按 id 去重会误杀版本"),
    doc("V03-A03", "case.valid.yaml", expect=REJECT,
        code="SCHEMA_ID_DUPLICATE", field="id", rule="V-03",
        registry={("CASE-00123", 1)},
        note="同 ID 同版本重复导入"),

    # ---------------- V-04 时间与数值 ----------------
    doc("V04-N01", "plan.valid.yaml", expect=ACCEPT, rule="V-04"),
    doc("V04-A01", "plan.valid.yaml", _set("created_at", "2026-11-13 17:00"),
        expect=REJECT, code="SCHEMA_TIME_NO_TIMEZONE", field="created_at", rule="V-04",
        note="无时区，跨时区协作会错位"),
    doc("V04-A02", "plan.valid.yaml", _set("created_at", "2026/11/13"), expect=REJECT,
        code="SCHEMA_TIME_FORMAT_INVALID", field="created_at", rule="V-04"),
    doc("V04-A03", "test_point.valid.yaml", _set("expected[0].value", 0), expect=REJECT,
        code="SCHEMA_NUMBER_NOT_STRING_DECIMAL", field="expected[0].value", rule="V-04",
        note="数值必须字符串十进制"),

    # ---------------- V-05 凭证明文 ----------------
    doc("V05-N01", "plan.valid.yaml", expect=ACCEPT, rule="V-05",
        note="引用形式 cred:// 合法"),
    doc("V05-A01", "plan.valid.yaml", _set("password", "Abc@123456"), expect=REJECT,
        code="SEM_CREDENTIAL_PLAINTEXT", field="password", rule="V-05",
        note="疑似口令明文"),
    doc("V05-A02", "plan.valid.yaml",
        _set("Authorization", "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"),
        expect=REJECT, code="SEM_CREDENTIAL_PLAINTEXT", field="Authorization", rule="V-05",
        note="JWT 明文"),
    doc("V05-A03", "plan.valid.yaml",
        _set("notes", "阿里云 AccessKey LTAI5tAbCdEfGh"), expect=REJECT,
        code="SEM_CREDENTIAL_PLAINTEXT", field="notes", rule="V-05",
        note="最常泄漏路径：为了排查方便写进备注"),

    # ---------------- V-06 approved 必填 ----------------
    doc("V06-N01", "plan.valid.yaml", expect=ACCEPT, rule="V-06"),
    doc("V06-A01", "plan.valid.yaml", _del("gates"), expect=REJECT,
        code="SCHEMA_APPROVED_FIELD_MISSING", field="gates", rule="V-06",
        note="approved 却无五闸结果"),
    doc("V06-N02", "plan.valid.yaml",
        lambda d: (d.pop("gates", None), d.update(status="draft", approved_by=[])),
        expect=ACCEPT, rule="V-06",
        note="draft 允许缺 —— 没有这层，编译中途的产物根本存不下来"),

    # ---------------- V-07 actor ----------------
    doc("V07-N01", "plan.valid.yaml", expect=ACCEPT, rule="V-07"),
    doc("V07-A01", "plan.valid.yaml", _set("created_by", "张三"), expect=REJECT,
        code="SCHEMA_ACTOR_FORMAT_INVALID", field="created_by", rule="V-07"),
    doc("V07-A02", "plan.valid.yaml", _set("created_by", "AI"), expect=REJECT,
        code="SCHEMA_ACTOR_FORMAT_INVALID", field="created_by", rule="V-07"),

    # ---------------- V-08 引用语法 ----------------
    doc("V08-N01", "case.valid.yaml", expect=ACCEPT, rule="V-08",
        note="断言来源带版本"),
    doc("V08-N02", "plan.valid.yaml", expect=ACCEPT, rule="V-08",
        note="${data.username} namespace 合法"),
    doc("V08-A01", "plan.valid.yaml", _set("steps[1].value", "${username}"), expect=REJECT,
        code="SCHEMA_REF_NAMESPACE_INVALID", field="steps[1].value", rule="V-08"),
    doc("V08-A02", "case.valid.yaml", _set("assertions[0].source", "TP-0045-02#E-01"),
        expect=REJECT, code="SCHEMA_REF_VERSION_REQUIRED", field="assertions[0].source",
        rule="V-08",
        note="省略版本会让测试点升版时用例自动跟随 → 自动通过但预期已错"),

    # ---------------- V-38 数值类型（解析层） ----------------
    raw("V38-N01", "requirement.valid.yaml", lambda t: t, expect=ACCEPT, rule="V-38"),
    raw("V38-A01", "requirement.valid.yaml",
        lambda t: t.replace('range: ["0.01", "999999.99"]', "range: [0.01, 999999.99]"),
        expect=REJECT, code="SCHEMA_FLOAT_NUMBER",
        field="data_constraints[0].range[0]", rule="V-38",
        note="YAML 浮点，解析阶段就必须拦"),
    raw("V38-A03", "requirement.valid.yaml",
        lambda t: t.replace('boundary: ["99.99", "100", "100.01"]', "boundary: [0.1, 0.2]"),
        expect=REJECT, code="SCHEMA_FLOAT_NUMBER",
        field="business_rules[0].boundary[0]", rule="V-38"),

    # ---------------- PERM 字段分权 ----------------
    payload("PERM-N01", {"module": "order", "labels": [], "notes": ""},
            expect=ACCEPT, rule="PERM", note="agent 合法字段"),
    payload("PERM-N02", {"expected": [{"id": "E-01", "matcher": "equals"}]},
            expect=ACCEPT, rule="PERM", note="嵌套业务字段属 agent 权利"),
    payload("PERM-A01", {"derived_from": ["REQ-0045@3"]}, expect=REJECT,
            code="PERM_AGENT_WROTE_PROGRAM_FIELD", field="derived_from", rule="PERM",
            note="血缘必须程序写，否则变更传播可被伪造"),
    payload("PERM-A02", {"content_hash": "sha256:deadbeef"}, expect=REJECT,
            code="PERM_AGENT_WROTE_PROGRAM_FIELD", field="content_hash", rule="PERM"),
    payload("PERM-A03", {"status": "approved"}, expect=REJECT,
            code="PERM_AGENT_WROTE_PROGRAM_FIELD", field="status", rule="PERM"),
    payload("PERM-A04", {"version": 9}, expect=REJECT,
            code="PERM_AGENT_WROTE_PROGRAM_FIELD", field="version", rule="PERM"),
    payload("PERM-A05", {"id": "CASE-99999"}, expect=REJECT,
            code="PERM_AGENT_WROTE_PROGRAM_FIELD", field="id", rule="PERM"),
    payload("PERM-A06", {"approved_by": ["human:lisi"]}, expect=REJECT,
            code="PERM_AGENT_WROTE_PROGRAM_FIELD", field="approved_by", rule="PERM"),
    payload("PERM-A07", {"gates": {"locator_unique": {"pass": True}}}, expect=REJECT,
            code="PERM_AGENT_WROTE_PROGRAM_FIELD", field="gates", rule="PERM",
            note="最关键的用例：agent 若能写 gates，五闸可自标全绿"),
    payload("PERM-A08", {"verdict": "pass"}, expect=REJECT,
            code="PERM_AGENT_WROTE_PROGRAM_FIELD", field="verdict", rule="PERM"),
]


# ======================================================================
# M 层（V-14~V-21、V-35、V-37）：单产物内语义
# ======================================================================

def _append_steps(n: int):
    def f(d):
        d["steps"] = d["steps"] + [
            {"id": f"s{i}", "intent": f"补充步骤{i}", "driver": "api"}
            for i in range(4, 4 + n)
        ]
    return f


CASES += [
    # ---- V-14 预期可判定 ----
    doc("V14-N01", "test_point.valid.yaml", expect=ACCEPT, rule="V-14"),
    doc("V14-A01", "test_point.valid.yaml", _unset("expected[0].observable"),
        expect=REJECT, code="SEM_EXPECTATION_NOT_DECIDABLE",
        field="expected[0].observable", rule="V-14",
        note="预期没有可观测对象 → 只能靠模型看图判断"),
    doc("V14-A02", "test_point.valid.yaml", _set("expected[0].matcher", None),
        expect=REJECT, code="SEM_EXPECTATION_NOT_DECIDABLE",
        field="expected[0].matcher", rule="V-14"),

    # ---- V-15 至少一条 decide ----
    doc("V15-N01", "case.valid.yaml", expect=ACCEPT, rule="V-15"),
    doc("V15-A01", "case.valid.yaml",
        lambda d: [a.update(level="observe") for a in d["assertions"]],
        expect=REJECT, code="SEM_NO_DECIDE_ASSERT", field="assertions", rule="V-15",
        note="全是 observe：跑出来永远 pass，等于没测"),
    doc("V15-A02", "case.valid.yaml", _set("assertions", []), expect=REJECT,
        code="SEM_NO_DECIDE_ASSERT", field="assertions", rule="V-15"),

    # ---- V-16 步骤预算 ----
    doc("V16-N01", "case.valid.yaml", expect=ACCEPT, rule="V-16"),
    doc("V16-A01", "case.valid.yaml", _append_steps(7), expect=REJECT,
        code="SEM_STEP_BUDGET_EXCEEDED", field="steps", rule="V-16",
        note="9 步超 8 步预算：应拆分，否则失败难归因"),
    doc("V16-N02", "case.valid.yaml",
        lambda d: (_append_steps(7)(d), d["budget"].update(max_steps=12)),
        expect=ACCEPT, rule="V-16",
        note="人工显式放宽预算即合法：预算是提醒拆分，不是硬墙"),

    # ---- V-17 五闸 ----
    doc("V17-N01", "plan.valid.yaml", expect=ACCEPT, rule="V-17"),
    doc("V17-A01", "plan.valid.yaml", _set("gates.locator_unique.pass", False),
        expect=REJECT, code="SEM_GATE_NOT_PASSED", field="gates.locator_unique",
        rule="V-17"),
    doc("V17-A02", "plan.valid.yaml", _set("gates.replay_verified.exec_ref", None),
        expect=REJECT, code="SEM_GATE_EVIDENCE_MISSING",
        field="gates.replay_verified.exec_ref", rule="V-17",
        note="防伪造：没有真实执行记录的 pass 不算数"),

    # ---- V-18 等待 ----
    doc("V18-N01", "plan.valid.yaml", expect=ACCEPT, rule="V-18"),
    doc("V18-A01", "plan.valid.yaml",
        lambda d: d["steps"].append({"id": "s4", "intent": "硬等", "action": "wait", "ms": 3000}),
        expect=REJECT, code="SEM_SLEEP_FORBIDDEN", field="steps[3].ms", rule="V-18"),
    doc("V18-A02", "plan.valid.yaml", _set("steps[2].wait[0].idle_ms", 3000),
        expect=REJECT, code="SEM_WAIT_TOO_LONG", field="steps[2].wait[0].idle_ms",
        rule="V-18", note="等待过长说明同步策略没学对，是 flaky 头号来源"),

    # ---- V-19 定位 ----
    doc("V19-N01", "plan.valid.yaml", expect=ACCEPT, rule="V-19"),
    doc("V19-N02", "plan.valid.yaml",
        _set("steps[2].target.locators", [{"xpath": "//button[normalize-space()='登录']"}]),
        expect=ACCEPT, rule="V-19",
        note="语义 xpath 稳定，不该一刀切禁 xpath；判据是是否依赖层级索引"),
    doc("V19-A01", "plan.valid.yaml",
        _set("steps[2].target.locators", [{"css": "/html/body/div[2]/div[1]/button[3]"}]),
        expect=REJECT, code="SEM_ABSOLUTE_PATH_FORBIDDEN",
        field="steps[2].target.locators[0].css", rule="V-19"),
    doc("V19-A02", "plan.valid.yaml",
        _set("steps[2].target.locators", [{"xpath": "//*[@id='app']/div[4]/form/button"}]),
        expect=REJECT, code="SEM_ABSOLUTE_PATH_FORBIDDEN",
        field="steps[2].target.locators[0].xpath", rule="V-19"),
    doc("V19-A03", "plan.valid.yaml",
        _set("steps[2].target.locators", [{"coord": {"x": 320, "y": 480}}]),
        expect=REJECT, code="SEM_COORDINATE_FORBIDDEN",
        field="steps[2].target.locators[0].coord", rule="V-19"),

    # ---- V-20 verdict 一致性 ----
    doc("V20-N01", "_baseline-exec-pass.yaml", expect=ACCEPT, rule="V-20"),
    doc("V20-A01", "_baseline-exec-pass.yaml", _set("assertions[0].result", "fail"),
        expect=REJECT, code="SEM_VERDICT_CONTRADICTS_ASSERT", field="verdict",
        rule="V-20",
        note="处置是强制改判 fail 而非拒绝：极可能是断言引擎漏汇总，拒绝会丢掉真实事实"),
    doc("V20-N02", "_baseline-exec-pass.yaml", _set("assertions[1].result", "fail"),
        expect=ACCEPT, rule="V-20", note="observe 断言失败不参与判定"),
    doc("V20-N03", "_baseline-exec-pass.yaml", _set("verdict", "flaky"),
        expect=ACCEPT, rule="V-20", note="flaky 是更高优先级的结论"),

    # ---- V-21 inconclusive ----
    doc("V21-N01", "_baseline-exec-inconclusive.yaml", expect=ACCEPT, rule="V-21"),
    doc("V21-N02", "exec.valid.yaml", expect=ACCEPT, rule="V-21",
        note="非 inconclusive 时 kind 为空是正确状态"),
    doc("V21-A01", "_baseline-exec-inconclusive.yaml", _set("inconclusive_kind", None),
        expect=REJECT, code="SEM_INCONCLUSIVE_NO_KIND", field="inconclusive_kind",
        rule="V-21", note="没有原因会被当成没跑，掩盖环境问题"),
    doc("V21-A02", "_baseline-exec-pass.yaml", _set("inconclusive_kind", "env_unreachable"),
        expect=REJECT, code="SEM_KIND_ON_PASS", field="inconclusive_kind", rule="V-21",
        note="pass 带 kind 说明状态机写串了，会让环境问题统计虚高"),

    # ---- V-35 matcher ----
    doc("V35-N01", "test_point.valid.yaml", expect=ACCEPT, rule="V-35",
        note="between 带 min/max"),
    doc("V35-N02", "test_point.valid.yaml",
        _set("expected[0]", {"id": "E-01", "statement": "99.99 元不享受满减",
                             "observable": "order.discount_amount",
                             "matcher": "abs_diff",
                             "matcher_args": {"tolerance": "0.01"},
                             "value": "0"}),
        expect=ACCEPT, rule="V-35", note="abs_diff 带 tolerance"),
    doc("V35-A01", "test_point.valid.yaml",
        _set("expected[0].matcher", "abs(actual - expected) < 0.01"), expect=REJECT,
        code="SEM_MATCHER_NOT_WHITELISTED", field="expected[0].matcher", rule="V-35",
        note="禁自由表达式：不是安全问题，是可判定性问题"),
    doc("V35-A02", "test_point.valid.yaml", _set("expected[0].matcher", "between"),
        expect=REJECT, code="SEM_MATCHER_ARGS_MISSING", field="expected[0].matcher_args",
        rule="V-35"),
    doc("V35-A03", "test_point.valid.yaml",
        _set("expected[2].matcher_args", {"min": 9.99, "max": "10.01"}), expect=REJECT,
        code="SCHEMA_NUMBER_NOT_STRING_DECIMAL", field="expected[2].matcher_args.min",
        rule="V-35", note="S 层先拦类型，不必进到语义层"),
    doc("V35-A04", "test_point.valid.yaml",
        _set("expected[0]", {"id": "E-01", "observable": "order.discount_amount",
                             "matcher": "regex", "matcher_args": {"pattern": "(a+)+$"},
                             "value": "0"}),
        expect=REJECT, code="SEM_REGEX_UNSAFE", field="expected[0].matcher_args.pattern",
        rule="V-35", note="灾难性回溯能让整个 worker 挂死"),

    # ---- V-37 一 case 一 plan ----
    doc("V37-N01", "plan.valid.yaml", expect=ACCEPT, rule="V-37"),
    doc("V37-A01", "plan.valid.yaml", _set("id", "PLAN-00124"), expect=REJECT,
        code="SEM_MULTIPLE_PLANS_PER_CASE", field="case_ref", rule="V-37",
        note="第二个 plan 指向同一 case：环境差异必须入 variants/"),
    doc("V37-N02", "plan.valid.yaml", _set("is_variant", True), expect=ACCEPT,
        rule="V-37", note="从 variants/ 加载的变体不算新 plan"),

    # ---- V-38 补充 ----
    doc("V38-A02", "requirement.valid.yaml", _set("business_rules[0].boundary[1]", 100),
        expect=REJECT, code="SCHEMA_NUMBER_NOT_STRING_DECIMAL",
        field="business_rules[0].boundary[1]", rule="V-38"),
]


# ======================================================================
# X 层（V-27、V-30、V-31）：跨产物引用完整性
# ======================================================================

CASES += [
    # ---- V-27 血缘存在 ----
    doc("V27-N01", "plan.valid.yaml", expect=ACCEPT, rule="V-27"),
    doc("V27-A01", "plan.valid.yaml", _set("derived_from", ["REQ-0099@1"]),
        expect=REJECT, code="XREF_MISSING_TARGET", field="derived_from", rule="V-27"),
    doc("V27-A02", "plan.valid.yaml", _set("derived_from", ["REQ-0045@9"]),
        expect=REJECT, code="XREF_VERSION_NOT_FOUND", field="derived_from", rule="V-27",
        note="ID 存在但版本不存在，与完全不存在要区分"),
    doc("V27-A03", "plan.valid.yaml", _set("derived_from", ["REQ-0045"]),
        expect=REJECT, code="SCHEMA_REF_VERSION_REQUIRED", field="derived_from",
        rule="V-27", note="省略版本就无法做增量重算"),

    # ---- V-30 断言来源 ----
    doc("V30-N01", "case.valid.yaml", expect=ACCEPT, rule="V-30"),
    doc("V30-A01", "case.valid.yaml", _set("assertions[0].source", "TP-0045-02@1#E-99"),
        expect=REJECT, code="XREF_ASSERT_SOURCE_INVALID", field="assertions[0].source",
        rule="V-30"),
    doc("V30-A02", "case.valid.yaml", _set("assertions[0].source", "TP-0045-02#E-01"),
        expect=REJECT, code="SCHEMA_REF_VERSION_REQUIRED", field="assertions[0].source",
        rule="V-30", note="格式层先拦，不进到存在性检查"),
    doc("V30-A03", "case.valid.yaml", _set("assertions[0].source", "TP-0099-01@1#E-01"),
        expect=REJECT, code="XREF_MISSING_TARGET", field="assertions[0].source",
        rule="V-30"),
    doc("V30-A04", "case.valid.yaml", _set("assertions[0].source", None), expect=REJECT,
        code="XREF_ASSERT_SOURCE_INVALID", field="assertions[0].source", rule="V-30",
        note="模型倾向直接写断言而不给出处，必须硬拦"),

    # ---- V-31 引用完整性 ----
    doc("V31-N01", "plan.valid.yaml", expect=ACCEPT, rule="V-31"),
    doc("V31-A01", "plan.valid.yaml", _set("case_ref", "CASE-0099@1"), expect=REJECT,
        code="XREF_MISSING_TARGET", field="case_ref", rule="V-31"),
    doc("V31-A02", "plan.valid.yaml", _set("gates.replay_verified.exec_ref", "EXEC-9999@1"),
        expect=REJECT, code="XREF_GATE_EVIDENCE_NOT_FOUND",
        field="gates.replay_verified.exec_ref", rule="V-31",
        note="整套防假通过的最后一环"),
    doc("V31-A03", "exec.valid.yaml", _set("plan_ref", "PLAN-0099@1"), expect=REJECT,
        code="XREF_MISSING_TARGET", field="plan_ref", rule="V-31"),
    doc("V31-A04", "defect.valid.yaml", _set("found_by.exec_ref", "EXEC-9999@1"),
        expect=REJECT, code="XREF_MISSING_TARGET", field="found_by.exec_ref", rule="V-31"),

    # ---------------- V-39 预期溯源与判定上限（v1.1）----------------
    # 结构层：`test_point.expected[].source` 是对象，`case.assertions[].source`
    # 是字符串引用。同名不同义，照抄写法是最可能发生的错误，所以第一条反例就测它。
    doc("V39-N01", "test_point.provenanced.yaml", expect=ACCEPT, rule="V-39",
        note="source+state 齐全：一条 verified、一条 model/unverified、一条 derived/unverified"),
    doc("V39-N02", "test_point.provenanced.yaml", _set("expected[0].source.type", "human"),
        expect=ACCEPT, rule="V-39", note="human 来源与 doc 同权，可直接生效"),
    doc("V39-N03", "test_point.valid.yaml", expect=ACCEPT, rule="V-39",
        note="v1.0 产物完全没有 source/state——历史债务不在单条上拦（契约附录 C.3.1）"),
    doc("V39-A01", "test_point.provenanced.yaml",
        _set("expected[0].source", "TP-0045-02@1#E-01"),
        expect=REJECT, code="SCHEMA_EXPECT_SOURCE_INVALID", field="expected[0].source",
        rule="V-39",
        note="把断言引用写法照抄到预期溯源上：报错而不是猜，猜错的后果是溯源静默变成一句文本"),
    doc("V39-A02", "test_point.provenanced.yaml", _unset("expected[0].source"),
        expect=REJECT, code="SCHEMA_EXPECT_SOURCE_INVALID", field="expected[0].state",
        rule="V-39", note="无 source 却标 verified：无源即无信（R1）"),
    doc("V39-A03", "test_point.provenanced.yaml", _unset("expected[1].source.type"),
        expect=REJECT, code="SCHEMA_EXPECT_SOURCE_INVALID", field="expected[1].source.type",
        rule="V-39", note="source 缺 type 就无法判断这条预期凭什么可信"),
    doc("V39-A04", "test_point.provenanced.yaml", _set("expected[1].state", "verified"),
        expect=REJECT, code="SCHEMA_EXPECT_SOURCE_INVALID", field="expected[1].state",
        rule="V-39", note="source.type=model 不得标 verified（R2：模型不能自证）"),

    # 判定上限：verdict_cap 自己说了上限只到 inconclusive，verdict 却给 pass
    doc("V39-N04", "_baseline-exec-pass.yaml", expect=ACCEPT, rule="V-39",
        note="无 verdict_cap 视为未评估，不在单条上拦"),
    doc("V39-A05", "exec.verdict-cap-conflict.yaml", expect=REJECT,
        code="EXPECT_UNVERIFIED_PASS", field="verdict", rule="V-39",
        note="自相矛盾：上限 inconclusive 却给 pass——宁可报不知道，不可报以为知道"),
    doc("V39-A06", "exec.verdict-cap-conflict.yaml", _set("verdict_cap.applied", "false"),
        expect=REJECT, code="SCHEMA_VERDICT_CAP_INVALID", field="verdict_cap.applied",
        rule="V-39", note="字符串 \"false\" 在 Python 里是真值，压低的结论会漏报"),

    # 跨产物：真去查引用的 expected 有没有被确认
    doc("V39-N05", "_baseline-exec-pass.yaml", expect=ACCEPT, rule="V-39",
        store_extra=[_tp_expectation_state("verified")],
        note="引用的预期已人工确认，这个 pass 站得住"),
    doc("V39-A07", "_baseline-exec-pass.yaml", expect=REJECT,
        code="EXPECT_UNVERIFIED_PASS", field="verdict", rule="V-39",
        store_extra=[_tp_expectation_state("unverified")],
        note="预期已明确标注未确认，结论仍是 pass——R4 一票通过制，等于替模型推测背书"),

    # ---------------- V-40 预期漂移（v1.1）----------------
    doc("V40-N01", "test_point.provenanced.yaml", _as_current_version(4),
        store_extra=_tp_history(["0", "0", "0"]),
        expect=ACCEPT, rule="V-40", note="三个版本的预期内容完全一致，不构成漂移"),
    doc("V40-N02", "test_point.provenanced.yaml", _as_current_version(4, "drifted"),
        store_extra=_tp_history(["0", "5", "0"]),
        expect=ACCEPT, rule="V-40",
        note="改过 2 次但已标 drifted——规则要求的是标注，不是禁止修改"),
    doc("V40-A01", "test_point.provenanced.yaml", _as_current_version(4),
        store_extra=_tp_history(["0", "5", "0"]),
        expect=REJECT, code="EXPECT_DRIFT", field="expected[0].state", rule="V-40",
        note="预期改过 2 次却仍标 verified——把预期改到能过，通过率就变成噪声了"),
]
