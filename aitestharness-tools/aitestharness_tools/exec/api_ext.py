"""§11.4 接口自动化专有工具（风险最低，M1 先行的主力）。

1. ResponseContractValidator — 响应契约校验器（schema 子集，零依赖）
2. AsyncPoller       — 异步结果轮询器（MQ/任务轮询，带超时与轮询上限）
3. extract_variable  — 接口间变量提取传递（json_path → ctx，写回 context_flow）
4. DatabaseAsserter  — 数据库断言器（sqlite 原型实现，生产换 MySQL/PG 同接口）
环境域名切换在 infra.CredentialCenter（§11.3 共用）。
"""
from __future__ import annotations

import re
import time
import sqlite3

__all__ = ["ResponseContractValidator", "AsyncPoller", "extract_variable",
           "DatabaseAsserter"]

# ---- 响应契约校验器（schema 子集：type/required/properties/items/enum） ----
_TYPE_CHECK = {
    "string": lambda v: isinstance(v, str),
    "number": lambda v: isinstance(v, (int, float)) and not isinstance(v, bool),
    "integer": lambda v: isinstance(v, int) and not isinstance(v, bool),
    "boolean": lambda v: isinstance(v, bool),
    "object": lambda v: isinstance(v, dict),
    "array": lambda v: isinstance(v, list),
    "null": lambda v: v is None,
}


class ResponseContractValidator:
    """对响应 body 做契约校验。契约放资产库（版本化），不放计划里。"""

    def validate(self, body, schema: dict) -> list[str]:
        errs = []
        self._check(body, schema, "$", errs)
        return errs

    def _check(self, val, schema, path, errs):
        t = schema.get("type")
        if t and t in _TYPE_CHECK and not _TYPE_CHECK[t](val):
            errs.append(f"{path}: 期望 {t}，实际 {type(val).__name__}")
            return
        if "enum" in schema and val not in schema["enum"]:
            errs.append(f"{path}: 值 {val!r} 不在枚举 {schema['enum']}")
        if t == "object" or isinstance(val, dict):
            for req in schema.get("required") or []:
                if req not in (val or {}):
                    errs.append(f"{path}: 缺必填字段 '{req}'")
            for key, sub in (schema.get("properties") or {}).items():
                if isinstance(val, dict) and key in val:
                    self._check(val[key], sub, f"{path}.{key}", errs)
        if t == "array" and isinstance(val, list):
            items = schema.get("items")
            if items:
                for i, item in enumerate(val[:100]):
                    self._check(item, items, f"{path}[{i}]", errs)
            if schema.get("min_items") is not None and len(val) < schema["min_items"]:
                errs.append(f"{path}: 数组长度 {len(val)} < min_items {schema['min_items']}")


# ---- 异步结果轮询器 ----
class AsyncPoller:
    """MQ/任务轮询：fetcher() -> (done: bool, payload)；确定性参数上限。"""

    def __init__(self, interval_s: float = 1.0, max_attempts: int = 30):
        self.interval_s = interval_s
        self.max_attempts = max_attempts

    def poll(self, fetcher, done_matcher=None) -> dict:
        """done_matcher(payload)->bool 可选；不传则只看 fetcher 的 done。"""
        last = None
        for i in range(1, self.max_attempts + 1):
            try:
                done, payload = fetcher()
            except Exception as exc:                       # 环境异常不算失败，记入日志
                done, payload = False, {"poll_error": str(exc)}
            last = payload
            if done and (done_matcher is None or done_matcher(payload)):
                return {"status": "done", "attempts": i, "payload": payload}
            time.sleep(self.interval_s)
        return {"status": "timeout", "attempts": self.max_attempts, "payload": last}


# ---- 变量提取传递 ----
_JP = re.compile(r"^\$\.([A-Za-z0-9_.]+)$")


def extract_variable(response_body, json_path: str) -> dict:
    """从响应提取变量（接口间传递的唯一合法通道，必须配 context_flow 声明）。"""
    m = _JP.match(json_path or "")
    if not m:
        return {"ok": False, "error": f"仅支持 $.a.b 形式，收到 {json_path!r}"}
    cur = response_body
    for k in m.group(1).split("."):
        if isinstance(cur, dict) and k in cur:
            cur = cur[k]
        else:
            return {"ok": False, "error": f"path '{json_path}' 不存在"}
    return {"ok": True, "value": cur}


# ---- 数据库断言器（sqlite 原型；生产实现同接口换驱动） ----
class DatabaseAsserter:
    """db 断言（§11.6 数据一致性 → 接口+数据库双验证）。

    query 带命名参数 :name，值由引擎解析后传入——SQL 模板进计划，值走 ${data.*}。
    """

    def __init__(self, dsn: str):
        if not dsn.startswith("sqlite://"):
            raise ValueError("原型版仅支持 sqlite://path；MySQL/PG 在 M2 接入")
        self.conn = sqlite3.connect(dsn[len("sqlite://"):])

    def query(self, sql_template: str, params: dict | None = None) -> dict:
        cur = self.conn.execute(sql_template, params or {})
        cols = [c[0] for c in cur.description]
        rows = [dict(zip(cols, r)) for r in cur.fetchmany(100)]
        return {"columns": cols, "rows": rows, "row_count": len(rows)}
