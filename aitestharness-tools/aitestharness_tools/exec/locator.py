"""定位指纹 → 与驱动无关的查询描述（§12.3 三条硬规则的前半段）。

**指纹不是选择器语法**，这个区分是这套东西能不能活过改版的分水岭：

  · 写 `{testid: login-submit}`、`{role: button, name: 登录}`——描述"这是个什么元素"；
  · 不写 `css: "div:nth-child(3) > button"` 当唯一依据——描述"它在第几个坑位"，
    改一次版就断，而且断的时候没人知道它本来想点的是"登录"。

三个硬规则在这里落地：

  1. **按优先级依次尝试，命中即停**：指纹列表的顺序就是优先级，第一个唯一命中即采用；
  2. **多命中拒绝执行**：命中 2 个及以上不取第一个，直接判 ambiguous。取第一个的写法
     在真机上表现为"偶尔点到旁边的按钮"，是最难复现也最难归因的一类假通过；
  3. **每次降级必须记录**：用了第 2、3 个指纹就是降级，必须带 `locator_hit` 出去，
     否则"定位器退化"这件事永远只在事故复盘时才被发现。

本模块是纯函数 + 一次计数回调，不 import playwright：规则可以在没有浏览器的机器上测。
"""
from __future__ import annotations

from typing import Any, Callable, Mapping

from .wait_assert import LocatorResolver

__all__ = ["LOCATOR_KEYS", "SCOPE_KEYS", "LocatorSpecError", "fingerprint_query",
           "describe_query", "resolve_target", "target_locators"]

# 封闭枚举：新增一个键 = 规范变更，必须同时补驱动侧的映射
LOCATOR_KEYS = ("testid", "role", "label", "text", "placeholder",
                "id", "name", "css", "alt", "title", "scope")

# 这些键描述的"策略"互斥：同一个指纹里写两个，说明作者没想清楚要按什么找
_EXCLUSIVE = ("testid", "label", "text", "placeholder", "id", "name", "css", "alt", "title")

# scope 是**修饰符**不是策略：它把定位限制在某个容器内，不改变"这是个什么元素"。
# 之所以要它，是因为真实系统里"同一行里的注销按钮"没有 data-testid，只能靠行内
# 某列的值把行钉住。没有这个表达时，剧本只能手写
# `tr.el-table__row:has(td:nth-child(3):has-text("x")) >> button:has-text("注销")`——
# 一旦被当成模板抄走，"第 3 列"这种位置耦合就扩散到所有剧本里，改版即断。
SCOPE_KEYS = ("container", "where", "cell")

# where 子句的允许键。column=按列序号（位置耦合）、column_name=按表头文本（语义）。
# 两者分开不是为了好看：positional 要能进证据，否则"这条用例靠第 3 列跑通"这件事
# 永远只在改版事故里被发现。
_WHERE_KEYS = ("column", "column_name", "text")


class LocatorSpecError(ValueError):
    """指纹写错（未知键/多策略/空值）。这是编译期错误，不该等到执行时才暴露。"""


def fingerprint_query(fingerprint: Any) -> dict:
    """把一个指纹编译成查询描述：`{"kind": ..., "value": ..., "name": ...}`。

    带 `scope` 时编译成 `{"kind": "scoped", "scope": {...}, "inner": {...}}`：
    先在容器内按 `where` 筛出目标容器，再在容器内定位元素。
    """
    if not isinstance(fingerprint, Mapping):
        raise LocatorSpecError(f"定位指纹必须是映射，收到 {type(fingerprint).__name__}")
    keys = list(fingerprint)
    unknown = [k for k in keys if k not in LOCATOR_KEYS]
    if unknown:
        raise LocatorSpecError(
            f"定位指纹含未知键 {unknown}；允许的键：{list(LOCATOR_KEYS)}"
            f"（未知键静默忽略的表现是'元素找不到'，排查方向会全错）")
    if "scope" not in fingerprint:
        return _compile_fingerprint(fingerprint)
    inner = {k: v for k, v in fingerprint.items() if k != "scope"}
    scope = _compile_scope(fingerprint["scope"])
    # 不给 inner = 定位**筛出来的容器本身**（"用户名列是探针账号的那一行"）。
    # 给 inner = 在容器内继续定位（"那一行里的注销按钮"）。两者都是完整表达，
    # 不能把前者当成漏写——否则"断言某一行存在/消失"只能退回写 CSS 伪类。
    return {"kind": "scoped", "scope": scope,
            "inner": _compile_fingerprint(inner) if inner else None,
            "positional": scope["positional"]}


def _compile_fingerprint(fingerprint: Mapping) -> dict:
    """单个指纹（不含 scope）→ 查询描述。"""
    keys = list(fingerprint)
    if "role" in fingerprint:
        # role + name 是一对（name 是可访问名，不是独立策略），其余键都不许并存
        extra = [k for k in keys if k not in ("role", "name")]
        if extra:
            raise LocatorSpecError(f"role 指纹不能同时带 {extra}：一个指纹只描述一种策略")
        role = fingerprint.get("role")
        if not role:
            raise LocatorSpecError("role 指纹缺少 role 值")
        return {"kind": "role", "value": str(role),
                "name": str(fingerprint["name"]) if fingerprint.get("name") else None}
    used = [k for k in _EXCLUSIVE if k in fingerprint]
    if not used:
        raise LocatorSpecError(f"定位指纹为空或只有 name：{dict(fingerprint)}"
                               f"（name 只能配合 role 使用）")
    if len(used) > 1:
        raise LocatorSpecError(f"定位指纹含多个策略 {used}：一个指纹只能描述一种策略，"
                               f"多种策略请拆成多个指纹按优先级排列")
    key = used[0]
    value = fingerprint.get(key)
    if value in (None, ""):
        raise LocatorSpecError(f"定位指纹 {key} 的值为空")
    return {"kind": key, "value": str(value)}


def _compile_scope(scope: Any) -> dict:
    if not isinstance(scope, Mapping):
        raise LocatorSpecError(f"scope 必须是映射，收到 {type(scope).__name__}")
    unknown = [k for k in scope if k not in SCOPE_KEYS]
    if unknown:
        raise LocatorSpecError(f"scope 含未知键 {unknown}；允许的键：{list(SCOPE_KEYS)}")
    if not scope.get("container"):
        raise LocatorSpecError(
            "scope.container 必填：作用域要说明'在哪一类容器里找'"
            "（例如 {css: \"tr.el-table__row\"}）")
    container = _compile_fingerprint(scope["container"])
    where = scope.get("where")
    if not isinstance(where, (list, tuple)) or not where:
        raise LocatorSpecError(
            "scope.where 必须是非空列表：只给容器不给条件，等于把页面上所有同类容器"
            "都算作候选，多命中拒绝执行后仍然定位不到，而报错会指向'元素不存在'")
    clauses = [_compile_clause(item) for item in where]
    return {"container": container,
            "cell": str(scope.get("cell") or "td"),
            "where": clauses,
            "positional": any(item["kind"] == "column" for item in clauses)}


def _compile_clause(clause: Any) -> dict:
    if not isinstance(clause, Mapping):
        raise LocatorSpecError(f"scope.where 的每一项必须是映射，收到 {type(clause).__name__}")
    unknown = [k for k in clause if k not in _WHERE_KEYS]
    if unknown:
        raise LocatorSpecError(f"scope.where 项含未知键 {unknown}；允许：{list(_WHERE_KEYS)}")
    text = clause.get("text")
    if not isinstance(text, str) or not text.strip():
        raise LocatorSpecError(
            "scope.where 每一项都必须给 text（非空字符串）："
            "没有文本条件就退化成'取该容器的第一个'，而那是最难复现的一类假通过")
    has_index, has_name = "column" in clause, "column_name" in clause
    if has_index and has_name:
        raise LocatorSpecError(
            "scope.where 不能同时给 column 与 column_name："
            "一个是位置、一个是语义，同时写说明没想清楚；且二者冲突时无法判断谁生效")
    if has_index:
        index = clause["column"]
        if isinstance(index, bool) or not isinstance(index, int) or index < 1:
            raise LocatorSpecError(f"scope.where.column 必须是 ≥1 的整数，收到 {index!r}")
        return {"kind": "column", "index": index, "text": text}
    if has_name:
        name = clause["column_name"]
        if not isinstance(name, str) or not name.strip():
            raise LocatorSpecError(f"scope.where.column_name 必须是非空字符串，收到 {name!r}")
        return {"kind": "column_name", "name": name, "text": text}
    return {"kind": "text", "text": text}


def describe_query(query: dict | None) -> str:
    """给日志/证据用的可读描述。"""
    if not query:
        return "(未命中)"
    kind, value = query.get("kind"), query.get("value")
    if kind == "scoped":
        scope = query.get("scope") or {}
        parts = []
        for item in scope.get("where") or []:
            if item["kind"] == "column":
                parts.append(f"col{item['index']}={item['text']}")
            elif item["kind"] == "column_name":
                parts.append(f"{item['name']}={item['text']}")
            else:
                parts.append(f"~{item['text']}")
        head = f"scoped[{describe_query(scope.get('container'))} where {', '.join(parts)}]"
        inner = query.get("inner")
        return f"{head} >> {describe_query(inner)}" if inner else head
    if kind == "role":
        return f"role={value}[name={query.get('name')}]" if query.get("name") else f"role={value}"
    return f"{kind}={value}"


def target_locators(target: Any) -> tuple[list[dict], str | None]:
    """从 step.target 里取出指纹列表与 url。

    两种写法都接受：
      target: {locators: [...], url: /x}      # 推荐的完整形态
      target: {testid: login-form}            # 单指纹简写（常见于手写剧本）
    """
    if not isinstance(target, Mapping):
        raise LocatorSpecError(f"step.target 必须是映射，收到 {type(target).__name__}")
    url = str(target["url"]) if target.get("url") else None
    if target.get("locators"):
        raw = target["locators"]
        if not isinstance(raw, (list, tuple)):
            raise LocatorSpecError("target.locators 必须是列表（按优先级排列）")
        return [dict(item) if isinstance(item, Mapping) else item for item in raw], url
    rest = {k: v for k, v in target.items() if k != "url"}
    if rest:
        return [rest], url
    return [], url


def resolve_target(counts: Callable[[list[dict]], list[int]],
                   locators: list[dict]) -> dict:
    """按优先级定位：`counts(queries) -> [命中数...]` 由驱动提供。

    返回 LocatorResolver 的判定 + 命中的查询 + 逐指纹命中数（进 evidence）。
    """
    queries = [fingerprint_query(fp) for fp in locators]
    if not queries:
        return {"status": "locator_not_found", "hit_index": None, "locator_hit": None,
                "query": None, "counts": [], "detail": "步骤未声明任何定位指纹"}
    hits = list(counts(queries))
    if len(hits) != len(queries):
        raise ValueError(f"计数回调返回 {len(hits)} 个结果，与 {len(queries)} 个指纹不符")
    decision = LocatorResolver().resolve(hits)
    decision["counts"] = hits
    decision["query"] = (queries[decision["hit_index"]]
                         if decision.get("hit_index") is not None and
                         decision.get("status") == "ok" else None)
    # 位置耦合要单独进证据：靠"第 3 列"跑通与靠"用户名列"跑通，可靠性不是一回事。
    # 混在 degraded（指纹优先级降级）里会被读成"第二个指纹命中"，掩盖真正的原因。
    decision["positional"] = bool((decision.get("query") or {}).get("positional"))
    if decision.get("status") != "ok":
        decision["detail"] = (f"{decision.get('detail')}；逐指纹命中数={hits}"
                              f"（{', '.join(describe_query(q) for q in queries)}）")
    return decision
