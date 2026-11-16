"""§11.3 四类共用的工具（二）：自愈分级判定器 + 凭证与环境中心。

自愈分级（§11.3/§15，heal_level L1/L2/L3）：规则通用、实现各异；
本文件是**编译期/归因期**的确定性判定规则——"能不能自愈、怎么自愈"由规则判，
L2 的"新指纹"由 Agent 在受控窗口内给出，但进入计划必须走五闸重校验。

凭证与环境中心（§11.3）：账号/环境/密钥集中管理，**禁止写进计划**
（数据闸已约束）；支持环境域名切换与接口 token 刷新。
"""
from __future__ import annotations

import time
import threading

__all__ = ["classify_for_heal", "HEAL_LEVELS", "CredentialCenter"]

HEAL_LEVELS = {
    "L1": "定位自愈：换指纹（按备选序列降级）。自动，必须记录并计入资产健康度",
    "L2": "等待自愈：延长等待 / 追加等待条件，**限一次**。自动，必须记录",
    "L3": "步骤自愈：跳过步骤、替换步骤、改变操作目标 —— **禁止自动**，转人工或直接 fail",
}

# ---- 自愈分级判定（严格对齐 v3 §12.8；红线：只允许让用例"能跑通"，
#      绝不允许让"该失败的变成通过"）----
_L1_SIGNALS = ("NoSuchElement", "not found", "not_found", "element_not_found",
               "no such element", "locator_not_found", "locator_ambiguous")
_L2_SIGNALS = ("timeout", "TimeoutError", "wait_timeout", "network", "net::ERR",
               "loading", "ECONNREFUSED", "ETIMEDOUT")


def classify_for_heal(fail_step: dict, heal_history: dict | None = None) -> dict:
    """失败步骤 → {level, action, allowed, reason}。

    heal_history: {"L1": 次数, "L2": 次数}（来自 exec.self_heal 记录）
    规则（§12.8）：
      - decide 断言失败 → 永不自愈（业务结果，不是执行问题）→ L3 禁自动
      - 元素未找到/多命中 → L1 换指纹
      - 超时/网络/加载未就绪 → L2 延长或追加等待（限一次，用过后再遇 → L3）
      - 未知签名 → L3 转人工（宁可转人不赌自愈）
    """
    hist = heal_history or {}
    if any(a.get("level", "decide") == "decide" and not a.get("passed")
           for a in fail_step.get("assertions") or []):
        return {"level": "L3", "action": "escalate_human", "allowed": False,
                "reason": "decide 断言失败属业务结果，禁止任何自愈（红线）"}
    blob = str(fail_step.get("action") or "") + str(fail_step.get("error") or "")
    if any(s in blob for s in _L1_SIGNALS):
        return {"level": "L1", "action": "refind_locator", "allowed": True,
                "reason": "定位失败：换指纹（降级必记录，计入健康度）"}
    if any(s in blob for s in _L2_SIGNALS):
        if hist.get("L2", 0) >= 1:
            return {"level": "L3", "action": "escalate_human", "allowed": False,
                    "reason": "等待自愈已用过一次（§12.8 限一次），不再延长"}
        return {"level": "L2", "action": "extend_wait", "allowed": True,
                "reason": "超时/网络抖动：延长等待或追加等待条件（限一次）"}
    return {"level": "L3", "action": "escalate_human", "allowed": False,
            "reason": "未知失败签名，宁可转人工不赌自愈"}


# ---- 凭证与环境中心 ----
class CredentialCenter:
    """集中管理账号/环境/密钥；计划里只允许 ${data.*} 与环境名引用。

    - 环境：{name: {base_url: {...}, tokens: {...}}}
    - token 管理器（§11.4 接口专有，但放这里供四类共用）：按 account 缓存 token，
      过期自动刷新（刷新器由调用方注入——本包不内置任何真实登录逻辑）。
    - 线程安全：接口池 20~50 并发下共享。
    """

    def __init__(self, environments: dict | None = None):
        self._envs = environments or {}
        self._tokens: dict[str, tuple[str, float]] = {}   # key -> (token, expires_at)
        self._lock = threading.Lock()

    def register_env(self, name: str, base_url: str, extras: dict | None = None):
        self._envs[name] = {"base_url": base_url, "extras": extras or {}}

    def resolve_base_url(self, env_name: str, service: str = "default") -> str:
        env = self._envs.get(env_name)
        if not env:
            raise KeyError(f"环境 '{env_name}' 未注册（禁止在计划中硬编码域名）")
        urls = env["base_url"]
        if isinstance(urls, dict):
            if service not in urls:
                raise KeyError(f"环境 {env_name} 未注册服务 '{service}'")
            return urls[service]
        return urls

    def set_token_refresher(self, key: str, refresher):
        """refresher() -> (token, ttl_seconds)；由 Adapter 注入真实登录逻辑。"""
        self._refreshers = getattr(self, "_refreshers", {})
        self._refreshers[key] = refresher

    def get_token(self, key: str) -> str:
        with self._lock:
            tok, exp = self._tokens.get(key, (None, 0))
            if tok and time.time() < exp:
                return tok
            refresher = getattr(self, "_refreshers", {}).get(key)
            if refresher is None:
                raise KeyError(f"token '{key}' 无缓存且无刷新器")
            tok, ttl = refresher()
            self._tokens[key] = (tok, time.time() + max(ttl - 30, 10))  # 提前 30s 续期
            return tok

    def invalidate_token(self, key: str):
        with self._lock:
            self._tokens.pop(key, None)
