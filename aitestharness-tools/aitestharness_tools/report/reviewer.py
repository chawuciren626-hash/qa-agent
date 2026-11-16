"""报告阶段工具（v3 第 16 章：报告 Agent = 审阅者，不是写手）：
1. extract_facts — 从 exec 结果抽取 facts（纯数字/统计，agent 不可编造的段落）
2. RiskLedger — 风险台账状态机（new→tracking→mitigated→…），每轮报告洞察沉淀于此
3. REVIEWER_PROMPT — 审阅者系统提示词包（服务端下发档，产品可调）
纪律：数字只读、洞察挂引用、允许空输出、facts/insights 分段。
"""
from __future__ import annotations

from collections import Counter
from datetime import date

__all__ = ["extract_facts", "RiskLedger", "REVIEWER_PROMPT"]

_VERDICTS = ("pass", "fail", "flaky", "skipped", "inconclusive")


def extract_facts(execs: list[dict]) -> dict:
    """从一批 exec IR 抽取 facts。所有数字均直接来自 exec，报告 agent 不得改写。

    facts 结构：
      runs / verdicts{pass,fail,...} / pass_rate /
      top_failures(按 plan 聚合) / inconclusive_reasons(kind 计数) /
      flaky_plans / duration_s_total
    """
    if not execs:
        return {"runs": 0, "note": "无可统计的执行记录（允许空输出）"}
    verdict_counts = Counter()
    by_plan: dict[str, list[str]] = {}
    inconcl_kinds: Counter = Counter()
    total_ms = 0
    for e in execs:
        v = e.get("verdict")
        verdict_counts[v if v in _VERDICTS else "inconclusive"] += 1
        pid = (e.get("plan") or {}).get("id") or "unknown"
        by_plan.setdefault(pid, []).append(v)
        total_ms += sum(s.get("duration_ms") or 0 for s in e.get("steps") or [])
        for s in e.get("steps") or []:
            for ic in (s.get("inconclusive") or {}).get("kinds", []) or []:
                inconcl_kinds[ic] += 1
    flaky = [pid for pid, vs in by_plan.items() if len(set(vs)) > 1]
    runs = len(execs)
    return {
        "runs": runs,
        "verdicts": dict(verdict_counts),
        "pass_rate": round(verdict_counts["pass"] / runs, 4),
        "top_failures": sorted(
            [{"plan": pid, "fail_runs": vs.count("fail") + vs.count("flaky")}
             for pid, vs in by_plan.items()
             if vs.count("fail") + vs.count("flaky") > 0],
            key=lambda x: -x["fail_runs"])[:10],
        "flaky_plans": sorted(flaky),
        "inconclusive_reasons": dict(inconcl_kinds),
        "duration_s_total": total_ms // 1000,
    }


class RiskLedger:
    """风险台账：洞察只有带 exec 引用才准入账（洞察挂引用），状态机受控流转。"""

    TRANSITIONS = {
        "new": {"tracking", "accepted", "closed", "escalated"},
        "tracking": {"mitigated", "escalated", "closed"},
        "mitigated": {"closed", "tracking"},      # 复发可回 tracking
        "accepted": {"closed", "escalated"},
        "escalated": {"tracking", "closed"},
        "closed": set(),
    }

    def __init__(self, items: list[dict] | None = None):
        self.items = {i["id"]: i for i in (items or [])}
        self._seq = len(self.items)

    def add(self, description: str, refs: list[str], source: str = "report-reviewer",
            status: str = "new") -> dict:
        if not refs:
            raise ValueError("风险必须挂至少一个产物引用（exec/defect/plan id），拒绝无引用洞察")
        self._seq += 1
        rid = f"risk-{self._seq:04d}"
        self.items[rid] = {"id": rid, "description": description, "refs": refs,
                           "source": source, "status": status,
                           "created_at": date.today().isoformat(), "history": []}
        return self.items[rid]

    def transition(self, risk_id: str, to: str, actor: str, note: str = "") -> dict:
        item = self.items.get(risk_id)
        if not item:
            raise KeyError(risk_id)
        if to not in self.TRANSITIONS.get(item["status"], set()):
            raise ValueError(f"非法流转 {item['status']} → {to}；"
                             f"合法目标：{sorted(self.TRANSITIONS[item['status']])}")
        item["history"].append({"from": item["status"], "to": to,
                                "actor": actor, "note": note,
                                "at": date.today().isoformat()})
        item["status"] = to
        return item

    def open_items(self) -> list[dict]:
        return [i for i in self.items.values() if i["status"] != "closed"]


REVIEWER_PROMPT = """你是 AITestHarness 的报告审阅者。你审阅执行结果并产出报告草稿（draft），\
对外导出必须经人工确认（approved），你无权直接发出报告。

纪律（违反任何一条即为无效输出）：
1. facts 段：只允许使用工具 extract_facts 给出的数字，一个都不许改写、估算、四舍五入。\
没有数据就写"无数据"，禁止编造。
2. insights 段：每条洞察必须挂至少一个产物引用（exec/defect/plan id），\
格式如「[exec-8820] 登录步骤在 3 次复跑中出现 2 种结果」。无引用的洞察不许输出。
3. 允许空输出：本轮没有值得说的洞察时，insights 段写"无"，不要凑数。
4. 风险：你发现的每个风险都通过 RiskLedger.add 入账（必须带引用），\
不得在报告里私设"风险"段落而不入台账。
5. 你只判断"测得怎么样、哪里可疑"，不做"要不要放行发布"的决策——那是人工确认卡点的事。

输出结构：
## facts
（extract_facts 的原样数字 + 一句话趋势描述）
## insights
（每条带 [引用] 的洞察，可为"无"）
## risks
（本轮新增/升级的台账条目 id 清单）
## caveat
（本轮结论的适用范围与不成立场景，必填）"""
