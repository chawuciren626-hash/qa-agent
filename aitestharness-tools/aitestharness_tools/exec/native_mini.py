"""§11.4 Web / App / 小程序 专有工具（确定性规则部分；运行时依赖 Playwright/Appium，M2 建）。

1. LocResolver      — 多指纹定位规则：指纹优先级、备选序列生成（Web 多指纹 +
                       native accessibility_id/id/xpath/class_chain + 小程序 selector）
2. DeviceQueue      — 设备串行队列（§11.4 明确建议：初期不做真机池，单设备串行）
3. PopupPolicyChain — App 系统权限弹窗策略链 + 小程序宿主级弹窗策略链
风险高的设备池/真机矩阵：按 §11.4 建议不做，此队列即"单设备串行"的最小实现。
"""
from __future__ import annotations

import threading
import time

__all__ = ["LocResolver", "DeviceQueue", "PopupPolicyChain",
           "WEB_FINGERPRINT_PRIORITY", "NATIVE_STRATEGIES"]

WEB_FINGERPRINT_PRIORITY = ("testid", "aria", "css", "text", "xpath")
NATIVE_STRATEGIES = ("accessibility_id", "id", "class_chain", "xpath")


class LocResolver:
    """多指纹定位规则（编译期）：
    - 校验 locators 全部使用白名单策略（DSL 禁止 driver 专有写法，差异由 target 块承载）
    - 生成备选序列（主指纹失败按优先级降级），并要求 ≥2 指纹（五道闸闸 1 的运行时面）
    """

    def plan_order(self, target: dict) -> dict:
        kind = target.get("kind")
        if kind == "web":
            strategies = [l.get("testid") and "testid" or l.get("role") and "aria"
                          or l.get("css") and "css" or l.get("text") and "text"
                          or l.get("xpath") and "xpath" for l in target.get("locators") or []]
            strategies = [s for s in strategies if s]
        elif kind == "native":
            strategies = [target.get("strategy")] if target.get("strategy") else []
        elif kind == "miniprogram":
            strategies = ["selector"] if target.get("selector") else []
        else:
            return {"ok": False, "error": f"unknown target.kind {kind!r}"}
        bad = [s for s in strategies
               if s not in WEB_FINGERPRINT_PRIORITY and s not in NATIVE_STRATEGIES
               and s != "selector"]
        if bad:
            return {"ok": False, "error": f"定位策略 {bad} 不在白名单"}
        if not strategies:
            return {"ok": False, "error": "target 未给出任何白名单内定位指纹"
                    f"（web: {WEB_FINGERPRINT_PRIORITY} / native: {NATIVE_STRATEGIES}"
                    " / miniprogram: selector）"}
        # 降级序列：主指纹在前，其余按全局优先级
        order = sorted(set(strategies),
                       key=lambda s: (WEB_FINGERPRINT_PRIORITY.index(s)
                                      if s in WEB_FINGERPRINT_PRIORITY else 99))
        return {"ok": True, "kind": kind, "primary": order[0] if order else None,
                "fallback_order": order,
                "warn": None if len(order) >= 2 else "仅单一指纹，无降级空间（闸 1 建议 ≥2 指纹）"}


class DeviceQueue:
    """单设备串行队列（§11.4：设备池是独立子系统，初期不做池化）。

    acquire(device_id, timeout) 拿锁；释放后才轮到下一条——杜绝设备争抢型 flaky。
    """

    def __init__(self):
        self._locks: dict[str, threading.Lock] = {}
        self._guard = threading.Lock()

    def _lock_for(self, device_id: str) -> threading.Lock:
        with self._guard:
            return self._locks.setdefault(device_id, threading.Lock())

    def acquire(self, device_id: str, timeout_s: float = 60.0) -> dict:
        lock = self._lock_for(device_id)
        t0 = time.time()
        got = lock.acquire(timeout=timeout_s)
        return {"acquired": got, "device_id": device_id,
                "waited_s": round(time.time() - t0, 2),
                "hint": None if got else "设备占用超时：串行队列不排队抢，请检查未释放的会话"}

    def release(self, device_id: str):
        lock = self._lock_for(device_id)
        if lock.locked():
            lock.release()


class PopupPolicyChain:
    """弹窗策略链（App 系统权限弹窗 / 小程序宿主弹窗）：
    按序尝试的确定性策略；每条策略 = {match, handle}。
    match 是弹窗识别文本集合；handle ∈ {accept, dismiss, wait, abort}。
    策略链走服务端下发档（管理员维护），不内置在安装包里写死。"""

    HANDLE_ACTIONS = ("accept", "dismiss", "wait", "abort")

    def __init__(self, policies: list[dict]):
        bad = [p for p in policies if p.get("handle") not in self.HANDLE_ACTIONS]
        if bad:
            raise ValueError(f"handle 必须是 {self.HANDLE_ACTIONS}，非法条目：{bad}")
        self.policies = policies

    def resolve(self, popup_texts: list[str]) -> dict:
        """popup_texts：当前屏幕识别到的弹窗文本列表 → 命中第一条策略的动作。"""
        for policy in self.policies:
            for kw in policy.get("match") or []:
                for t in popup_texts:
                    if kw in t:
                        return {"hit": True, "handle": policy["handle"],
                                "policy": policy, "popup_text": t}
        return {"hit": False, "handle": "abort",
                "hint": "未命中任何策略：默认 abort（宁可停下不瞎点，防误授权）"}
