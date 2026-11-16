"""运行时版本戳（v3 方案 §24.7）。

为什么需要这个模块：
    客户端存在「整包内置」与「能力包热更」两个版本来源（§24.6）。一旦发布节奏
    出问题，同一条用例会在更新前后跑出不同结果——如果不记录版本，这种差异会被
    判成 flaky（冤枉脚本）或当成真 bug（误报）。所以：

    1. 每条 exec IR 必须带 runtime stamp（engine_version / schema_version /
       capability_versions）；
    2. 两次运行的 stamp 不一致 → 一律 inconclusive(version_changed)，不参与
       flaky 判定（§24.7 决策 57）；
    3. 会话执行期冻结版本：worker 持有旧版本直到会话结束才加载新版，杜绝
       "跑到第 3 步时策略被换掉"的不可复现失败。

设计约束：
    - 无外部依赖、无 IO，纯内存；方便被 worker、CLI、测试同时引用；
    - 版本号解析复用 capability.EngineVersion，区间判定只有一处实现。
"""
from __future__ import annotations

from typing import Iterable

from .capability import EngineVersion

__all__ = [
    "ENGINE_VERSION", "SCHEMA_VERSION", "CAPABILITY_KINDS",
    "CapabilityRegistry", "runtime_stamp", "stamps_differ",
    "manifest_compat", "VersionFreezeError", "VERSION_CHANGED",
    "default_registry",
]

# 底座版本：随安装包走（①档）。发版时改这里，且必须与 DSL schema /
# IR 契约同版本发布——三者单独升级视为非法（§24.6）。
ENGINE_VERSION = "1.0.0"

# IR 契约版本：对应 AITestHarness-IR契约规范-v1（38 条规则）。
SCHEMA_VERSION = "1.0"

# 能力包类型（②③档）。判据：不含任何 Python 代码，只含数据/提示词/声明。
CAPABILITY_KINDS = ("knowledge", "prompt", "policy", "fragment", "plugin",
                    "dependency", "skill")

# 版本变更导致的不确定判定原因码（exec IR / 报告统一使用）
VERSION_CHANGED = "version_changed"


class VersionFreezeError(RuntimeError):
    """执行期试图变更能力包（§24.7 版本冻结）。"""


class CapabilityRegistry:
    """已生效能力包清单（本地）。

    用途：
        - 产出 runtime stamp 供 exec IR 记账；
        - 会话期间 freeze()，任何 register/unregister 都抛 VersionFreezeError，
          把"执行期禁止更新"从纪律变成机制。

    用法：
        reg = CapabilityRegistry.builtin()      # 装内置快照
        with reg.frozen():                       # 一个执行会话
            ... 跑 plan ...                      # stamp 全程稳定
        reg.register("kb-control-dimension", "2.3.0", kind="knowledge")  # 会话外才允许
    """

    def __init__(self, initial: dict[str, str] | None = None):
        # name -> {"version": ..., "kind": ...}
        self._items: dict[str, dict] = {}
        self._frozen = False
        for name, ver in (initial or {}).items():
            self.register(name, ver)

    # ---- 变更（仅会话外） ----
    def register(self, name: str, version: str, kind: str = "policy") -> None:
        if self._frozen:
            raise VersionFreezeError(
                f"执行期禁止变更能力包（{name}@{version}）：版本冻结中，需等会话结束")
        if kind not in CAPABILITY_KINDS:
            raise ValueError(f"unknown capability kind: {kind!r}，"
                             f"合法值 {CAPABILITY_KINDS}")
        EngineVersion(version)          # 版本号格式早失败
        self._items[name] = {"version": version, "kind": kind}

    def unregister(self, name: str) -> None:
        if self._frozen:
            raise VersionFreezeError(f"执行期禁止移除能力包（{name}）：版本冻结中")
        self._items.pop(name, None)

    # ---- 冻结 ----
    @property
    def frozen(self) -> bool:
        return self._frozen

    def freeze(self) -> "CapabilityRegistry":
        self._frozen = True
        return self

    def unfreeze(self) -> "CapabilityRegistry":
        self._frozen = False
        return self

    def frozen_scope(self):
        """上下文管理器：with reg.frozen_scope(): ..."""
        return _FrozenScope(self)

    # ---- 读 ----
    def snapshot(self) -> dict[str, str]:
        """name -> version；排序保证同一状态 hash 稳定。"""
        return {k: v["version"] for k, v in sorted(self._items.items())}

    def describe(self) -> list[dict]:
        return [{"name": k, "version": v["version"], "kind": v["kind"]}
                for k, v in sorted(self._items.items())]

    @classmethod
    def builtin(cls, initial: dict[str, str] | None = None) -> "CapabilityRegistry":
        """内置快照注册表（安装包自带，断网可用）。"""
        return cls(initial or {})


class _FrozenScope:
    def __init__(self, reg: CapabilityRegistry):
        self.reg = reg
        self._prev = reg.frozen

    def __enter__(self):
        self.reg.freeze()
        return self.reg

    def __exit__(self, *exc):
        if not self._prev:
            self.reg.unfreeze()
        return False


def runtime_stamp(registry: CapabilityRegistry | None = None) -> dict:
    """产出 runtime stamp，写入每份 exec IR。

    返回：
        {"engine_version": "1.0.0", "schema_version": "1.0",
         "capability_versions": {"kb-control-dimension": "2.3.0"}}
    """
    reg = registry if registry is not None else _DEFAULT_REGISTRY
    return {
        "engine_version": ENGINE_VERSION,
        "schema_version": SCHEMA_VERSION,
        "capability_versions": reg.snapshot() if reg is not None else {},
    }


def stamps_differ(records: Iterable[dict]) -> dict:
    """判断一组运行记录的版本戳是否一致。

    records: [{engine_version, schema_version, capability_versions}, ...]
    返回 {"consistent": bool, "available": bool, "detail": {...}}

    available=False 表示样本里根本没有版本戳（老产物/未接入），此时不据此判死，
    但要在报告里标注，避免"看起来判定了其实没判"。
    """
    stamps, missing = [], 0
    for r in records or []:
        ev = r.get("engine_version")
        if not ev:
            missing += 1
            continue
        stamps.append((ev,
                       r.get("schema_version") or "",
                       tuple(sorted((r.get("capability_versions") or {}).items()))))
    if not stamps:
        return {"consistent": True, "available": False, "missing": missing,
                "detail": {"reason": "no runtime stamp in any record"}}
    distinct = sorted({s for s in stamps})
    ok = len(distinct) == 1
    detail = {}
    if not ok:
        cap_sets: list[dict] = []
        for s in distinct:
            d = dict(dict(s[2]))
            if d not in cap_sets:      # 只列真正不同的能力集，避免重复项干扰排查
                cap_sets.append(d)
        detail = {
            "engine_versions": sorted({s[0] for s in stamps}),
            "schema_versions": sorted({s[1] for s in stamps if s[1]}),
            "capability_sets": cap_sets,
        }
    return {"consistent": ok, "available": True, "missing": missing,
            "distinct": len(distinct), "detail": detail}


def manifest_compat(manifest: dict, engine_version: str = ENGINE_VERSION) -> dict:
    """§24.6 更新流程第 ② 步：能力包兼容性门（客户端本地判定）。

    返回 {"ok": bool, "reason": str}。不满足即不下发、整体不安装，
    提示用户升级客户端——绝不"先装上再说"。
    """
    spec = manifest.get("requires_engine") or ">=0.0"
    try:
        ev = EngineVersion(engine_version)
        if not ev.in_range(spec):
            return {"ok": False,
                    "reason": f"能力包 {manifest.get('name')}@{manifest.get('version')} "
                              f"要求底座 {spec}，当前 {engine_version}"}
    except ValueError as exc:
        return {"ok": False, "reason": f"版本声明非法：{exc}"}
    name = manifest.get("name") or ""
    ver = manifest.get("version") or ""
    if not name or not ver:
        return {"ok": False, "reason": "manifest 缺少 name 或 version（版本号不可变前提）"}
    try:
        EngineVersion(ver)
    except ValueError as exc:
        return {"ok": False, "reason": f"manifest.version 非法：{exc}"}
    if not manifest.get("signature"):
        return {"ok": False, "reason": "manifest 缺少签名，拒绝安装（内网离线包同样强制）"}
    return {"ok": True, "reason": "compatible"}


# 进程级默认注册表：内置快照（无能力包时为 {}，stamp 里如实记空）
_DEFAULT_REGISTRY = CapabilityRegistry.builtin()


def default_registry() -> CapabilityRegistry:
    """进程级默认注册表（内置快照）。安装包启动时把内置能力包注册进来。"""
    return _DEFAULT_REGISTRY
