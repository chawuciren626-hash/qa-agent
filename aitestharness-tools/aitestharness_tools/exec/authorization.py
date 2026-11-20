"""写操作授权闸（P4 判据 3）：有副作用才能改数据，而副作用必须先被批准。

为什么这是一个独立的闸，而不是 preflight 里的一个分支
--------------------------------------------------
两个闸回答的是完全不同的问题：

    preflight   → "这个环境还值得跑吗"（基线是否可信，跑出来的结论可不可比）
    authorization → "这一步允许改数据吗"（有没有人批准过这个副作用）

合成一个函数会立刻产生一个错误推论：**基线 ok = 授权 ok**。真实验收里正是这样
出的事——"允许创建"是人在对话里口头给的许可，系统里没有任何记录，而 preflight
一切正常。两本账必须分开记。

要解决的问题不是"防攻击"，是"防误操作"
--------------------------------------
这个闸的能力边界必须说清，否则会产生虚假的安全感：

  · **不校验签名**。授权记录是本地的、可被同一用户改写的。它挡不住有意伪造。
  · 它挡的是四类真实事故，这四类恰好是自动化最容易出的：
      1. 忘了授权就跑 —— 脚本一键跑起来，直接改了生产数据；
      2. 批准过的不是这一份计划 —— 批的是 A 计划，跑的是改过的 A'（多了删除动作）；
      3. 跨环境挪用 —— 在测试环境批的，拿去跑了预发/生产；
      4. 一次批准反复使用 —— 批的是"建一个账号"，跑成了建一百个。

  前三条靠绑定（计划哈希 / 环境 ID / 动作白名单），第四条靠单次使用。
  真正的防伪造要靠签名与签发方，那属于服务端（P5/M1）的事，见 §8.6 分工。

三个设计取舍（都不是随手定的）
------------------------------
1. **哈希只覆盖"会改变行为"的字段，排除 assert / wait / evidence。**
   授权批的是"改什么"，不是"看什么"。若把断言也算进哈希，改一个字断言就要重新
   审批，人的实际反应是**绕过授权**（写个万能 approval），闸就退化成仪式。
   代价是"删掉断言换取通过"不受此闸约束——但那不改副作用，且属于结论质量问题，
   由 decide 断言与 replay 一致性管。

2. **teardown 一并纳入授权范围。**
   清理本身是写操作（点注销就是提交）。若要求单独授权清理，最可能的结果是：
   主流程批了、清理没批 → 拒绝清理 → 残留数据留在被测系统里。
   "批准创建"天然应当包含"批准把这个创建物清理掉"。

3. **缺少 env_id 一律拒绝，不做降级。**
   环境校验是"跨环境挪用"的唯一防线。允许"没有 env_id 就跳过校验"，等于默认
   放行最危险的那条路径。宁可让调用方补一个参数，也不给降级口子。

与 preflight 的 verdict 语义保持一致
-----------------------------------
`allow=False` 时给 `verdict="invalid"`，不是 `fail`——被测系统没有坏，是这次执行
不该被允许。下游报告层据此区分"产品有问题"和"没被授权改数据"。
"""
from __future__ import annotations

import hashlib
import json
import re
from datetime import datetime, timezone
from typing import Any, Mapping

from .consistency import SAFE_API_METHODS, web_action_writes

__all__ = ["authorize_plan", "plan_fingerprint", "plan_actions",
           "AUTHORIZATION_STATUSES", "APPROVAL_FIELDS", "build_approval"]

# 闸的出口穷举（调用方据此分支，不做真假值判断）
AUTHORIZATION_STATUSES = (
    "not_required",        # 计划里没有任何写动作，闸不参与
    "approved",            # 授权有效且覆盖本计划
    "missing_approval",    # 有写动作但没给授权
    "approval_corrupt",    # 授权记录结构不完整（缺字段/类型不对）
    "plan_mismatch",       # 批准的不是这份计划
    "env_mismatch",        # 批准的不是这个环境
    "env_unverifiable",    # 调用方没给 env_id，无法确认在哪个环境执行
    "expired",             # 已过期
    "already_used",        # 单次授权已被用过
    "actions_not_covered", # 授权没覆盖计划里出现的某类写动作
)

# 一条授权记录必须具备的字段（缺一即 approval_corrupt，不做"缺了就默认"）
APPROVAL_FIELDS = ("id", "issued_by", "issued_at", "plan_hash", "env_id", "actions")

_METHOD_RE = re.compile(r"^(GET|HEAD|OPTIONS|POST|PUT|PATCH|DELETE)\s+\S+", re.I)
# 不参与指纹的键：观测条件，不是行为
_OBSERVATION_KEYS = frozenset({"assert", "wait", "evidence", "verify_gone", "note", "comment"})


# ---------------------------------------------------------------- 指纹
def _strip_observation(node: Any) -> Any:
    """递归去掉"只影响观测、不影响副作用"的字段。

    见模块说明取舍 1。注意是**白名单外的都保留**：将来计划新增字段时默认进入指纹，
    宁可多批一次，也不要漏掉一个能改变行为的字段。
    """
    if isinstance(node, Mapping):
        return {str(k): _strip_observation(v) for k, v in node.items()
                if k not in _OBSERVATION_KEYS}
    if isinstance(node, (list, tuple)):
        return [_strip_observation(item) for item in node]
    return node


def _canonical(payload: Any) -> str:
    return json.dumps(payload, sort_keys=True, ensure_ascii=False, separators=(",", ":"))


def plan_fingerprint(plan: Mapping[str, Any]) -> str:
    """计划指纹：锁住"要改什么"，不锁"要断言什么"。

    覆盖：driver、target/env、steps 的全部字段（除观测类）、teardown.steps。
    `lineage.version` 也在其中——版本号变了说明计划被改过，应当重新审批。
    """
    teardown = plan.get("teardown") or {}
    payload = {
        "driver": plan.get("driver"),
        # 计划指向哪个系统也属于"改什么"的一部分：换 target 等于换了施害对象
        "target": plan.get("target") or plan.get("base_url") or plan.get("env"),
        "lineage": plan.get("lineage"),
        "steps": _strip_observation(plan.get("steps") or []),
        "teardown": _strip_observation(teardown.get("steps") if isinstance(teardown, Mapping) else []),
    }
    return hashlib.sha256(_canonical(payload).encode("utf-8")).hexdigest()


# ---------------------------------------------------------------- 动作分类
def _step_action(step: Mapping[str, Any], driver: str) -> tuple[str, bool]:
    """返回 (动作名, 是否有副作用)。未知动作按**有副作用**处理。"""
    if driver == "api" or step.get("request"):
        request = str(step.get("request") or "")
        matched = _METHOD_RE.match(request)
        if not matched:
            # 没写 method 的请求步骤：无法判断，按写处理（保守方向）
            return request.strip() or "(未声明)", True
        method = matched.group(1).upper()
        return method, method not in SAFE_API_METHODS
    action = str(step.get("action") or "").strip()
    if not action:
        return "(未声明)", True
    # 只有显式声明为只读的动作才放行；未声明（含将来新增的动作）一律按写处理
    return action, web_action_writes(action)


def plan_actions(plan: Mapping[str, Any]) -> dict:
    """把计划拆成"会改数据的动作"和"只读动作"，供授权范围比对。"""
    driver = str(plan.get("driver") or "web").strip().lower()
    steps: list[dict] = []
    mutating: set[str] = set()

    def walk(items: Any, phase: str) -> None:
        for index, step in enumerate(items or []):
            if not isinstance(step, Mapping):
                continue
            action, writes = _step_action(step, driver)
            steps.append({"phase": phase, "index": index, "action": action, "mutating": writes})
            if writes:
                mutating.add(action)

    # session 段（登录/取 token）也遍历：它是 POST，会建会话。
    # 不算进来的后果很具体——把写操作塞进 session 段就能绕过授权闸，
    # 而"批准这份计划"本来就该涵盖它的前置。
    walk(plan.get("session"), "session")
    walk(plan.get("steps"), "step")
    teardown = plan.get("teardown") or {}
    if isinstance(teardown, Mapping):
        walk(teardown.get("steps"), "teardown")

    return {
        "driver": driver,
        "steps": steps,
        "mutating": sorted(mutating),
        "mutating_count": len(mutating),
        "has_mutation": bool(mutating),
    }


# ---------------------------------------------------------------- 时间
def _parse_ts(value: Any) -> datetime | None:
    text = str(value or "").strip()
    if not text:
        return None
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


# ---------------------------------------------------------------- 闸
def _deny(status: str, reasons: list[str], *, actions: dict,
          approval: Mapping[str, Any] | None, plan_hash: str, env_id: str | None) -> dict:
    return {
        "allow": False,
        "status": status,
        "verdict": "invalid",
        "reasons": reasons,
        "plan_hash": plan_hash,
        "env_id": env_id,
        "required_actions": actions["mutating"],
        "approval_id": (approval or {}).get("id"),
        # 授权记录未经签名校验：报告层不许把它当"已批准"之外的任何承诺
        "trust": "asserted",
    }


def authorize_plan(plan: Mapping[str, Any], approval: Mapping[str, Any] | None = None,
                   *, env_id: str | None = None,
                   now: datetime | str | None = None) -> dict:
    """判断这份计划在当前环境是否被允许执行。

    参数：
        plan      计划本体；本项目只看它"会不会改数据"以及"改什么"
        approval  授权记录；None 表示没有授权
        env_id    本次执行所在环境标识（如 `bbiao-admin@local`）。
                  **必须给**——不给就无从判断"是不是跨环境挪用"，直接拒绝。
        now       判定时间（测试注入用），默认当前 UTC

    返回 `allow` / `status` / `verdict` / `reasons`。`allow=False` 时调用方不应执行。
    """
    actions = plan_actions(plan)
    plan_hash = plan_fingerprint(plan)
    if not actions["has_mutation"]:
        # 只读计划不需要授权：给"所有执行都要审批"会让闸变成无差别摩擦，
        # 人就会形成"审批一律通过"的习惯——那比没有闸更危险。
        return {
            "allow": True, "status": "not_required", "verdict": "pass",
            "reasons": ["计划不含写动作，无需授权"],
            "plan_hash": plan_hash, "env_id": env_id,
            "required_actions": [], "approval_id": None, "trust": "n/a",
        }

    if approval is None:
        return _deny("missing_approval",
                     [f"计划含写动作 {actions['mutating']}，但未提供授权记录；"
                      f"写操作必须由人显式批准后执行"],
                     actions=actions, approval=None, plan_hash=plan_hash, env_id=env_id)

    if not isinstance(approval, Mapping):
        return _deny("approval_corrupt", ["授权记录不是映射"],
                     actions=actions, approval=None, plan_hash=plan_hash, env_id=env_id)

    missing = [field for field in APPROVAL_FIELDS if not str(approval.get(field) or "").strip()]
    if missing:
        # 不给"缺字段就按宽松处理"的口子：缺 issued_by 的授权无法追溯是谁批的，
        # 缺 actions 的授权无法界定批了什么
        return _deny("approval_corrupt", [f"授权记录缺少字段：{missing}"],
                     actions=actions, approval=approval, plan_hash=plan_hash, env_id=env_id)

    covered = approval.get("actions")
    if not isinstance(covered, (list, tuple)):
        return _deny("approval_corrupt", ["授权记录的 actions 必须是列表"],
                     actions=actions, approval=approval, plan_hash=plan_hash, env_id=env_id)

    if not env_id:
        return _deny("env_unverifiable",
                     [f"调用方未提供 env_id，无法确认执行环境；授权绑定的是 {approval.get('env_id')}"],
                     actions=actions, approval=approval, plan_hash=plan_hash, env_id=env_id)

    if str(approval.get("env_id")) != str(env_id):
        return _deny("env_mismatch",
                     [f"授权绑定环境 {approval.get('env_id')}，本次执行环境 {env_id}；"
                      f"在测试环境批的授权不能用于其它环境"],
                     actions=actions, approval=approval, plan_hash=plan_hash, env_id=env_id)

    if str(approval.get("plan_hash")) != plan_hash:
        return _deny("plan_mismatch",
                     [f"授权绑定的计划指纹 {str(approval.get('plan_hash'))[:12]}… 与本计划 "
                      f"{plan_hash[:12]}… 不一致：批准的不是这一份计划（改过动作、目标或环境）"],
                     actions=actions, approval=approval, plan_hash=plan_hash, env_id=env_id)

    moment = now if isinstance(now, datetime) else (_parse_ts(now) if now else datetime.now(timezone.utc))
    if moment is None:
        return _deny("approval_corrupt", ["now 无法解析为时间"],
                     actions=actions, approval=approval, plan_hash=plan_hash, env_id=env_id)

    expires = _parse_ts(approval.get("expires_at"))
    if expires is not None and moment >= expires:
        return _deny("expired",
                     [f"授权已于 {approval.get('expires_at')} 过期（判定时间 {moment.isoformat()}）"],
                     actions=actions, approval=approval, plan_hash=plan_hash, env_id=env_id)

    if approval.get("single_use") and str(approval.get("used_at") or "").strip():
        return _deny("already_used",
                     [f"单次授权已于 {approval.get('used_at')} 使用过；"
                      f"重新执行需要新的批准（一次批准不能被反复消费）"],
                     actions=actions, approval=approval, plan_hash=plan_hash, env_id=env_id)

    uncovered = sorted(set(actions["mutating"]) - {str(a) for a in covered})
    if uncovered:
        return _deny("actions_not_covered",
                     [f"授权未覆盖这些写动作：{uncovered}（已批准：{sorted({str(a) for a in covered})}）"],
                     actions=actions, approval=approval, plan_hash=plan_hash, env_id=env_id)

    return {
        "allow": True,
        "status": "approved",
        "verdict": "pass",
        "reasons": [f"授权 {approval.get('id')} 有效：{approval.get('issued_by')} 于 "
                    f"{approval.get('issued_at')} 批准 {sorted({str(a) for a in covered})}"],
        "plan_hash": plan_hash,
        "env_id": env_id,
        "required_actions": actions["mutating"],
        "approval_id": approval.get("id"),
        "issued_by": approval.get("issued_by"),
        "expires_at": approval.get("expires_at"),
        "trust": "asserted",
    }


def build_approval(plan: Mapping[str, Any], *, env_id: str, issued_by: str,
                   actions: list[str] | None = None, approval_id: str | None = None,
                   ttl_minutes: int | None = None, single_use: bool = True,
                   note: str = "", now: datetime | None = None) -> dict:
    """按计划生成一条授权记录（供管理端/人审批时调用，不是给执行器自己用的）。

    `actions` 缺省时取计划里实际出现的写动作——**这是便利不是安全**：它让"批准
    这份计划"变成默认语义。需要收窄范围时（比如只批 click 不批 press）显式传入。

    这个函数存在的原因：让"批准"这件事有一个明确的产物（有 id、有签发人、有范围），
    而不是对话里的一句"可以"。签发方是本函数调用者，执行器不校验签名。
    """
    moment = now or datetime.now(timezone.utc)
    required = plan_actions(plan)["mutating"]
    scope = sorted({str(a) for a in (actions if actions is not None else required)})
    record = {
        "id": approval_id or f"APR-{moment.strftime('%Y%m%d-%H%M%S')}-{plan_fingerprint(plan)[:8]}",
        "issued_by": issued_by,
        "issued_at": moment.isoformat().replace("+00:00", "Z"),
        "plan_hash": plan_fingerprint(plan),
        "env_id": env_id,
        "actions": scope,
        "single_use": bool(single_use),
        "used_at": None,
        "note": note,
    }
    if ttl_minutes is not None:
        from datetime import timedelta
        record["expires_at"] = (moment + timedelta(minutes=ttl_minutes)).isoformat().replace("+00:00", "Z")
    lineage = plan.get("lineage") or {}
    if isinstance(lineage, Mapping) and lineage.get("id"):
        record["plan_id"] = str(lineage.get("id"))
    return record
