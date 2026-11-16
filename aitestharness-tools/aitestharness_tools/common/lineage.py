"""公共层工具：ID 生成、content_hash、血缘头、语义指纹。

对应 v3 方案第 6 章「产物契约层（IR）与血缘」。
所有核心 IR 的公共头（lineage）格式见《AITestHarness-IR契约规范-v1.md》。
"""
from __future__ import annotations

import hashlib
import re
import unicodedata
from datetime import datetime, timezone

__all__ = [
    "new_artifact_id", "content_hash", "semantic_fingerprint",
    "make_lineage", "validate_lineage", "is_ancestor",
]

# ID 规则：kind 三位小写缩写 + '-' + 4 位十进制序号
_KIND_ALIASES = {
    "requirement": "req", "test_point": "tp", "case": "case",
    "plan": "plan", "exec": "exec", "defect": "defect",
    "report": "report", "fragment": "frag",
}
_ID_RE = re.compile(r"^[a-z]{3,6}-\d{4,6}$")


def new_artifact_id(kind: str, seq: int) -> str:
    """生成产物 ID：kind->缩写 + 4~6 位序号，如 req-0044。"""
    alias = _KIND_ALIASES.get(kind)
    if not alias:
        raise ValueError(f"unknown artifact kind: {kind!r}")
    return f"{alias}-{seq:04d}"


def content_hash(data: dict) -> str:
    """对产物正文（去掉公共头 lineage）做 sha256 前 16 位十六进制。

    与校验器 V-27 血缘存在规则配套：derived_from 指向的版本靠此 hash 对账。
    """
    body = {k: v for k, v in (data or {}).items() if k != "lineage"}
    text = _canonical_json(body)
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]


def _canonical_json(obj) -> str:
    """稳定序列化：键排序，保证同内容同 hash。"""
    import json
    return json.dumps(obj, ensure_ascii=False, sort_keys=True,
                      separators=(",", ":"), default=str)


def semantic_fingerprint(text: str) -> str:
    """语义指纹：去噪规范化后的 hash，用于区分"语义变更"与"表述变更"。

    归一化规则：NFKC 规范化 → 全角转半角空白折叠 → 去标点/空白 → 小写。
    两段文本 fingerprint 相同 ⇒ 表述变了但语义没变，不触发下游重算。
    """
    if text is None:
        text = ""
    s = unicodedata.normalize("NFKC", str(text))
    s = s.lower()
    # 去掉所有标点与空白（全角半角、中英文标点统一视为噪声）
    s = re.sub(r"[\W_]+", "", s, flags=re.UNICODE)
    return hashlib.sha256(s.encode("utf-8")).hexdigest()[:16]


def make_lineage(kind: str, artifact_id: str, version: int,
                 derived_from: list[str] | None = None,
                 actor: str = "human", created_by: str | None = None) -> dict:
    """构造合规的公共血缘头。actor ∈ {human, agent}；agent 不得写 program 字段
    （见 irval.ownership，PERM_AGENT_WROTE_PROGRAM_FIELD）。"""
    if actor not in ("human", "agent"):
        raise ValueError("actor must be human|agent")
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    head = {
        "lineage": {
            "kind": kind,
            "id": artifact_id,
            "version": int(version),
            "content_hash": None,          # 由调用方填 content_hash(全文)
            "derived_from": derived_from or [],
            "created_by": created_by or actor,
            "actor": actor,
            "created_at": now,
            "consistency": None,
        }
    }
    return head


def validate_lineage(head: dict) -> list[str]:
    """血缘头结构预检（快速失败用；完整校验交给 irval）。返回错误列表。"""
    errs = []
    lin = head.get("lineage") if isinstance(head, dict) else None
    if not isinstance(lin, dict):
        return ["SCHEMA_LINEAGE_MISSING: 公共血缘头缺失"]
    aid = lin.get("id")
    if not isinstance(aid, str) or not _ID_RE.match(aid):
        errs.append(f"SCHEMA_ID_FORMAT: id '{aid}' 不满足 kind-序号 格式")
    if not isinstance(lin.get("version"), int) or lin["version"] < 1:
        errs.append("SCHEMA_VERSION: version 必须为正整数")
    if lin.get("actor") not in ("human", "agent"):
        errs.append("SCHEMA_ACTOR: actor 必须为 human|agent")
    for df in lin.get("derived_from") or []:
        if not _ID_RE.match(str(df.get("id", ""))):
            errs.append(f"XREF_DERIVED_FROM: derived_from 条目 '{df}' 无效")
    return errs


def is_ancestor(child_head: dict, ancestor_id: str, version: int | None = None) -> bool:
    """判断 child 是否血缘上来自 ancestor（可选指定版本）。"""
    for df in child_head.get("lineage", {}).get("derived_from") or []:
        if df.get("id") == ancestor_id and (version is None or df.get("version") == version):
            return True
    return False
