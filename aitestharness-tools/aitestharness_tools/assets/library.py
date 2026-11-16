"""§9 资产库：元素库 / 片段库 / 数据集（三者都是一等公民，且必须「改动留痕」）。

为什么单独成包：
    §9 三条资产纪律里，前两条（元素库是一等公民、资产随执行自动更新）一直只写在
    文档里，没有代码承载。后果很具体——元素定位散在执行计划的每个 step 里，
    改一个按钮的 testid 要改 40 条用例；片段各写一份，登录改了 12 处都要跟着改。
    「维护成本占 60%」的根源就在这儿。

本包只管三件事（全部零 LLM）：
    1. ElementLibrary  多指纹 / 环境变体 / 失效历史 / 健康度评分；
    2. FragmentLibrary 流程片段：契约化（入参出参显式）+ 版本化 + 引用关系；
    3. DataSetStore    数据集与用例分离（用例引用数据集 ID，不内嵌数据值）。

三条硬纪律（照 §9 原文落地，不擅自放松）：
    · 改元素库一处，全用例生效 —— 所以元素用稳定 ID 引用，**不许在 plan 里内联指纹**；
    · 所有改动必须产生 diff 并留痕，**不允许运行期悄悄修改资产** ——
      写入必须显式 `apply(change, actor=..., reason=...)`，change 有 id 可回放；
    · 失效不是删除 —— 元素失效进 `retired` 历史，下次同指纹复现可自动复活并留痕。

诚实边界：
    - 这里不做「元素自动发现」，指纹从探索器 / DOM 快照来（explore / exec.snapshot）；
    - 健康度是**启发式评分**，用途是排序与告警，不参与 verdict 判定；
    - 没有做并发写锁：资产库由本地服务主进程独占读写（§24.5），worker 只读。
"""
from __future__ import annotations

import re
from datetime import datetime, timezone

from ..common.lineage import content_hash

__all__ = [
    "FINGERPRINT_PRIORITY", "ElementLibrary", "FragmentLibrary", "DataSetStore",
    "health_score", "diff_elements",
]

# 指纹优先级（§9 纪律 1 的原始顺序）：越靠前越稳，降级必须记录
FINGERPRINT_PRIORITY = ("testid", "role", "label", "text", "css", "xpath")

# 有效指纹：css/xpath 这类结构指纹在改版时最先失效，但不能没有（兜底）
_STRUCTURAL = {"css", "xpath"}


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _fp_key(fingerprints: dict) -> str:
    """指纹集合的稳定 key：只取有效指纹，按优先级排序后 hash。"""
    pairs = [(k, str(fingerprints[k])) for k in FINGERPRINT_PRIORITY
             if fingerprints.get(k)]
    return content_hash({"fp": pairs})


def health_score(element: dict) -> dict:
    """元素健康度（0~100，启发式）。

    扣分项（都对应真实运维里出现过的现象）：
      · 无 testid/role/label 之一 → -30（只能靠文本或结构定位，改版必崩）
      · 只含 css/xpath 单类结构指纹 → -20（§12.3 已判为脆弱）
      · 命中降级（locator_hit > 1）比例高 → 按比例扣，最高 -30
      · 有失效历史 → 每条 -5，最高 -20

    用途：`select_regression` 之外的资产健康度输入、隔离区候选。
    **不参与单条用例 verdict**——健康度低不等于这次跑错了。
    """
    fps = element.get("fingerprints") or {}
    score, reasons = 100, []

    semantic = [k for k in ("testid", "role", "label") if fps.get(k)]
    if not semantic:
        score -= 30
        reasons.append("no_semantic_fingerprint（无 testid/role/label，改版必崩）")
    present = {k for k in FINGERPRINT_PRIORITY if fps.get(k)}
    if present and present <= _STRUCTURAL:
        score -= 20
        reasons.append("structural_only（仅 css/xpath 单指纹）")

    hits = element.get("locator_hits") or []
    if hits:
        degraded = sum(1 for h in hits if int(h) > 1)
        ratio = degraded / len(hits)
        if ratio > 0:
            cut = min(30, int(round(ratio * 30)))
            score -= cut
            reasons.append(f"degraded_locator_ratio={ratio:.0%}（扣 {cut}）")

    retired = element.get("retired") or []
    if retired:
        cut = min(20, 5 * len(retired))
        score -= cut
        reasons.append(f"retired_history={len(retired)}（扣 {cut}）")

    score = max(0, score)
    return {"score": score, "grade": ("good" if score >= 80 else
                                      "warn" if score >= 60 else "poor"),
            "reasons": reasons}


class ElementLibrary:
    """元素库：多指纹 / 环境变体 / 失效历史。

    存储形态（JSON 可落盘）：
        {"type": "elements", "elements": {eid: {
            "id", "route", "control_type", "name",
            "fingerprints": {testid/role/label/text/css/xpath},
            "variants": {env: {fingerprints}},     # 环境变体（同页面不同域名/主题）
            "locator_hits": [1, 2, 1],             # 每次定位命中第几个指纹
            "retired": [{at, reason}],             # 失效历史（不是删除）
            "created_at", "updated_at"}}}

    为什么用稳定 ID：§9 纪律 1 要求"改元素库一处，全用例生效"。做法是 plan 里只写
    `element_ref: el-xxx`，运行时由本库展开成指纹序列；若 plan 内联指纹，改一处要改 N 处。
    """

    def __init__(self, elements: dict | None = None):
        self._els: dict[str, dict] = dict(elements or {})

    # ---- 读 ----
    def resolve(self, element_ref: str, env: str | None = None) -> dict:
        """展开为定位候选序列（按优先级）。

        环境变体命中时**只用变体指纹**，不与默认指纹混排——混排会让"环境 A 的 css"
        在环境 B 里误命中相似元素，这是多环境资产最常见的坑。
        """
        el = self._els.get(element_ref)
        if not el:
            return {"status": "not_found", "element_ref": element_ref,
                    "candidates": [], "detail": "元素不在库中：需先建档或补登记"}
        fps = dict(el.get("fingerprints") or {})
        used_variant = False
        if env and (el.get("variants") or {}).get(env):
            fps = dict(el["variants"][env])
            used_variant = True
        candidates = [{"type": k, "value": str(fps[k])}
                      for k in FINGERPRINT_PRIORITY if fps.get(k)]
        if not candidates:
            return {"status": "not_found", "element_ref": element_ref,
                    "candidates": [], "variants_available":
                        sorted((el.get("variants") or {}).keys()),
                    "detail": f"环境 {env!r} 下无任何有效指纹"}
        return {
            "status": "retired" if el.get("retired") and env is None else "ok",
            "element_ref": element_ref,
            "candidates": candidates,
            "used_variant": used_variant,
            "structural_only": {c["type"] for c in candidates} <= _STRUCTURAL,
            "retired": bool(el.get("retired")),
            "health": health_score(el),
        }

    def get(self, element_ref: str) -> dict | None:
        return self._els.get(element_ref)

    def listing(self, route: str | None = None) -> list[dict]:
        return [e for e in self._els.values()
                if route is None or e.get("route") == route]

    def match_by_fingerprint(self, fingerprints: dict) -> list[str]:
        """按任意指纹反查元素 ID（探索器登记去重用）。"""
        out = []
        want = {k: str(v) for k, v in (fingerprints or {}).items() if v}
        for eid, el in self._els.items():
            all_fps = [el.get("fingerprints") or {}] + list((el.get("variants") or {}).values())
            for fps in all_fps:
                if want and all(str(fps.get(k)) == v for k, v in want.items() if fps.get(k)):
                    out.append(eid)
                    break
        return sorted(out)

    # ---- 写（必须留痕） ----
    def apply(self, change: dict, actor: str, reason: str) -> dict:
        """唯一的写入口。**运行期不允许绕过它直接改内部 dict。**

        change: {"op": "add|update|retire|revive|add_variant",
                 "element_ref": str, "route"?: str, "control_type"?: str,
                 "name"?: str, "fingerprints"?: {...}, "env"?: str}
        返回 {ok, change_id, diff, applied}
        失败原因：元素不存在 / 缺 reason（防止无人认领的悄悄改动）。
        """
        if not reason or len(str(reason).strip()) < 4:
            return {"ok": False, "error": "missing_reason",
                    "advice": "资产改动必须写明原因（§9 纪律 3：不允许悄悄修改）"}
        op = (change or {}).get("op")
        eid = (change or {}).get("element_ref") or (
            f"el-{_fp_key(change.get('fingerprints') or {})[:8]}"
            if change.get("fingerprints") else None)
        if op not in ("add", "update", "retire", "revive", "add_variant"):
            return {"ok": False, "error": f"unknown_op:{op}"}
        if not eid:
            return {"ok": False, "error": "missing_element_ref"}

        before = self._els.get(eid)
        if op != "add" and before is None:
            return {"ok": False, "error": "element_not_found", "element_ref": eid}

        if op == "add":
            if before is not None:
                return {"ok": False, "error": "element_exists",
                        "advice": "改用 update，避免覆盖既有指纹"}
            fps = {k: v for k, v in (change.get("fingerprints") or {}).items()
                   if k in FINGERPRINT_PRIORITY and v}
            if not fps:
                return {"ok": False, "error": "no_valid_fingerprint",
                        "advice": f"指纹键必须在 {FINGERPRINT_PRIORITY} 内"}
            self._els[eid] = {
                "id": eid, "route": change.get("route") or "",
                "control_type": change.get("control_type") or "other",
                "name": change.get("name") or eid,
                "fingerprints": fps, "variants": {},
                "locator_hits": [], "retired": [],
                "created_at": _now(), "updated_at": _now(),
            }
        elif op == "update":
            fps = {k: v for k, v in (change.get("fingerprints") or {}).items()
                   if k in FINGERPRINT_PRIORITY and v}
            if not fps:
                return {"ok": False, "error": "no_valid_fingerprint"}
            before["fingerprints"] = {**before.get("fingerprints", {}), **fps}
            before["updated_at"] = _now()
        elif op == "add_variant":
            env = change.get("env")
            fps = {k: v for k, v in (change.get("fingerprints") or {}).items()
                   if k in FINGERPRINT_PRIORITY and v}
            if not env or not fps:
                return {"ok": False, "error": "variant_needs_env_and_fingerprints"}
            before.setdefault("variants", {})[env] = fps
            before["updated_at"] = _now()
        elif op == "retire":
            before.setdefault("retired", []).append({"at": _now(), "reason": reason})
            before["updated_at"] = _now()
        elif op == "revive":
            before["retired"] = []
            before["updated_at"] = _now()

        diff = diff_elements(before or {}, self._els[eid])
        return {"ok": True, "element_ref": eid,
                "change_id": f"chg-{content_hash({'e': eid, 'op': op, 'r': reason})[:10]}",
                "op": op, "actor": actor, "reason": reason,
                "diff": diff, "applied": self._els[eid]}

    def record_hit(self, element_ref: str, locator_hit: int) -> dict:
        """记录一次定位命中了第几个指纹（自愈降级必记，§12.3 硬规则 3）。"""
        el = self._els.get(element_ref)
        if not el:
            return {"ok": False, "error": "element_not_found"}
        el.setdefault("locator_hits", []).append(int(locator_hit))
        el["updated_at"] = _now()
        return {"ok": True, "degraded": int(locator_hit) > 1,
                "health": health_score(el)}

    def to_json(self) -> dict:
        return {"type": "elements", "schema_hint": "assets/elements.json",
                "elements": self._els,
                "stats": {"count": len(self._els),
                          "poor": sum(1 for e in self._els.values()
                                      if health_score(e)["grade"] == "poor")}}


def diff_elements(old: dict, new: dict) -> dict:
    """两次元素状态的可读 diff（改动留痕用，人可评审）。"""
    o = (old or {}).get("fingerprints") or {}
    n = (new or {}).get("fingerprints") or {}
    changed = {k: {"from": o.get(k), "to": n.get(k)}
               for k in set(o) | set(n) if o.get(k) != n.get(k)}
    ov = sorted(((old or {}).get("variants") or {}).keys())
    nv = sorted(((new or {}).get("variants") or {}).keys())
    return {
        "fingerprints_changed": changed,
        "variants_added": [v for v in nv if v not in ov],
        "variants_removed": [v for v in ov if v not in nv],
        "retired_count": len((new or {}).get("retired") or []),
        "summary": (f"指纹变化 {len(changed)} 项"
                    + (f"，新增变体 {len([v for v in nv if v not in ov])}"
                       if nv != ov else "")),
    }


class FragmentLibrary:
    """片段库：流程片段契约化 + 版本化（§7.4 / §9）。

    片段是「可复用的步骤序列」——登录、造数、审批流。三条纪律：
      1. **契约化**：必须声明 `inputs` / `outputs`，否则引用方不知道要喂什么、能取什么；
      2. **版本化**：片段改动即升版，引用方锁定 `frag-x@1`，升级要显式；
      3. **依赖显式**：片段里再用别的片段，关系可查（影响分析用）。
    """

    def __init__(self, fragments: dict | None = None):
        # key: "frag-id@version"
        self._frags: dict[str, dict] = dict(fragments or {})

    def _key(self, frag_id: str, version: int | None = None) -> str:
        if version:
            return f"{frag_id}@{version}"
        vs = [k for k in self._frags if k.split("@")[0] == frag_id]
        if not vs:
            return frag_id
        return max(vs, key=lambda k: int(k.split("@")[1]))

    def register(self, frag_id: str, steps: list[dict], inputs: list[dict] | None = None,
                 outputs: list[dict] | None = None, version: int | None = None,
                 description: str = "") -> dict:
        """登记片段。缺 inputs/outputs 声明直接拒——契约化不是可选项。"""
        if not isinstance(inputs, list) or not isinstance(outputs, list):
            return {"ok": False, "error": "contract_required",
                    "advice": "片段必须声明 inputs/outputs（§7.4 契约化），"
                              "否则引用方无法知道要喂什么、能取什么"}
        for st in steps or []:
            if not isinstance(st, dict):
                return {"ok": False, "error": "step_must_be_mapping"}
        prev = [k for k in self._frags if k.split("@")[0] == frag_id]
        ver = version or (1 if not prev else max(int(k.split("@")[1]) for k in prev) + 1)
        key = f"{frag_id}@{ver}"
        if key in self._frags:
            return {"ok": False, "error": "version_exists",
                    "advice": "片段改动必须升版，不许原地改（引用方已锁定旧版）"}
        deps = sorted({str((s.get("fragment") or {}) .get("id"))
                       for s in steps or [] if s.get("fragment")})
        self._frags[key] = {
            "id": frag_id, "version": ver, "key": key,
            "description": description or frag_id,
            "inputs": inputs, "outputs": outputs,
            "steps": steps, "depends_on": [d for d in deps if d],
            "created_at": _now(),
        }
        return {"ok": True, "key": key, "version": ver, "depends_on": self._frags[key]["depends_on"]}

    def get(self, frag_id: str, version: int | None = None) -> dict | None:
        return self._frags.get(self._key(frag_id, version))

    def expand(self, frag_id: str, version: int | None = None, _seen: tuple = ()) -> dict:
        """展开片段为扁平 steps，并检查循环依赖与参数缺失。"""
        if frag_id in _seen:
            return {"ok": False, "error": "circular_fragment",
                    "chain": list(_seen) + [frag_id]}
        f = self.get(frag_id, version)
        if not f:
            return {"ok": False, "error": "fragment_not_found",
                    "frag": f"{frag_id}@{version or 'latest'}"}
        steps, missing = [], []
        for s in f.get("steps") or []:
            inner = s.get("fragment") if isinstance(s, dict) else None
            if inner:
                # 嵌套调用：校验实参覆盖被调片段的必填 inputs
                need = {i["name"] for i in (self.get(inner.get("id"), inner.get("version"))
                                            or {}).get("inputs") or [] if i.get("required")}
                got = set((inner.get("args") or {}).keys())
                missing.extend(f"{inner.get('id')}.{n}" for n in sorted(need - got))
                sub = self.expand(inner.get("id"), inner.get("version"),
                                  _seen + (frag_id,))
                if not sub.get("ok"):
                    return sub
                steps.extend(sub["steps"])
            else:
                steps.append(s)
        return {"ok": not missing, "frag": f"{frag_id}@{f['version']}",
                "outputs": f.get("outputs"), "steps": steps,
                "missing_args": missing,
                "touched_hint": _touched_hint(steps)}

    def refs_of(self, frag_id: str) -> list[str]:
        """哪些片段依赖它（片段改动的影响面）。"""
        return sorted(k for k, f in self._frags.items()
                      if frag_id in (f.get("depends_on") or []))

    def to_json(self) -> dict:
        return {"type": "fragments", "schema_hint": "assets/fragments/",
                "fragments": self._frags, "count": len(self._frags)}


def _touched_hint(steps: list[dict]) -> dict:
    """从片段步骤粗提 touched（页面/接口），供地图变更影响分析用。"""
    pages, apis = set(), set()
    api_re = re.compile(r"^(GET|POST|PUT|PATCH|DELETE)\s+(\S+)$", re.I)
    for s in steps or []:
        act = str(s.get("action") or "")
        if any(k in act.lower() for k in ("navigate", "open", "goto", "跳转", "打开")):
            p = s.get("target") or s.get("url") or s.get("page")
            if p:
                pages.add(str(p))
        m = api_re.match(str(s.get("request") or ""))
        if m:
            apis.add(f"{m.group(1).upper()} {m.group(2)}")
    return {"pages": sorted(pages), "apis": sorted(apis)}


class DataSetStore:
    """数据集（§9 `data/` + §10.4「数据集 ID 与用例分离」）。

    为什么分离：同一条用例要在 dev/staging/prod 三套环境跑，数据集不同；
    把数据内嵌在用例里，环境一换就得复制用例。所以用例只记 `dataset_ref`。
    凭据类字段**只允许引用**（`${secret.xxx}`），不许把明文写进数据集——
    数据集会随用例一起进版本库，是最容易泄露密码的地方。
    """

    _SECRET_FIELD = re.compile(r"(password|passwd|pwd|secret|token|apikey|api_key)", re.I)

    def __init__(self, datasets: dict | None = None):
        self._ds: dict[str, dict] = dict(datasets or {})

    def put(self, dataset_id: str, env: str, rows: list[dict],
            generated_by: str = "DataFactory", seed: str | None = None) -> dict:
        problems = []
        for i, row in enumerate(rows or []):
            for k, v in (row or {}).items():
                if self._SECRET_FIELD.search(str(k)) and \
                        not (isinstance(v, str) and v.startswith("${secret.")):
                    problems.append(f"rows[{i}].{k} 疑似凭据明文，必须写 ${{secret.xxx}} 引用")
        if problems:
            return {"ok": False, "error": "plaintext_secret", "problems": problems,
                    "advice": "数据集会随用例进版本库，凭据只能引用（§9 / §15）"}
        key = f"{dataset_id}@{env}"
        self._ds[key] = {"dataset_id": dataset_id, "env": env,
                         "rows": rows or [], "row_count": len(rows or []),
                         "generated_by": generated_by, "seed": seed,
                         "content_hash": content_hash({"rows": rows or []}),
                         "created_at": _now()}
        return {"ok": True, "key": key, "row_count": len(rows or [])}

    def get(self, dataset_id: str, env: str) -> dict | None:
        return self._ds.get(f"{dataset_id}@{env}")

    def resolve_row(self, dataset_id: str, env: str, index: int = 0,
                    secrets: dict | None = None) -> dict:
        """取一行数据并展开 `${secret.x}` 引用（secrets 来自本机凭据中心）。"""
        ds = self.get(dataset_id, env)
        if not ds:
            return {"ok": False, "error": "dataset_not_found",
                    "key": f"{dataset_id}@{env}"}
        if not ds["rows"]:
            return {"ok": False, "error": "dataset_empty"}
        row = ds["rows"][index % len(ds["rows"])]
        pat = re.compile(r"\$\{secret\.([A-Za-z0-9_.]+)\}")

        def repl(m):
            cur = secrets or {}
            for part in m.group(1).split("."):
                if not isinstance(cur, dict) or part not in cur:
                    return m.group(0)
                cur = cur[part]
            return str(cur)

        resolved = {k: (pat.sub(repl, v) if isinstance(v, str) else v)
                    for k, v in row.items()}
        unresolved = [k for k, v in resolved.items()
                      if isinstance(v, str) and pat.search(v)]
        return {"ok": not unresolved, "row": resolved, "index": index,
                "unresolved_refs": unresolved,
                "advice": ("缺少凭据引用 " + ", ".join(unresolved)) if unresolved else "ok"}

    def to_json(self) -> dict:
        return {"type": "datasets", "schema_hint": "data/", "datasets": self._ds}
