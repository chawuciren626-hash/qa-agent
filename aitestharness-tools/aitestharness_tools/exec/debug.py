"""§12.10 可单步调试（刚需）：断点 / 单步 / 查看状态 / 断点处接管。

关键洞察（§12.10）："单步调试"与"演示可见"是同一套能力（有头 + 步骤级暂停 + 状态可视化），
做一份两个场景都受益。本文件是不依赖浏览器的**执行控制器**（deterministic 状态机），
供引擎在任何 driver 上复用。
"""
from __future__ import annotations

__all__ = ["DebugController", "TakeoverSession"]


class DebugController:
    """执行控制器：断点、单步、继续、状态查看。

    modes：run（无头批量）/ headed（有头演示，高亮+录屏）/ debug（单步）
    """

    def __init__(self, mode: str = "run", breakpoints: list[int] | None = None):
        if mode not in ("run", "headed", "debug"):
            raise ValueError("mode must be run|headed|debug")
        self.mode = mode
        self.breakpoints = set(breakpoints or [])
        self.paused_at: int | None = None
        self.state: dict = {}
        self.history: list[dict] = []

    def before_step(self, index: int, step: dict) -> str:
        """每步执行前调用，返回动作：'proceed' | 'pause'。"""
        self.state.setdefault("vars", {})
        should_pause = (index in self.breakpoints) or self.mode == "debug"
        if should_pause:
            self.paused_at = index
            return "pause"
        return "proceed"

    def inspect(self) -> dict:
        """断点处查看：当前 DOM 摘要与变量（供 UI 展示，不解析语义）。"""
        return {"paused_at": self.paused_at,
                "vars": dict(self.state.get("vars") or {}),
                "dom_summary": self.state.get("dom_summary"),
                "trace": self.history[-5:]}

    def step_over(self) -> str:
        """单步：解除当前暂停，执行下一步后再次暂停（debug 模式下自动生效）。"""
        self.paused_at = None
        return "proceed"

    def cont(self) -> str:
        """继续到下一个断点（debug 模式降级为 headed，避免再次每步暂停）。"""
        self.paused_at = None
        if self.mode == "debug":
            self.mode = "headed"
        return "proceed"

    def record(self, index: int, step: dict, status: str, duration_ms: int | None = None):
        self.history.append({"index": index, "action": step.get("action"),
                             "status": status, "duration_ms": duration_ms})

    def take_over(self, reason: str, mode: str = "blocking") -> "TakeoverSession":
        """断点处接管（阻塞式 / 断点式 / 修正式，§12.7 三种模式之一）。"""
        return TakeoverSession(self, reason, mode=mode)


class TakeoverSession:
    """人工接管会话：人只完成引擎做不到的那一小段，然后交回（不是"人替引擎跑"）。"""

    MODES = ("blocking", "breakpoint", "correction")

    def __init__(self, controller: DebugController, reason: str, mode: str = "blocking"):
        if mode not in self.MODES:
            raise ValueError(f"mode must be {self.MODES}")
        self.controller = controller
        self.reason = reason
        self.mode = mode
        self.actions: list[dict] = []      # 修正式：人操作一段，引擎记录并可编译为片段

    def human_action(self, action: dict):
        self.actions.append(action)

    def hand_back(self, current_state: dict, next_step: dict,
                  extract_touched_fn=None) -> dict:
        """交回：必须做三步状态重新对齐（§12.7），否则拒绝继续。"""
        from ..defect.evidence import realign_after_takeover
        res = realign_after_takeover(current_state, next_step, extract_touched_fn)
        res["takeover"] = {"reason": self.reason, "mode": self.mode,
                           "recorded_actions": len(self.actions),
                           "compilable_fragment": self.mode == "correction"}
        return res
