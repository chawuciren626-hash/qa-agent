"""§11.7 调度分池：接口/Web/设备/小程序/桌面五池，混合用例进主 driver 池。

默认容量（§11.7）：接口 20~50 无资源限制、Web=CPU 核心数、设备 1~2、小程序 1~2、
桌面 1（屏幕是整机独占资源，两条桌面 run 并行就是互相点击对方的窗口）。
混合用例 → 分配到主 driver 的池；执行中向辅助池申请资源（辅助资源本工具只记账不分配）。

桌面池的进入方式：driver_kind 枚举不新增（v2 §6.4 的 IR 变更纪律），计划里显式声明
`pool: "desktop"`；driver 侧仍是 native（桌面 GUI 属原生应用测试），只是资源归口不同。
"""
from __future__ import annotations

import os

from ..irval.enums import ENUMS

__all__ = ["PoolScheduler"]

_DRIVER_TO_POOL = {
    "api": "api_pool",
    "web": "web_pool",
    "native": "device_pool",
    "miniprogram": "miniprogram_pool",
    "db": "api_pool",          # db 断言无独占资源，随接口池
}
_DESKTOP_POOL = "desktop_pool"
# 计划里的池声明名 → caps 键。桌面计划写 pool:"desktop"；caps 键是资源池全名。
_LANE_TO_POOL = {"desktop": _DESKTOP_POOL}


class PoolScheduler:
    def __init__(self, capacities: dict | None = None, cpu_default: bool = True):
        web_cap = (capacities or {}).get("web_pool") or (
            os.cpu_count() if cpu_default else 4)
        caps = {
            "api_pool": (capacities or {}).get("api_pool", 20),      # 默认 20，上限 50
            "web_pool": web_cap,
            "device_pool": (capacities or {}).get("device_pool", 1),  # §11.4：单设备串行
            "miniprogram_pool": (capacities or {}).get("miniprogram_pool", 1),
            "desktop_pool": (capacities or {}).get("desktop_pool", 1),  # 单屏独占：默认 1
        }
        self.caps = caps
        self.in_use = {k: 0 for k in caps}
        # 混合用例的辅助资源记账（只统计占用，容量按各池独立约束）
        self._aux_leased: list[dict] = []

    def submit(self, plan: dict) -> dict:
        """计划 → 池分配决定。返回 {pool, main_driver, aux: [...], queued: bool}。

        `pool: "desktop"` 显式覆盖（桌面 computer-use 计划的声明方式）；
        其余按 driver → 池映射走。
        """
        main = plan.get("main_driver") or plan.get("driver") or "api"
        if main not in ENUMS["driver_kind"]:
            raise ValueError(f"unknown driver {main!r}")
        requested = plan.get("pool")
        pool = _LANE_TO_POOL.get(requested) if requested else None
        if pool is None:
            pool = _DRIVER_TO_POOL[main]
        # 混合用例：找辅助 driver（≤2 段，切走不切回）
        aux = []
        for step in plan.get("steps") or []:
            target = step.get("target")
            if isinstance(target, dict):
                d = step.get("driver") or target.get("kind")
            else:
                d = step.get("driver")
            if d and d != main and _DRIVER_TO_POOL.get(d) not in (pool, None):
                entry = {"driver": d, "pool": _DRIVER_TO_POOL[d]}
                if entry not in aux:
                    aux.append(entry)
        has_capacity = self.in_use[pool] < self.caps[pool]
        return {"pool": pool, "main_driver": main, "aux": aux,
                "queued": not has_capacity,
                "pool_free": self.caps[pool] - self.in_use[pool]}

    def lease(self, pool: str) -> bool:
        if pool not in self.caps:
            raise ValueError(f"unknown pool {pool!r}")
        if self.in_use[pool] >= self.caps[pool]:
            return False
        self.in_use[pool] += 1
        return True

    def release(self, pool: str):
        if self.in_use[pool] > 0:
            self.in_use[pool] -= 1

    def lease_aux(self, pool: str, plan_id: str) -> dict:
        """混合用例执行中向辅助池申请资源：辅助池容量独立约束，满则等。"""
        ok = self.lease(pool)
        if ok:
            self._aux_leased.append({"pool": pool, "plan_id": plan_id})
        return {"granted": ok, "pool": pool, "plan_id": plan_id}

    def release_aux(self, pool: str, plan_id: str):
        self._aux_leased = [x for x in self._aux_leased
                            if not (x["pool"] == pool and x["plan_id"] == plan_id)]
        self.release(pool)
