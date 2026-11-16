"""能力分发与版本协商（v3 方案第 24 章）：
- 策略/知识资产服务端下发，内置底座随安装包；
- 客户端上报底座版本 → 服务端返回兼容策略版本；
- 拉取失败使用内置快照兜底并在报告中标注。
"""
from __future__ import annotations

import re

__all__ = ["EngineVersion", "negotiate", "PolicySnapshot"]

_VER_RE = re.compile(r"^(\d+)\.(\d+)\.(\d+)$")


class EngineVersion:
    """底座版本，语义化 major.minor.patch；契约版本区间 compatible_engine 判定兼容。"""

    def __init__(self, version: str):
        m = _VER_RE.match(version or "")
        if not m:
            raise ValueError(f"bad version: {version!r}")
        self.parts = tuple(int(x) for x in m.groups())

    def __str__(self):
        return ".".join(map(str, self.parts))

    def in_range(self, spec: str) -> bool:
        """spec 形如 '>=1.0,<2.0' 或 '>=1.0'。"""
        for clause in (spec or "").split(","):
            clause = clause.strip()
            m = re.match(r"(>=|<=|>|<|==|!=)\s*(\d+)\.(\d+)(?:\.(\d+))?", clause)
            if not m:
                raise ValueError(f"bad spec clause: {clause}")
            op, rhs = m.group(1), tuple(
                int(x) for x in (m.group(2), m.group(3), m.group(4) or 0))
            a, b = self.parts, rhs
            ok = {"==": a == b, "!=": a != b,
                  ">=": a >= b, "<=": a <= b, ">": a > b, "<": a < b}[op]
            if not ok:
                return False
        return True


class PolicySnapshot:
    """策略快照：服务端下发内容 + 内置兜底快照的统一载体。"""

    def __init__(self, rules_meta: dict, schema_version: str,
                 source: str = "server"):  # source: server|builtin
        self.rules_meta = rules_meta
        self.schema_version = schema_version
        self.source = source

    def describe(self) -> dict:
        return {"schema_version": self.schema_version, "source": self.source,
                "rules": sorted(self.rules_meta.keys())}


def negotiate(engine_version: str, server_policies: list[dict],
              builtin: PolicySnapshot | None = None) -> dict:
    """版本协商。

    server_policies: [{name, schema_version, compatible_engine, rules_meta, ...}]
    返回 {status: ok|degraded, snapshot, blocked:[...]}
      ok    —— 至少一个服务端策略与底座兼容，取 schema 版本最高者；
      degraded —— 服务端无兼容策略或不可达（server_policies 为空），
                   回退内置快照并标注 degraded（报告侧据此写"策略非最新"）。
    """
    ev = EngineVersion(engine_version)
    compatible = [p for p in (server_policies or [])
                  if ev.in_range(p.get("compatible_engine") or ">=0.0")]
    if compatible:
        best = max(compatible, key=lambda p: tuple(
            int(x) for x in str(p.get("schema_version", "0")).split(".")))
        snap = PolicySnapshot(best.get("rules_meta") or {},
                              best["schema_version"], source="server")
        blocked = [p["name"] for p in server_policies if p is not best
                   and not ev.in_range(p.get("compatible_engine") or ">=0.0")]
        return {"status": "ok", "snapshot": snap, "engine_version": ev,
                "blocked": blocked}
    if builtin is not None:
        return {"status": "degraded", "snapshot": builtin, "engine_version": ev,
                "blocked": [p.get("name") for p in (server_policies or [])]}
    raise RuntimeError("无兼容服务端策略且无内置快照：策略拉取失败且不可兜底，阻断会话")
