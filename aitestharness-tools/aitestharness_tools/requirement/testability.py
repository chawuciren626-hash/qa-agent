"""10.2 可测性检查器（Validator，纯规则）—— v3 §10.2 完整四项：
  无预期结果 / 无边界 / 缺前置 / 表述歧义
与 acceptance.py 的"可观察性检查"互补：acceptance.check 面向验收标准（断言来源链），
本文件面向需求项本体（是否可写成测试）。
"""
from __future__ import annotations

from .parsers import AMBIGUOUS_WORDS

__all__ = ["check_testability"]

# 触发"无边界"的信号词
BOUNDARY_HINTS = ("最多", "至少", "上限", "下限", "长度", "数量", "范围", "超时",
                  "字符", "次", "分钟", "秒", "条", "个")


def check_testability(req_item: dict) -> list[dict]:
    """req_item: {id, title, description, expected, preconditions, module}
    返回问题清单 [{rule, level, message, hint}]。
      T1 error 无预期结果   T2 warn 无边界/无数值约束
      T3 warn 缺前置条件    T4 error 表述歧义（歧义词）
    """
    problems = []
    rid = req_item.get("id") or "?"
    desc = str(req_item.get("description") or "")
    title = str(req_item.get("title") or "")
    blob = title + desc
    if not (req_item.get("expected") or "").strip():
        problems.append({"rule": "T1", "level": "error", "item": rid,
                         "message": "无预期结果，无法写出 decide 断言",
                         "hint": "补 expected：观察到什么即算通过"})
    if not any(h in blob for h in BOUNDARY_HINTS) and not any(c.isdigit() for c in blob):
        problems.append({"rule": "T2", "level": "warn", "item": rid,
                         "message": "无边界/无数值约束，测试点矩阵的边界格子无从填起",
                         "hint": "确认是否存在长度/数量/范围/超时限制，有则写明数值"})
    if not (req_item.get("preconditions") or "").strip():
        problems.append({"rule": "T3", "level": "warn", "item": rid,
                         "message": "缺前置条件，plan 的 setup 无法固化",
                         "hint": "补 preconditions：账号态、数据态、入口"})
    for w in AMBIGUOUS_WORDS:
        if w in blob:
            problems.append({"rule": "T4", "level": "error", "item": rid,
                             "message": f"表述歧义：含歧义词'{w}'",
                             "hint": "换成可观察、可判定的表述"})
            break
    return problems
