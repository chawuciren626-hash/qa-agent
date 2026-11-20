"""G1a 环境基线：把"这次跑在什么环境上"变成可比对的指纹（零 LLM、零网络）。

为什么需要它（断3：可比性链）：
    同一批用例在 test / staging 跑出不同结果、或同一环境隔天跑出不同结果时，
    现在没有任何依据判断"是代码变了"还是"环境变了"。缺了基线，flaky、脏数据、
    版本回退三种原因在报告里长得一模一样，只能靠人猜。

三层分工（与 snapshot.py 一致，判定与取原料分开）：
    · 采集：执行侧在 run 开始前调用 `fingerprint_files` / `fingerprint_db`（有 IO，薄壳）
    · 判定：`build_baseline` / `compare_baseline` / `verdict` 全为纯函数，可单测
    · 落盘：`write_baseline(run_dir)` → `output/runs/<run_id>/baseline.json`

四条踩过的坑，直接决定了实现：
    1. **collected_at 不进指纹**。否则同一环境每次采集哈希都不同，基线永远"不一致"，
       告警立刻变成噪音，然后所有人都学会忽略它。
    2. **行序不是语义**。按排序后的行文本取摘要，否则同一份数据因物理顺序不同被判漂移。
    3. **只记凭据引用，不记任何密钥**。baseline.json 会随 run 产物归档分发，
       写进密码摘要等于把可爆破材料塞进交付物；只对 `qa-secret://` 这类引用取指纹，
       足以回答"凭据被换过没有"。
    4. **基线不一致 ≠ 执行失败**。它是"可比性下降"，结论降级为 inconclusive 或带告警，
       不是 fail。当成 fail，每次环境重置都产出一堆假失败，最后没人看报告。

一个必须明确的边界：
    `restore()`（把环境还原到基线）**不在这里**，它需要被测系统提供 dump 回灌与
    mock 重置能力（G1b，外部依赖）。本模块只负责"判断现在和那时是不是同一个环境"。
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import sqlite3
from typing import Any, Iterable, Mapping, Sequence

__all__ = [
    "BASELINE_VERSION", "BASELINE_FILE", "SEVERITIES",
    "content_hash", "build_baseline", "compare_baseline", "verdict",
    "digest_rows", "credential_fingerprint",
    "fingerprint_files", "fingerprint_db", "collect_baseline",
    "write_baseline", "read_baseline",
]

BASELINE_VERSION = 1
BASELINE_FILE = "baseline.json"
SEVERITIES = ("blocking", "warning", "info")

# 这些字段是"关于基线的元信息"，不是基线本身；进哈希会让同一环境每次采集都不一样
_HASH_EXCLUDED = ("content_hash", "collected_at", "note")

# 允许的凭据引用形态：URI 方案、全大写环境变量式标识、或声明性占位引用（`${cred:...}` /
# `${env:...}`，与 irval 的 REF_NAMESPACES 同源）。用来挡住"直接把密码传进来"。
# `${data.*}` / `${ctx.*}` **不在白名单**：那是变量池引用（业务数据、会话 token），
# 指纹跟着它们漂会把"测试数据变了"误报成"凭据轮换了"。
_REF_URI = re.compile(r"^[a-z][a-z0-9+.\-]*://\S+$")
_REF_ENV = re.compile(r"^[A-Z][A-Z0-9_]{2,63}$")
_REF_PLACEHOLDER = re.compile(r"^\$\{(cred|env):[^}${\s]+\}$")


# ------------------------------------------------------------------ 指纹

def _canonical(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), default=str)


def content_hash(baseline: Mapping[str, Any]) -> str:
    """基线的稳定指纹。同环境重复采集必须得到同一个值，否则基线无法比对。"""
    payload = {key: value for key, value in baseline.items() if key not in _HASH_EXCLUDED}
    return hashlib.sha256(_canonical(payload).encode("utf-8")).hexdigest()


def _render(value: Any) -> str:
    if value is None:
        return "\x00NULL"
    if isinstance(value, (bytes, bytearray, memoryview)):
        return "b:" + bytes(value).hex()
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)


def digest_rows(rows: Iterable[Sequence[Any]]) -> dict:
    """一批行 → {rows, digest}。

    取**排序后**的行文本做摘要：行序在关系库里无语义，按物理顺序取哈希会把
    "VACUUM 之后同一份数据"判成漂移。重复行各自成条，不会被集合去重掉。
    """
    rendered = sorted("\x1f".join(_render(value) for value in row) for row in rows)
    hasher = hashlib.sha256()
    for line in rendered:
        hasher.update(line.encode("utf-8"))
        hasher.update(b"\x1e")
    return {"rows": len(rendered), "digest": hasher.hexdigest()}


def credential_fingerprint(refs: Iterable[str]) -> str | None:
    """凭据引用集合的指纹。

    refs 必须是**引用 ID**（`qa-secret://orders-admin@v3`、`CI_ORDERS_PASSWORD`、
    `${cred:orders-admin}`），不是密钥值。传进来的东西若不像引用，直接拒绝——
    这道闸比"事后提醒别写密码"有效。

    三种形态覆盖三处声明位：平台凭据 URI、环境变量名、计划里的声明性占位
    （只认 `cred:` / `env:` 命名空间——`${data.password}` 是变量池取值不是凭据声明）。
    """
    items: list[str] = []
    for ref in refs:
        text = str(ref).strip()
        if not text:
            continue
        if not (_REF_URI.match(text) or _REF_ENV.match(text) or _REF_PLACEHOLDER.match(text)):
            raise ValueError(
                "credential refs must be references (scheme://..., UPPER_ENV_NAME, "
                "or ${cred:...}/${env:...}), never secret values — "
                "baseline.json is archived with the run")
        items.append(text)
    if not items:
        return None
    return hashlib.sha256("\x1f".join(sorted(set(items))).encode("utf-8")).hexdigest()


# ------------------------------------------------------------------ 构建

def _db_entry(raw: Any) -> dict:
    if isinstance(raw, Mapping):
        entry = {
            "rows": int(raw.get("rows") or 0),
            "digest": raw.get("digest"),
            "critical": bool(raw.get("critical", False)),
        }
        if entry["digest"] is None and entry["rows"]:
            raise ValueError("db entry with rows>0 must carry a digest")
        return entry
    raise TypeError("db entry must be a mapping with rows/digest/critical")


def _file_entry(raw: Any) -> dict:
    if isinstance(raw, str):
        return {"sha256": raw, "size": None, "critical": False}
    if isinstance(raw, Mapping):
        return {
            "sha256": raw.get("sha256"),
            "size": raw.get("size"),
            "critical": bool(raw.get("critical", False)),
            "missing": bool(raw.get("missing", False)),
        }
    raise TypeError("file entry must be a digest string or a mapping")


def build_baseline(
    env: str,
    *,
    sut_version: str | None = None,
    db: Mapping[str, Any] | None = None,
    files: Mapping[str, Any] | None = None,
    mock: Mapping[str, str] | None = None,
    credential_refs: Iterable[str] | None = None,
    facts: Mapping[str, Any] | None = None,
    note: str | None = None,
    collected_at: str | None = None,
) -> dict:
    """把已采集到的原料整理成基线对象，并算出 content_hash。

    缺省段一律写 `None` 而不是空 dict：`{}` 会被读成"看过、什么都没有"，
    `None` 才是"没看"。这两者的差别决定了比对时该报 unknown 还是报一致。
    """
    baseline: dict[str, Any] = {
        "baseline_version": BASELINE_VERSION,
        "env": str(env),
        "sut_version": (str(sut_version).strip() or None) if sut_version is not None else None,
        "db": {str(k): _db_entry(v) for k, v in sorted((db or {}).items())} if db is not None else None,
        "files": {str(k): _file_entry(v) for k, v in sorted((files or {}).items())} if files is not None else None,
        "mock": {str(k): str(v) for k, v in sorted((mock or {}).items())} if mock is not None else None,
        "credentials": None,
        "facts": dict(facts or {}),
        "collected_at": collected_at,
        "note": note,
    }
    if credential_refs is not None:
        fingerprint = credential_fingerprint(credential_refs)
        refs = sorted({str(r).strip() for r in credential_refs if str(r).strip()})
        baseline["credentials"] = {"fingerprint": fingerprint, "ref_count": len(refs)} if fingerprint else None
    baseline["content_hash"] = content_hash(baseline)
    return baseline


# ------------------------------------------------------------------ 比对

def _drift(section: str, key: str | None, kind: str, severity: str, detail: str,
           expected: Any = None, actual: Any = None) -> dict:
    return {"section": section, "key": key, "kind": kind, "severity": severity,
            "detail": detail, "expected": expected, "actual": actual}


def _cmp_version(ref: Mapping[str, Any], cur: Mapping[str, Any]) -> list[dict]:
    before = ref.get("sut_version")
    after = cur.get("sut_version")
    if before == after:
        return []
    if before is None or after is None:
        # 缺失不等于不同：标 inconclusive 由 verdict 处理，这里只如实登记
        return [_drift("sut_version", None, "unknown", "info",
                       "被测版本缺失，无法判断是否同一版本", before, after)]
    return [_drift("sut_version", None, "changed", "blocking",
                   "被测版本不同，结论不可跨版本比较", before, after)]


def _cmp_db(ref: Mapping[str, Any], cur: Mapping[str, Any]) -> list[dict]:
    before = ref.get("db")
    after = cur.get("db")
    if before is None and after is None:
        return []
    if before is None or after is None:
        return [_drift("db", None, "unknown", "info",
                       "一侧没有 DB 基线段，该段未参与比对",
                       before is not None, after is not None)]
    drift: list[dict] = []
    for table in sorted(set(before) | set(after)):
        old = before.get(table)
        new = after.get(table)
        # 关键性取并集：任一侧标记关键就按关键处理。否则后来者只要把 critical 改成 false，
        # 就能把 blocking 漂移"降级"成 warning，红线形同虚设。
        critical = bool((old or {}).get("critical") or (new or {}).get("critical"))
        severity = "blocking" if critical else "warning"
        if old is None:
            drift.append(_drift("db", table, "added", "warning", "基线上没有这张表，本次出现", None, new))
            continue
        if new is None:
            drift.append(_drift("db", table, "removed", severity, "基线有这张表，本次消失", old, None))
            continue
        if old.get("rows") != new.get("rows"):
            drift.append(_drift("db", table, "changed", severity,
                                f"行数 {old.get('rows')} → {new.get('rows')}", old.get("rows"), new.get("rows")))
        elif old.get("digest") != new.get("digest"):
            drift.append(_drift("db", table, "changed", severity,
                                "行数相同但内容不同", old.get("digest"), new.get("digest")))
    return drift


def _cmp_files(ref: Mapping[str, Any], cur: Mapping[str, Any]) -> list[dict]:
    before = ref.get("files")
    after = cur.get("files")
    if before is None and after is None:
        return []
    if before is None or after is None:
        return [_drift("files", None, "unknown", "info", "一侧没有文件基线段，该段未参与比对",
                       before is not None, after is not None)]
    drift: list[dict] = []
    for path in sorted(set(before) | set(after)):
        old = before.get(path)
        new = after.get(path)
        critical = bool((old or {}).get("critical") or (new or {}).get("critical"))
        severity = "blocking" if critical else "warning"
        if old is None:
            drift.append(_drift("files", path, "added", "warning", "基线没有这个文件，本次出现", None, new))
        elif new is None:
            drift.append(_drift("files", path, "removed", severity, "基线有这个文件，本次缺失", old, None))
        elif old.get("sha256") != new.get("sha256") or old.get("size") != new.get("size"):
            drift.append(_drift("files", path, "changed", severity, "文件内容与基线不同",
                                old.get("sha256"), new.get("sha256")))
    return drift


def _cmp_mock(ref: Mapping[str, Any], cur: Mapping[str, Any]) -> list[dict]:
    before = ref.get("mock")
    after = cur.get("mock")
    if before is None and after is None:
        return []
    if before is None or after is None:
        return [_drift("mock", None, "unknown", "info", "一侧没有 mock 基线段，该段未参与比对",
                       before is not None, after is not None)]
    drift: list[dict] = []
    for service in sorted(set(before) | set(after)):
        old = before.get(service)
        new = after.get(service)
        if old is None:
            drift.append(_drift("mock", service, "added", "warning", "基线没有该 mock 服务", None, new))
        elif new is None:
            drift.append(_drift("mock", service, "removed", "blocking", "基线有该 mock 服务，本次缺失", old, None))
        elif old != new:
            # mock 状态直接改变接口返回，属于根因级别的环境差异
            drift.append(_drift("mock", service, "changed", "blocking", "mock 状态不同，用例结果不可比", old, new))
    return drift


def _cmp_credentials(ref: Mapping[str, Any], cur: Mapping[str, Any]) -> list[dict]:
    before = ref.get("credentials")
    after = cur.get("credentials")
    if before is None and after is None:
        return [_drift("credentials", None, "unknown", "info", "两侧都未把凭据纳入基线", None, None)]
    if before is None or after is None:
        return [_drift("credentials", None, "unknown", "info", "一侧未把凭据纳入基线，无法判断是否轮换",
                       before, after)]
    if before.get("fingerprint") != after.get("fingerprint"):
        # 凭据轮换不一定导致失败，但"谁在用哪个账号"变了，结论要打折
        return [_drift("credentials", None, "changed", "warning",
                       "凭据引用发生变化（疑似轮换或换账号）", before.get("ref_count"), after.get("ref_count"))]
    return []


def compare_baseline(reference: Mapping[str, Any], current: Mapping[str, Any]) -> dict:
    """参考基线 vs 本次采集 → 结构化漂移清单。

    只回答"哪里不一样、有多要紧"，不回答"能不能接受"——那是 verdict 的事，
    因为是否接受还取决于被测版本是否齐全这类基线之外的条件。
    """
    drift = [
        *_cmp_version(reference, current),
        *_cmp_db(reference, current),
        *_cmp_files(reference, current),
        *_cmp_mock(reference, current),
        *_cmp_credentials(reference, current),
    ]
    order = {name: index for index, name in enumerate(SEVERITIES)}
    drift.sort(key=lambda item: (order[item["severity"]], item["section"], item["key"] or ""))
    summary = {name: sum(1 for item in drift if item["severity"] == name) for name in SEVERITIES}
    return {
        "same": not drift,
        "comparable": summary["blocking"] == 0,
        "drift": drift,
        "summary": summary,
        "reference_hash": reference.get("content_hash"),
        "current_hash": current.get("content_hash"),
    }


def verdict(reference: Mapping[str, Any] | None, current: Mapping[str, Any] | None) -> dict:
    """基线判定：能不能拿这次的结论跟上次比。

    四态，顺序有意义：
        baseline_missing → 首次运行 / 未采集，没有参考，不冒充可比
        inconclusive     → 基线有漂移**或**被测版本缺失；G3 明确要求缺版本标 inconclusive
        not_comparable   → 存在 blocking 漂移（版本/mock/关键表）
        comparable*      → 可比（带 warning 时降级为 comparable_with_warnings）

    `comparable` 为 False 不表示执行有问题，只表示"这个结论不宜直接与前次比较"。
    """
    if reference is None or current is None:
        missing = "参考基线" if reference is None else "本次基线"
        return {"status": "baseline_missing", "comparable": False,
                "reasons": [f"{missing}缺失，本次结论只能单看，不能与历史比较"], "comparison": None}

    comparison = compare_baseline(reference, current)
    reasons = [item["detail"] for item in comparison["drift"] if item["severity"] != "info"]
    version_known = bool(reference.get("sut_version")) and bool(current.get("sut_version"))
    if not version_known:
        reasons.append("被测版本缺失（G3）：结论标 inconclusive，不当作通过")
        return {"status": "inconclusive", "comparable": False, "reasons": reasons, "comparison": comparison}
    if not comparison["comparable"]:
        return {"status": "not_comparable", "comparable": False, "reasons": reasons, "comparison": comparison}
    if comparison["summary"]["warning"]:
        return {"status": "comparable_with_warnings", "comparable": True, "reasons": reasons,
                "comparison": comparison}
    return {"status": "comparable", "comparable": True, "reasons": [], "comparison": comparison}


# ------------------------------------------------------------------ 采集壳（有 IO，保持薄）

def fingerprint_files(paths: Iterable[str], root: str | os.PathLike[str] | None = None,
                      *, critical: Iterable[str] = ()) -> dict:
    """按文件路径集合取指纹。**不递归目录**：整目录扫下去会把日志、node_modules
    卷进基线，几万行条目既没人读，也让基线本身变成噪音源。
    """
    base = os.fspath(root) if root is not None else None
    critical_set = {os.path.normpath(item) for item in critical}
    result: dict[str, dict] = {}
    for raw in paths:
        full = os.path.join(base, raw) if base else raw
        key = os.path.relpath(full, base).replace(os.sep, "/") if base else os.fspath(raw).replace(os.sep, "/")
        if not os.path.isfile(full):
            # 缺失要如实登记成 missing，不能跳过——跳过等于"本次没这个文件"，比对时会静默通过
            result[key] = {"sha256": None, "size": None, "critical": os.path.normpath(raw) in critical_set,
                           "missing": True}
            continue
        hasher = hashlib.sha256()
        with open(full, "rb") as handle:
            for chunk in iter(lambda: handle.read(65536), b""):
                hasher.update(chunk)
        result[key] = {"sha256": hasher.hexdigest(), "size": os.path.getsize(full),
                       "critical": os.path.normpath(raw) in critical_set, "missing": False}
    return result


def _tables_of(conn: sqlite3.Connection) -> list[str]:
    rows = conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    return [row[0] for row in rows]


def fingerprint_db(path: str | os.PathLike[str], tables: Iterable[str] | None = None,
                   *, critical: Iterable[str] = ()) -> dict:
    """被测环境的数据指纹。

    支持 sqlite 文件与 `{table: [rows...]}` 形态的 JSON 导出；其他形态一律拒绝，
    而不是"算个整文件 sha256 交差"——dump 文件的字节哈希会被注释、时间戳、语句顺序
    干扰，看着有指纹其实比不出数据有没有变。
    """
    full = os.fspath(path)
    critical_set = set(critical)
    if not os.path.isfile(full):
        raise FileNotFoundError(f"db snapshot not found: {full}")
    if full.lower().endswith((".db", ".sqlite", ".sqlite3")):
        conn = sqlite3.connect(f"file:{full}?mode=ro", uri=True)
        try:
            names = list(tables) if tables is not None else _tables_of(conn)
            result: dict[str, dict] = {}
            for table in names:
                # 表名来自调用方或 sqlite_master，用双引号包裹防注入式表名（如 "a;drop"）
                quoted = '"' + str(table).replace('"', '""') + '"'
                try:
                    cursor = conn.execute(f"SELECT * FROM {quoted}")
                except sqlite3.OperationalError:
                    result[str(table)] = {"rows": 0, "digest": None, "critical": str(table) in critical_set}
                    continue
                entry = digest_rows(cursor.fetchall())
                entry["critical"] = str(table) in critical_set
                result[str(table)] = entry
            return result
        finally:
            conn.close()
    if full.lower().endswith(".json"):
        with open(full, "r", encoding="utf-8") as handle:
            payload = json.load(handle)
        if not isinstance(payload, dict):
            raise ValueError("json db snapshot must be {table: [rows]}")
        result = {}
        for table, rows in payload.items():
            if not isinstance(rows, list):
                raise ValueError(f"json db snapshot table {table!r} must be a list of rows")
            entry = digest_rows([row if isinstance(row, (list, tuple)) else [row] for row in rows])
            entry["critical"] = str(table) in critical_set
            result[str(table)] = entry
        return result
    raise ValueError(f"unsupported db snapshot format: {full}（支持 .db/.sqlite/.sqlite3/.json）")


# ------------------------------------------------------------------ 落盘

def collect_baseline(config: Mapping[str, Any]) -> dict:
    """按一份配置采集并构建基线。执行侧只传配置，不各自拼装采集逻辑。

    配置形态（字段可选，缺省即"该段未采集"）：
        {"env": "staging", "sut_version": "2026.11.19-1",
         "db": {"path": "...", "tables": ["orders"], "critical": ["orders"]},
         "files": {"root": "...", "paths": ["fixtures/seed.json"], "critical": []},
         "mock": {"user-service": "sha256:..."},
         "credential_refs": ["qa-secret://orders-admin@v3"],
         "facts": {...}, "note": "..."}

    `db` / `files` 段存在但采集失败时会抛错而不是降级成空段：一份"什么都没采到"的
    基线比没有基线更危险——它会让后续比对得出"环境一致"的假结论。
    """
    if not config.get("env"):
        raise ValueError("baseline config requires env")
    db = None
    if config.get("db") is not None:
        db_config = config["db"]
        db = fingerprint_db(db_config["path"], db_config.get("tables"), critical=db_config.get("critical", ()))
    files = None
    if config.get("files") is not None:
        files_config = config["files"]
        files = fingerprint_files(files_config.get("paths", []), files_config.get("root"),
                                  critical=files_config.get("critical", ()))
    return build_baseline(
        str(config["env"]),
        sut_version=config.get("sut_version"),
        db=db,
        files=files,
        mock=config.get("mock"),
        credential_refs=config.get("credential_refs"),
        facts=config.get("facts"),
        note=config.get("note"),
        collected_at=config.get("collected_at"),
    )


def write_baseline(run_dir: str | os.PathLike[str], baseline: Mapping[str, Any],
                   *, overwrite: bool = False) -> str:
    """写入 `output/runs/<run_id>/baseline.json`，返回文件路径。

    已有基线且内容不同时**默认拒绝覆盖**：基线一旦写下就是"当时的环境"，
    事后改基线等于伪造可比性。重新采集必须显式 `overwrite=True`，留下调用点可追溯。
    """
    directory = os.fspath(run_dir)
    os.makedirs(directory, exist_ok=True)
    target = os.path.join(directory, BASELINE_FILE)
    payload = dict(baseline)
    payload["content_hash"] = content_hash(payload)

    if os.path.exists(target) and not overwrite:
        try:
            existing = read_baseline(directory)
        except ValueError:
            existing = None
        if existing is not None and existing.get("content_hash") != payload["content_hash"]:
            raise ValueError(
                "baseline already recorded for this run with a different hash; "
                "pass overwrite=True only when re-collecting before execution")

    tmp = target + ".tmp"
    with open(tmp, "w", encoding="utf-8", newline="\n") as handle:
        json.dump(payload, handle, ensure_ascii=False, sort_keys=True, indent=2)
        handle.write("\n")
    os.replace(tmp, target)
    return target


def read_baseline(run_dir: str | os.PathLike[str]) -> dict | None:
    """读回基线；文件不存在返回 None。

    哈希对不上直接抛错：基线被手改过之后，用它做比对得出的"一致"没有意义，
    宁可让调用方失败，也不要给出一个看着正常的错误结论。
    """
    target = os.path.join(os.fspath(run_dir), BASELINE_FILE)
    if not os.path.isfile(target):
        return None
    with open(target, "r", encoding="utf-8") as handle:
        payload = json.load(handle)
    if not isinstance(payload, dict):
        raise ValueError("baseline.json must contain an object")
    stored = payload.get("content_hash")
    actual = content_hash(payload)
    if stored != actual:
        raise ValueError("baseline.json content hash mismatch — file was modified after collection")
    version = payload.get("baseline_version")
    if not isinstance(version, int) or version > BASELINE_VERSION:
        raise ValueError(f"unsupported baseline_version: {version!r}")
    return payload
