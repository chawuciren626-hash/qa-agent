"""极简产物库（内存实现），供 X 层跨产物校验使用。

生产环境是数据库 + 索引，这里只需满足契约语义：
按 `id@version` 精确取、按类型列举。
"""

from __future__ import annotations

import re
from typing import Any, Iterator

REF = re.compile(r"^(?P<id>[A-Za-z]+-[A-Za-z0-9-]+?)@(?P<ver>\d+)$")


def parse_ref(ref: str) -> tuple[str, int] | None:
    m = REF.match(ref)
    if not m:
        return None
    return m.group("id"), int(m.group("ver"))


class Store:
    def __init__(self) -> None:
        self._docs: dict[tuple[str, int], dict[str, Any]] = {}

    def add(self, doc: dict[str, Any]) -> None:
        self._docs[(doc["id"], int(doc.get("version", 1)))] = doc

    def get(self, ref: str) -> dict[str, Any] | None:
        key = parse_ref(ref)
        return self._docs.get(key) if key else None

    def has(self, ref: str) -> bool:
        return self.get(ref) is not None

    def has_id(self, pid: str) -> bool:
        return any(k[0] == pid for k in self._docs)

    def by_type(self, itype: str) -> Iterator[dict[str, Any]]:
        for doc in self._docs.values():
            if doc.get("type") == itype:
                yield doc

    def plans_of_case(self, case_ref: str) -> list[dict[str, Any]]:
        return [d for d in self.by_type("plan") if d.get("case_ref") == case_ref]

    def versions_of(self, pid: str) -> list[dict[str, Any]]:
        """同一 ID 的全部历史版本，按版本号升序。

        V-40（预期漂移）需要它：判断"改了几次"必须看历史，
        只看最新一版永远算不出次数——这是这条规则唯一的数据依赖。
        """
        rows = [(k[1], v) for k, v in self._docs.items() if k[0] == pid]
        return [doc for _, doc in sorted(rows, key=lambda kv: kv[0])]

    def __len__(self) -> int:
        return len(self._docs)
