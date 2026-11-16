"""需求阶段工具：
1. acceptance_observable_check — 验收标准"可观察性"检查
   （断言来源链第一环：requirement.acceptance[].observable，IR 契约 V-14 上游）
2. change_impact — 需求变更影响分析：哪些测试点/用例/计划需要重算

两者均为确定性规则，零 LLM；"把自然语言抽取成 observable"是 agent 的活，
抽取完的结果交给本工具验守门。
"""
from __future__ import annotations

from dataclasses import dataclass

__all__ = ["check_acceptance_observable", "change_impact"]

# observable 至少要包含的要素：被观察对象 + 观察点（元素/接口/数据）
_OBSERVABLE_VERBS = ("显示", "出现", "返回", "跳转", "高亮", "禁用", "启用",
                     "提示", "记录", "发送", "写入", "更新", "数量", "状态",
                     "title", "status", "code", "message", "text", "visible")


@dataclass
class Finding:
    level: str          # error / warn
    path: str
    message: str
    hint: str = ""


def check_acceptance_observable(requirement: dict) -> list[Finding]:
    """检查 requirement.acceptance[] 每条是否"可观察"。

    可观察 = 能被某个确定性手段（DOM 文本 / 接口响应 / DB 记录 / 计数）证实。
    判据（启发式白名单，与口令启发式同一纪律：先白名单再规则）：
      E1 error：acceptance 为空 → 需求不可测
      E2 error：observable 缺失或为空字符串
      E3 error：observable 只有主观词（美观/好用/流畅/合理 等）无任何可观察锚点
      W1 warn：observable 超长（>200 字符），疑似把多条验收标准挤在一条
    """
    findings: list[Finding] = []
    acc = requirement.get("acceptance") or []
    if not acc:
        findings.append(Finding("error", "acceptance",
                                "E1: 无任何验收标准，需求不可测",
                                "至少补充一条可观察的验收标准"))
        return findings
    subjective_words = ("美观", "好用", "流畅", "合理", "易用", "友好", "体验好")
    for i, item in enumerate(acc):
        path = f"acceptance.{i}"
        obs = (item.get("observable") or "").strip() if isinstance(item, dict) else str(item or "").strip()
        if not obs:
            findings.append(Finding("error", f"{path}.observable",
                                    "E2: observable 缺失", "补写：观察到什么即算通过"))
            continue
        has_anchor = any(v in obs for v in _OBSERVABLE_VERBS) or any(c.isdigit() for c in obs)
        if not has_anchor:
            findings.append(Finding(
                "error", f"{path}.observable",
                f"E3: 观察不到客观锚点（主观描述）：{obs[:40]}…",
                f"改为含可观察对象的陈述，如'提交后 toast 文本包含 X / 接口返回 code=0'；"
                f"注意：含以下主观词需改写 {subjective_words}"))
        if len(obs) > 200:
            findings.append(Finding("warn", f"{path}.observable",
                                    "W1: 单条验收标准超 200 字符，疑似多条挤在一条",
                                    "拆分为多条 acceptance"))
    return findings


def change_impact(old_req: dict, new_req: dict,
                  downstream: list[dict]) -> dict:
    """需求变更影响分析。

    downstream: 依赖该需求的所有下游产物列表，每份含
      {kind, id, version, lineages: {requirement: "<req-id>@<ver>"}}（或 derived_from 结构）
    返回：{semantic_changes, affected: [...], unaffected_count}
    影响判定：需求发生语义变更 ⇒ derived_from 指向该需求（旧版本）的产物全部"待重算"。
    """
    from ..common.semantic_diff import semantic_diff, needs_recompute
    changes = semantic_diff(old_req, new_req)
    semantic = [c for c in changes if c.cls == "semantic"]
    req_id = new_req.get("lineage", {}).get("id") or old_req.get("lineage", {}).get("id")
    old_ver = old_req.get("lineage", {}).get("version")
    affected = []
    for item in downstream:
        df = item.get("lineage", {}).get("derived_from") or []
        hit = any(d.get("id") == req_id and (old_ver is None or d.get("version") == old_ver)
                  for d in df)
        if hit and needs_recompute(changes):
            affected.append({"kind": item.get("kind"), "id": item.get("lineage", {}).get("id"),
                             "action": "recompute",
                             "reason": f"上游 requirement {req_id}@{old_ver} 语义变更"})
    return {
        "requirement_id": req_id,
        "semantic_changes": [{"field": c.field, "before": c.before, "after": c.after} for c in semantic],
        "presentation_changes_count": sum(1 for c in changes if c.cls == "presentation"),
        "affected": affected,
    }
