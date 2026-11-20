"""§15 探索器（探索模式）：四阶段 + 硬预算 + 探索度报告 + 危险动作白名单。

核心定位（§15.1）：**探索构建地图，不承担验收职责。**
  ① 环境建档（零 LLM，目标 10 秒内） ② 结构巡检（广度优先）③ 功能试触（有限深度）④ 固化沉淀
**关键发现**（§15.2）：现代 Web 应用的路由表几乎都在 JS 里，直接解析比"点着看"快 100 倍且零 token。
上次演示若做了这一步，页面清单 10 秒就能拿到——这正对"十几分钟跑不起来 / 100 万 token"的病根。

本文件实现全部**确定性**部分（零 LLM）：路由表解析、控件规则提取、预算控制、
危险动作白名单、探索度报告、探索产物 → 首版测试点。
LLM 部分（试触时的"填什么值/看什么"）在 agent 层，受本文件的预算与白名单约束。
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

__all__ = ["DEFAULT_BUDGET", "TERMINATION", "BudgetGuard", "extract_routes", "extract_controls",
           "detect_stack", "DANGEROUS_ACTIONS", "action_policy", "ExplorationReport",
           "controls_to_test_points", "is_page_route"]

# §15.2 默认硬预算（达到即停，无论还有多少没试；预算由工程制定，不靠模型自觉）
DEFAULT_BUDGET = {"inspect_pages": 50, "probe_pages": 10, "actions_per_page": 5}
TERMINATION = ("budget_exhausted",      # 优先：工程硬性
               "routes_covered",        # 路由清单全覆盖
               "no_new_info")           # 连续 N 次动作无新信息（收益递减）


@dataclass
class BudgetGuard:
    """预算护栏：任何超预算的动作直接拒（不是建议，是拒绝）。"""
    inspect_pages: int = DEFAULT_BUDGET["inspect_pages"]
    probe_pages: int = DEFAULT_BUDGET["probe_pages"]
    actions_per_page: int = DEFAULT_BUDGET["actions_per_page"]
    inspected: list = field(default_factory=list)
    probed: dict = field(default_factory=dict)     # page -> action count
    consecutive_no_info: int = 0
    _stopped: str | None = None

    def can_inspect(self, page: str) -> tuple[bool, str]:
        if len(self.inspected) >= self.inspect_pages and page not in self.inspected:
            return False, "budget_exhausted(inspect_pages)"
        return True, "ok"

    def can_probe(self, page: str) -> tuple[bool, str]:
        if page not in self.probed and len(self.probed) >= self.probe_pages:
            return False, "budget_exhausted(probe_pages)"
        if self.probed.get(page, 0) >= self.actions_per_page:
            return False, "budget_exhausted(actions_per_page)"
        return True, "ok"

    def consume_inspect(self, page: str):
        if page not in self.inspected:
            self.inspected.append(page)

    def consume_probe(self, page: str, gained_info: bool = True):
        self.probed[page] = self.probed.get(page, 0) + 1
        self.consecutive_no_info = 0 if gained_info else self.consecutive_no_info + 1
        if self.consecutive_no_info >= 5:      # 收益递减终止（§15.3 ③）
            self._stopped = "no_new_info"

    def stop_reason(self, all_routes: list[str]) -> str | None:
        if self._stopped:
            return self._stopped
        if all_routes and set(all_routes) <= set(self.inspected):
            return "routes_covered"
        return None


# ---- ① 环境建档：从 JS bundle / menu 配置 / 前端路由表提取路由（零 LLM，最高价值） ----
_ROUTE_PATTERNS = (
    re.compile(r'path\s*:\s*["\']([^"\']+)["\']'),
    re.compile(r'component\s*:\s*\(\)\s*=>\s*import\(["\'`][^"\'`]+["\'`]\).*?path\s*:\s*["\']([^"\']+)'),
    re.compile(r'createRouter\s*\(\s*\{.*?routes\s*:', re.S),
)

# 编程式跳转与声明式链接：现代 Vue/React 代码里 router.push('/x') 比 path: 声明更常见，
# 只抓 path: 会漏掉一半页面（实测某 SPA 漏 30%+）。
_NAV_PATTERNS = (
    re.compile(r'(?:push|replace|navigateTo|navigate|redirect)\s*\(\s*["\'`](/[^"\'`]*)["\'`]'),
    re.compile(r'replaceState\s*\([^,]*,\s*[^,]*,\s*["\'`](/[^"\'`]*)["\'`]'),
    re.compile(r'href\s*=\s*["\'](/[^"\'#]*)["\']'),
    re.compile(r'to\s*=\s*["\'](/[^"\'#]*)["\']'),
)

# 明显不是路由的串（模板片段、选择器、外链、变量插值）
_NOT_ROUTE = re.compile(r'[\s<>${}\\]|://|\$\{|\.\./|^/\*')

# 静态资源与站点元文件不是页面：href 提取会扫到 <link>/<script> 引用，不过滤的话
# favicon.ico、manifest.json、构建产物 CSS 全被当成页面（实测 saucedemo 建档把
# `assets/index-*.css` 报成路由，真实业务页反而零登记）。.json 一并过滤：数据端点
# 属于接口清单，不该以"页面"身份进地图。
_STATIC_EXT = re.compile(
    r"\.(css|js|mjs|cjs|map|png|jpe?g|gif|svg|ico|webp|avif|woff2?|ttf|eot|otf|"
    r"mp4|webm|mp3|wav|pdf|zip|gz|json|xml|txt)$",
    re.I,
)
_NON_PAGE_PATHS = {"/favicon.ico", "/robots.txt", "/sitemap.xml",
                   "/manifest.json", "/manifest.webmanifest"}


def is_page_route(route: str) -> bool:
    """判断一条候选路由是不是"可能被渲染的页面"。过滤规则在 bootstrap 与探索两侧共用。"""
    route = str(route or "")
    if _STATIC_EXT.search(route):
        return False
    return route.lower() not in _NON_PAGE_PATHS


def extract_routes(js_text: str, base_prefix: str = "") -> dict:
    """从 JS bundle 提取路由清单（§15.2 阶段① 最高价值产出）。

    支持四类来源：vue-router 的 {path: '/x', component: ...}、react-router 的 path="..."、
    <Link to="/x">、以及编程式跳转 router.push('/x')。

    拼接形态（`'/order/' + id`）单独归入 prefixes，**不并入路由**——
    否则 `/order/` 会变成一个假页面，把页面数虚增。

    返回 {routes, prefixes, count, source}——10 秒级、零 token。
    """
    found: set[str] = set()
    prefixes: set[str] = set()
    for pat in (_ROUTE_PATTERNS[0], _ROUTE_PATTERNS[1],
                re.compile(r'path\s*=\s*["\']([^"\']+)["\']'),
                re.compile(r'to\s*:\s*["\'](/\w[\w/\-:]*)["\']')) + _NAV_PATTERNS:
        for m in pat.finditer(js_text or ""):
            p = m.group(1)
            if not p or p.startswith("http") or p.startswith("*") or _NOT_ROUTE.search(p):
                continue
            if p.endswith("/") and len(p) > 1:
                prefixes.add(p)        # 拼接前缀，如 '/order/' + id
                continue
            found.add((base_prefix.rstrip("/") + p) if base_prefix else p)
    # 过滤明显非路由（如 css 选择器式短串）与静态资源（href 会扫到 <link>/<script> 引用）
    routes = sorted(r for r in found
                    if (r.startswith("/") or ":" in r) and is_page_route(r))
    return {"routes": routes, "prefixes": sorted(prefixes),
            "count": len(routes), "source": "js_bundle",
            "note": "零 LLM；比逐个点击快百倍（§15.2 关键发现）"}


def detect_stack(html_or_js: str) -> dict:
    """识别技术栈与渲染策略（决定等待方式，§15.2 阶段①）。"""
    blob = (html_or_js or "").lower()
    if "__vue__" in blob or ("vue" in blob and "createapp" in blob) or \
            "createrouter" in blob or ("component:()=>import(" in blob.replace(" ", "")):
        stack, spa = "vue", True
    elif "react" in blob or "_react" in blob or "reactdom" in blob:
        stack, spa = "react", True
    elif "angular" in blob or "ng-version" in blob:
        stack, spa = "angular", True
    else:
        stack, spa = "unknown", bool('id="app"' in blob or 'id="root"' in blob)
    return {"stack": stack, "spa": spa,
            "evidence": ("命中 vue-router 声明形态" if stack == "vue" else
                         "命中 react 运行时标记" if stack == "react" else
                         "命中 angular 标记" if stack == "angular" else
                         ("仅识别到 SPA 挂载点" if spa else "未识别到框架特征")),
            "wait_strategy": "network_idle + element_stable" if spa else "element_visible",
            "reason": "SPA 首屏由 JS 渲染，须等网络空闲与元素稳定；非 SPA 等元素可见即可"}


def extract_controls(structured_dom: dict) -> dict:
    """规则提取控件清单（零 LLM，§15.2 阶段②）：只做"看一眼、登记"，不做业务流程。

    structured_dom: {interactive: [{tag, type, name, id, text, role, testid}]}
    """
    controls = []
    for el in structured_dom.get("interactive") or []:
        tag = (el.get("tag") or "").lower()
        ctype = {
            "input": "input", "textarea": "textarea", "select": "select",
            "button": "button", "a": "link", "table": "table",
        }.get(tag, "other")
        if tag == "input" and (el.get("type") or "").lower() in ("checkbox", "radio"):
            ctype = (el.get("type") or "").lower()
        controls.append({
            "control_type": ctype,
            "name": el.get("name") or el.get("id"),
            "text": (el.get("text") or "")[:60],
            # 元素指纹（后续元素库直接可用）
            "fingerprints": {"testid": el.get("testid"), "role": el.get("role"),
                             "css": f"#{el['id']}" if el.get("id") else None,
                             "text": (el.get("text") or "")[:20] or None},
        })
    return {"control_count": len(controls), "controls": controls}


# ---- §15.4 危险动作白名单（产品级功能） ----
DANGEROUS_ACTIONS = {
    "submit_payment": "触发真实扣款",
    "submit_order": "触发真实下单",
    "send_sms": "触发真实短信",
    "send_email": "触发真实邮件",
    "delete_record": "删除数据",
    "publish": "发布上线",
}
_READONLY_ACTIONS = {"navigate", "goto", "click_link", "query", "search", "read",
                     "inspect", "validate_form"}


def action_policy(action: str, allow_submit_on: list[str] | None = None,
                  page: str | None = None, mode: str = "readonly") -> dict:
    """危险动作白名单（§15.4）。
    客户首次使用默认只读：浏览/查询/校验可做，提交类需显式开启（mode=readwrite），
    且页面必须在白名单里才允许提交。
    """
    a = (action or "").lower()
    if a in _READONLY_ACTIONS:
        return {"allowed": True, "reason": "只读类探查，默认允许"}
    if a in DANGEROUS_ACTIONS:
        if mode != "readwrite":
            return {"allowed": False,
                    "reason": f"危险动作（{DANGEROUS_ACTIONS[a]}）：只读模式禁止，需显式开启"}
        if page not in (allow_submit_on or []):
            return {"allowed": False,
                    "reason": f"页面 {page!r} 不在提交白名单，改为只做表单校验不做业务提交"}
        return {"allowed": True, "reason": "显式开启且页面在白名单"}
    if a.startswith("submit") or a.startswith("create"):
        if mode != "readwrite":
            return {"allowed": False, "reason": "提交类动作在只读模式下一律禁止"}
        return {"allowed": page in (allow_submit_on or []),
                "reason": "页面白名单校验" if page else "无页面信息，拒绝"}
    return {"allowed": True, "reason": "未列入危险清单"}


class ExplorationReport:
    """§15.3 探索度报告：让"没探索完"变成可见、可解释的状态，而不是"跑崩了"。"""

    def __init__(self, total_routes: int):
        self.total_routes = total_routes
        self.inspected: list[str] = []
        self.probed: dict = {}
        self.pending_queue: list[dict] = []     # 超预算未做 → 下一轮输入
        self.llm_calls = 0

    def render(self, stop_reason: str | None) -> dict:
        insp = len(self.inspected)
        probed = len(self.probed)
        completion = round(insp / self.total_routes, 4) if self.total_routes else 0
        return {
            "inspected": f"{insp}/{self.total_routes}",
            "probed": f"{probed}/{DEFAULT_BUDGET['probe_pages']}",
            "pending_count": len(self.pending_queue),
            "stop_reason": stop_reason or "running",
            "completion": completion,
            "llm_calls": self.llm_calls,
            "next_round_focus": self._focus(),
            "statement": f"巡检覆盖 {insp}/{self.total_routes} 页、试触 {probed}/"
                         f"{DEFAULT_BUDGET['probe_pages']} 页、未探索队列 "
                         f"{len(self.pending_queue)} 项",
        }

    def _focus(self) -> list[str]:
        return [p.get("route") for p in self.pending_queue[:10]]


def controls_to_test_points(page: str, controls: dict,
                            checklist_fn=None) -> list[dict]:
    """④ 固化沉淀之一：页面控件 ↔ 知识库映射 → 首版测试点（映射是确定性的，只补缺口）。"""
    from ..testpoint.matrix import search_checklist
    fn = checklist_fn or search_checklist
    tps = []
    for i, c in enumerate(controls.get("controls") or []):
        dims = fn(c.get("control_type"))
        for d in dims:
            tps.append({"test_point_id": f"tp-x{page.strip('/').replace('/', '-') or 'root'}-{i}-{d}",
                        "page": page, "control_type": c.get("control_type"),
                        "dimension": d, "source": "exploration",
                        "control_name": c.get("name")})
    return tps
