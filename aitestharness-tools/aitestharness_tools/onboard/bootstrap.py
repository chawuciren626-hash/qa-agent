"""项目建档链路（§10.10 / §15.2 阶段①）——给一个地址，产出 maps IR + 建档报告。

为什么单独成层：这是用户旅程的第一步，也是上次演示失败的直接原因。
给了地址和账号后，agent 从零开始点，十几分钟跑不完；而现代 SPA 的页面清单
几乎都写在 JS 路由表里，静态解析 10 秒就能拿到，零 token。

本模块只用确定性代码（requests + 正则 + bs4），**零 LLM**。

四件事：
1. probe_site    抓首页 + 外链 bundle（硬限流）→ 路由清单 + 技术栈
2. probe_login   从 HTML 探测登录表单与验证码类型（零 LLM 规则）
3. probe_openapi 尝试常见 OpenAPI 文档地址 → 接口清单
4. bootstrap     汇总为 maps IR + 人可读建档报告（含覆盖率与警告）

诚实边界：静态抓取只能拿到「路由 + 接口 + 登录特征」，
控件清单必须真实渲染才能拿到（探索器阶段②），报告里会明确标出未建档页面。
"""
from __future__ import annotations

import json
import re
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urljoin, urlparse

__all__ = [
    "MAX_BUNDLES", "MAX_BUNDLE_BYTES", "MAX_TOTAL_BYTES", "DEFAULT_TIMEOUT",
    "Probe", "probe_site", "probe_login", "probe_openapi", "normalize_route",
    "normalize_routes", "guess_route_module", "scan_risky_actions",
    "bootstrap", "render_report_markdown", "write_bundle",
]

MAX_BUNDLES = 12              # 单站点最多抓 12 个 bundle
MAX_BUNDLE_BYTES = 2_000_000  # 单个 bundle 上限 2MB
MAX_TOTAL_BYTES = 8_000_000   # 总量上限 8MB——超了就是异常，宁可少抓也不拖住建档
DEFAULT_TIMEOUT = 10          # 秒

_SCRIPT_SRC = re.compile(r'<script[^>]+src\s*=\s*["\']([^"\']+)["\']', re.I)
_SCRIPT_BODY = re.compile(r"<script(?![^>]*\bsrc\b)[^>]*>(.*?)</script>", re.I | re.S)
_INLINE_ROUTE_IN_HTML = re.compile(r'path\s*:\s*["\'](/[^"\']*)["\']')

# 常见 OpenAPI 文档地址（很多框架默认开在这些路径）
_OPENAPI_CANDIDATES = ("/openapi.json", "/v3/api-docs", "/swagger.json",
                       "/api-docs", "/swagger/v1/swagger.json", "/docs/openapi.json")

# 危险动作关键词（HTML 文案级粗筛，仅用于提示；真正的白名单在执行期 action_policy）
_RISK_WORDS = {
    "删除": "delete_record", "清空": "delete_record", "注销": "delete_record",
    "重置": "delete_record", "支付": "submit_payment", "付款": "submit_payment",
    "下单": "submit_order", "提交订单": "submit_order", "发布": "publish",
    "发送短信": "send_sms", "群发": "send_email",
}

# 路由首段 → 模块名（接口路径与页面路径共用同一套粗分类，便于按模块装配知识）


_META_CHARSET = re.compile(r'charset=["\']?([\w\-]+)', re.I)


def _decode(raw: bytes, content_type: str) -> str:
    """按 charset 声明解码，无声明时用 UTF-8 严格试解，再退回 GB18030。

    为什么不能直接用 requests 的 r.encoding：HTTP 规范里 text/* 无 charset 时默认
    ISO-8859-1，requests 照此设值，于是国内大量「Content-Type: text/html」不带 charset
    的系统会被解成乱码——页面文案、控件名、危险按钮全认不出来。UTF-8 严格解码能自校验
    （解不开就抛），所以先试它，再退 GB18030（覆盖 GBK/GB2312），比引 chardet 更可控。
    """
    m = _META_CHARSET.search(content_type or "")
    if m:
        try:
            return raw.decode(m.group(1), errors="replace")
        except LookupError:
            pass
    head = raw[:4096].decode("latin-1", errors="ignore")
    mm = _META_CHARSET.search(head)          # <meta charset="utf-8">
    if mm:
        try:
            return raw.decode(mm.group(1), errors="replace")
        except LookupError:
            pass
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        return raw.decode("gb18030", errors="replace")


class Probe:
    """HTTP 探测的统一封装：所有网络动作走这里，便于测试替换与超时收敛。"""

    def __init__(self, timeout: int = DEFAULT_TIMEOUT, session=None):
        self.timeout = timeout
        self._session = session
        self.trace: list[dict] = []

    @property
    def session(self):
        if self._session is None:
            import requests
            self._session = requests.Session()
            self._session.headers["User-Agent"] = "AITestHarness-Bootstrap/1.0"
        return self._session

    def get(self, url: str, max_bytes: int | None = None) -> dict:
        try:
            r = self.session.get(url, timeout=self.timeout, allow_redirects=True)
            raw = r.content if max_bytes is None else r.content[:max_bytes]
            text = _decode(raw, r.headers.get("Content-Type", ""))
            out = {"ok": r.status_code < 400, "status": r.status_code, "url": url,
                   "final_url": str(r.url), "text": text, "bytes": len(r.content),
                   "content_type": r.headers.get("Content-Type", ""), "error": None}
        except Exception as exc:                      # 网络不可达/超时/证书
            out = {"ok": False, "status": 0, "url": url, "final_url": url, "text": "",
                   "bytes": 0, "content_type": "", "error": f"{type(exc).__name__}: {exc}"}
        self.trace.append({"url": url, "ok": out["ok"], "status": out["status"],
                           "bytes": out["bytes"]})
        return out

    def get_json(self, url: str) -> dict | None:
        r = self.get(url, max_bytes=MAX_TOTAL_BYTES)
        if not r["ok"] or not r["text"].strip():
            return None
        try:
            return json.loads(r["text"])
        except json.JSONDecodeError:
            return None


# ---------------------------------------------------------------- 路由归一化

_UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)
_HASH_LIKE = re.compile(r"^[0-9a-f]{16,}$", re.I)
_HAS_DIGIT = re.compile(r"\d")
_VERSION_SEG = re.compile(r"^v\d+$", re.I)


def _is_instance_segment(seg: str) -> bool:
    """判断一段路径是否"实例标识"（应被参数化）。

    除纯数字/UUID/显式参数外，业务编号（`T-2026-0001`、`PO20260101`、`SKU-889`）
    同样要收敛，否则同一个页面会被当成两个（实测 `/stock/check/:id` 与
    `/stock/check/T-2026-0001` 没合并，页面数虚高）。判定用「含数字 + 长度≥4」，
    并排除 `v1/v2` 这类版本段——它们语义上是固定路径。
    """
    if not seg:
        return False
    if seg.isdigit() or _UUID.match(seg) or _HASH_LIKE.match(seg):
        return True
    if seg.startswith(":") or (seg.startswith("{") and seg.endswith("}")):
        return True
    if _VERSION_SEG.match(seg):
        return False
    return len(seg) >= 4 and bool(_HAS_DIGIT.search(seg))


def normalize_route(route: str) -> str:
    """把具体实例路由收敛成参数化路由：/order/123 → /order/:id。

    为什么必须做：JS 里既声明 `path: '/order/:id'`，又散落大量跳转字面量
    `to: '/order/123'`、`'/detail/8f3a...'`。不归一化，47 个页面会被数成 200 多个，
    建档报告直接失真，后续按页面分配用例也会重复计。
    """
    if not route:
        return ""
    p = str(route).split("?")[0].split("#")[0].strip()
    if not p.startswith("/"):
        p = "/" + p
    segs = []
    for s in p.split("/"):
        if not s:
            continue
        segs.append(":id" if _is_instance_segment(s) else s)
    norm = "/" + "/".join(segs)
    return norm.rstrip("/") or "/"


def normalize_routes(routes: list[str]) -> dict:
    """批量归一化，返回 {routes, count, raw_count, collapsed}。

    collapsed 记录被合并的实例路由，供报告展示"实际页面少于此前的点击发现数"。
    """
    alias: dict[str, set[str]] = {}
    for r in routes or []:
        n = normalize_route(r)
        if n:
            alias.setdefault(n, set()).add(str(r))
    collapsed = {k: sorted(v) for k, v in alias.items() if len(v) > 1}
    norm = sorted(alias)
    return {"routes": norm, "count": len(norm),
            "raw_count": len(routes or []), "collapsed": collapsed}


def guess_route_module(route: str) -> str:
    """路由 → 模块名。与接口模块共用同一套噪声段规则，保证两侧科目标签可对齐。"""
    from ..requirement.parsers import module_of
    return module_of(route)


# ---------------------------------------------------------------- 站点探测

def probe_site(base_url: str, probe: Probe | None = None,
               extra_js: str | None = None) -> dict:
    """抓首页与 bundle，产出路由清单与技术栈。**硬限流，绝不无限抓。**"""
    from ..explore.explorer import detect_stack, extract_routes

    p = probe or Probe()
    home = p.get(base_url)
    if not home["ok"]:
        return {"ok": False, "error": home["error"] or f"HTTP {home['status']}",
                "routes": [], "stack": {}, "bundles": [], "home": home}

    html = home["text"]
    blob_parts = [html] + _INLINE_ROUTE_IN_HTML.findall(html)
    bundles, skipped, total = [], [], 0
    seen = set()
    for src in _SCRIPT_SRC.findall(html):
        if len(bundles) >= MAX_BUNDLES:
            skipped.append({"src": src, "reason": f"超过 bundle 数量上限 {MAX_BUNDLES}"})
            continue
        abs_url = urljoin(home["final_url"] or base_url, src)
        if abs_url in seen:
            continue
        seen.add(abs_url)
        if total >= MAX_TOTAL_BYTES:
            skipped.append({"src": abs_url, "reason": f"超过总字节上限 {MAX_TOTAL_BYTES}"})
            continue
        r = p.get(abs_url, max_bytes=MAX_BUNDLE_BYTES)
        if not r["ok"]:
            skipped.append({"src": abs_url, "reason": r["error"] or f"HTTP {r['status']}"})
            continue
        if r["bytes"] > MAX_BUNDLE_BYTES:
            skipped.append({"src": abs_url,
                            "reason": f"单文件 {r['bytes']}B 超过上限 {MAX_BUNDLE_BYTES}B（已截断）"})
        total += min(r["bytes"], MAX_BUNDLE_BYTES)
        bundles.append({"src": abs_url, "bytes": r["bytes"]})
        blob_parts.append(r["text"])

    for body in _SCRIPT_BODY.findall(html):
        blob_parts.append(body)
    if extra_js:
        blob_parts.append(extra_js)

    bundle_text = "\n".join(blob_parts)
    raw = extract_routes(bundle_text)
    norm = normalize_routes(raw["routes"])
    return {
        "ok": True, "error": None,
        "html": html,
        "home": {"status": home["status"], "final_url": home["final_url"],
                 "bytes": home["bytes"]},
        "stack": detect_stack(bundle_text),
        "routes": norm["routes"],
        "routes_raw": raw["routes"],
        "route_prefixes": raw.get("prefixes") or [],
        "routes_meta": {"raw_count": norm["raw_count"], "count": norm["count"],
                        "collapsed": norm["collapsed"],
                        "prefixes": raw.get("prefixes") or []},
        "bundles": bundles, "skipped": skipped,
        "fetched_bytes": total,
        "truncated": bool(skipped),
    }


_CAPTCHA_IMG = re.compile(r"captcha|verify|vcode|validate|yzm|验证码|checkcode", re.I)
_SMS_HINT = ("获取验证码", "发送验证码", "获取短信", "重发", "重新获取", "发送短信")


def _captcha_kind(dom: dict, text: str) -> str | None:
    """验证码类型的精确判定（在 detect_captcha_type 之前先跑，命中即采用）。

    为什么不只靠 `str(dom)` 里搜关键词：`<img src="/captcha.jpg">` 的线索在 src 上，
    不把 img 特征显式提出来就会判成 none——而漏判验证码的后果很实际：登录器不会
    启用策略链，会话固化直接失败，用户第一次跑就卡在登录（这正是被点名的问题）。
    """
    blob = str(dom).lower() + " " + (text or "").lower()
    if "slider" in blob or "滑块" in blob:
        return "slider"
    if "click_select" in blob or "点选" in blob:
        return "click_select"
    if any(h in (text or "") for h in _SMS_HINT):
        return "sms"
    if (dom.get("captcha_imgs") or 0) > 0:
        return "image"
    return None


def probe_login(html: str) -> dict:
    """从首页 HTML 探测登录表单与验证码类型（零 LLM，规则判定）。

    注意返回 `is_login: None` 的场景：iframe/canvas 内登录或登录在独立路由页，
    DOM 规则不适用。此时**不要**当作"没有登录"，否则后续会漏掉会话固化这一步。
    """
    from ..exec.login import detect_captcha_type, detect_login_form

    try:
        from bs4 import BeautifulSoup
        soup = BeautifulSoup(html or "", "html.parser")
        inputs = [{"type": (el.get("type") or "text"), "name": el.get("name"),
                   "id": el.get("id"), "placeholder": el.get("placeholder")}
                  for el in soup.find_all("input")]
        # 验证码图必须显式提取：线索在 src/id/alt/class 上，只看文本会漏判
        cap_imgs = 0
        for el in soup.find_all("img"):
            blob = " ".join(str(x) for x in (el.get("src"), el.get("id"), el.get("alt"),
                                             el.get("name"), el.get("class") or []))
            if _CAPTCHA_IMG.search(blob):
                cap_imgs += 1
        body_text = soup.get_text(" ", strip=True) or ""
        classes = set()
        for el in soup.find_all(True):
            for c in (el.get("class") or []):
                classes.add(str(c).lower())
        dom = {"inputs": inputs,
               "forms": len(soup.find_all("form")),
               "iframes": len(soup.find_all("iframe")),
               "canvas": len(soup.find_all("canvas")),
               "captcha_imgs": cap_imgs,
               # class 名单是滑块/点选类验证码的唯一线索（常在 div 上，无文本）
               "classes": sorted(classes)[:300],
               "text": body_text[:4000]}
    except Exception:                                  # bs4 缺失时降级正则
        inputs = [{"type": (m.group(1) or "text"),
                   "name": (m.group(2) or "")}
                  for m in re.finditer(r'<input[^>]*type=["\']([^"\']*)["\'][^>]*'
                                       r'(?:name=["\']([^"\']*)["\'])?', html or "", re.I)]
        raw = html or ""
        cap_imgs = len([m for m in re.finditer(r"<img[^>]*>", raw, re.I)
                        if _CAPTCHA_IMG.search(m.group(0))])
        body_text = re.sub(r"<[^>]+>", " ", raw)[:4000]
        classes = sorted({c.lower().strip() for m in re.finditer(r'class=["\']([^"\']*)["\']', raw, re.I)
                          for c in m.group(1).split()})[:300]
        dom = {"inputs": inputs,
               "forms": len(re.findall(r"<form", raw, re.I)),
               "iframes": len(re.findall(r"<iframe", raw, re.I)),
               "canvas": len(re.findall(r"<canvas", raw, re.I)),
               "captcha_imgs": cap_imgs,
               "classes": classes,
               "text": body_text}

    det = detect_login_form(dom)
    # 传给 detect_captcha_type 的必须是"净化"视图：本模块新增的 captcha_imgs/classes
    # 键名本身就含 captcha/img 字样，会把它自己的关键词匹配喂成假命中。
    safe = {k: dom[k] for k in ("inputs", "forms", "iframes", "canvas", "text") if k in dom}
    captcha = _captcha_kind(dom, body_text) or detect_captcha_type(safe)
    return {"is_login": det.get("is_login"), "confidence": det.get("confidence"),
            "username_field": det.get("username_field"),
            "password_field": det.get("password_field"),
            "reason": det.get("reason"),
            "captcha_type": captcha,
            "captcha_imgs": cap_imgs,
            "inputs": len(dom["inputs"]), "forms": dom["forms"],
            "iframes": dom["iframes"], "canvas": dom["canvas"],
            "session_saved": False,           # 会话固化要真跑登录器，属阶段②
            }


def probe_openapi(base_url: str, probe: Probe | None = None,
                  explicit_url: str | None = None) -> dict:
    """尝试常见 OpenAPI 文档地址。命中即解析成接口清单（零 LLM）。"""
    from ..requirement.parsers import parse_openapi

    p = probe or Probe()
    if explicit_url:
        try_urls = [urljoin(base_url, explicit_url)]
    else:
        parsed = urlparse(base_url)
        root = f"{parsed.scheme}://{parsed.netloc}"
        try_urls = [urljoin(root, c) for c in _OPENAPI_CANDIDATES]

    tried = []
    for u in try_urls:
        spec = p.get_json(u)
        tried.append({"url": u, "hit": spec is not None})
        if not spec or not isinstance(spec, dict):
            continue
        if not (spec.get("paths") or spec.get("openapi") or spec.get("swagger")):
            continue
        # parse_openapi 只吃文件路径，写临时文件后复用同一套解析逻辑，避免两套实现漂移
        tmp = Path(tempfile.mkdtemp(prefix="aip-openapi-")) / "spec.json"
        tmp.write_text(json.dumps(spec, ensure_ascii=False), encoding="utf-8")
        try:
            parsed = parse_openapi(str(tmp))
        finally:
            tmp.unlink(missing_ok=True)
        parsed["source_url"] = u
        parsed["tried"] = tried
        return parsed
    return {"api_count": 0, "apis": [], "modules": [], "source_url": None,
            "spec_version": None, "tried": tried}


def scan_risky_actions(text: str) -> list[dict]:
    """HTML 文案级危险动作粗筛。只用于**建档提示**，不作为执行期白名单。"""
    hits, low = [], text or ""
    for word, action in _RISK_WORDS.items():
        if word in low:
            hits.append({"text": word, "action": action})
    return hits


# ---------------------------------------------------------------- 主链路

def bootstrap(project: str, env: str, url: str, openapi_url: str | None = None,
              extra_js: str | None = None, probe: Probe | None = None,
              engine_version: str = "1.0.0") -> dict:
    """给一个地址，产出 maps IR + 建档报告。全过程零 LLM。"""
    from ..knowledge.maps import build_maps

    p = probe or Probe()
    site = probe_site(url, p, extra_js=extra_js)
    warnings: list[str] = []

    if not site["ok"]:
        warnings.append(f"首页不可达：{site['error']}——请确认地址/网络/VPN，或稍后重试")
        return {"ok": False, "error": site["error"], "maps": None,
                "report": {"project": project, "env": env, "url": url,
                           "warnings": warnings, "probed_at": _now()},
                "probe_trace": p.trace}

    login = probe_login(site.get("html") or "")
    if login.get("is_login") is None:
        warnings.append("登录表单未能在首页 DOM 中确认（iframe/canvas 或独立登录页）："
                        "请在探索阶段②用视觉模式补探，勿假定无登录")
    elif login.get("is_login") is False:
        warnings.append("未发现登录表单：若系统确需登录，说明登录在独立路由或独立域名，"
                        "需在阶段②单独建档，否则会话固化会缺失")
    if login.get("captcha_type") in ("slider", "click_select", "sms", "image"):
        warnings.append(f"检测到验证码类型 `{login['captcha_type']}`："
                        "需在登录器中配置对应策略链，否则无法固化会话")
    elif login.get("captcha_type") == "unknown":
        warnings.append("疑似存在验证码但类型未能识别（仅有 captcha 类关键词，"
                        "无滑块/点选/短信特征）：需人工确认后配置策略链")

    api = probe_openapi(url, p, explicit_url=openapi_url)
    if not api.get("api_count"):
        warnings.append("未发现 OpenAPI 文档：接口清单需在读流量（阶段②）或手工导入补充，"
                        "否则按接口优先的验证方式分配会退化到 UI")

    risky = scan_risky_actions(site.get("html") or "")
    if risky:
        warnings.append("首页存在高危文案按钮（" +
                        "、".join(sorted({r["text"] for r in risky})) +
                        "）：首次探索务必只读模式，禁用提交类动作")

    routes = site["routes"]
    maps = build_maps(
        project=project, env=env, routes=routes,
        controls_by_page=None,                 # 静态抓取拿不到控件，如实留空
        apis=[{"method": a["method"], "path": a["path"], "module": a.get("module"),
               "required": a.get("request_required") or []} for a in api.get("apis") or []],
        login={"form_detected": login.get("is_login"),
               "username_field": login.get("username_field"),
               "password_field": login.get("password_field"),
               "captcha_type": login.get("captcha_type"),
               "session_saved": login.get("session_saved")},
        engine_version=engine_version,
    )

    report = _build_report(project, env, url, site, login, api, risky, maps, warnings)
    maps["_build_meta"]["probe"] = {
        "bundles": len(site["bundles"]), "fetched_bytes": site["fetched_bytes"],
        "truncated": site["truncated"],
    }
    return {"ok": True, "error": None, "maps": maps, "report": report,
            "probe_trace": p.trace}


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _build_report(project, env, url, site, login, api, risky, maps, warnings) -> dict:
    pages_total = len(maps["pages"])
    registered = maps["stats"]["pages_registered"]
    covered_modules = sorted({guess_route_module(p["route"]) for p in maps["pages"]})
    api_modules = sorted({a["module"] for a in maps["apis"]})
    module_gap = sorted(set(covered_modules) - set(api_modules)) if api_modules else []

    return {
        "project": project, "env": env, "url": url,
        "probed_at": _now(),
        "stack": site.get("stack") or {},
        "routes": {"count": site["routes_meta"]["count"],
                   "raw_count": site["routes_meta"]["raw_count"],
                   "collapsed": site["routes_meta"]["collapsed"],
                   "prefixes": site["routes_meta"]["prefixes"],
                   "sample": site["routes"][:30]},
        "pages": {"total": pages_total, "registered": registered,
                  "unregistered": pages_total - registered},
        "apis": {"count": api.get("api_count", 0),
                 "modules": api_modules,
                 "spec_version": api.get("spec_version"),
                 "source_url": api.get("source_url"),
                 "tried": api.get("tried") or []},
        "login": login,
        "risky_actions": risky,
        "modules": {"pages": covered_modules, "apis": api_modules,
                    "page_only": module_gap},
        "bundles": site.get("bundles") or [],
        "skipped": site.get("skipped") or [],
        "warnings": warnings,
        "next_steps": _next_steps(registered, pages_total, api.get("api_count", 0),
                                 login, risky, site["routes_meta"]["prefixes"]),
    }


def _next_steps(registered: int, pages: int, api_count: int, login: dict,
                risky: list, prefixes: list | None = None) -> list[str]:
    steps = []
    if pages and not registered:
        steps.append(f"{pages} 个页面仅拿到路由、无控件清单：进入探索阶段②渲染补探"
                     f"（优先补路由中的前 10 个高频页面）")
    if prefixes:
        steps.append(f"存在 {len(prefixes)} 个拼接式路由前缀：其中子页面无法静态枚举，"
                     "阶段②巡检时需从菜单/导航栏补充发现")
    if not api_count:
        steps.append("接口清单为空：导入 OpenAPI 或开读流量采集，再跑一次建档")
    if login.get("is_login") and not login.get("session_saved"):
        steps.append("登录表单已识别但会话未固化：跑一次登录器（含验证码策略链）后回填 maps")
    if risky:
        steps.append("存在高危动作文案：首次探索以只读白名单启动（action_policy）")
    if not steps:
        steps.append("静态建档已完成，可进入探索阶段②做控件补探与试触")
    return steps


def render_report_markdown(report: dict) -> str:
    """建档报告（人可读）——用户点完"新建项目"该看到的第一个界面。"""
    if not report.get("project"):
        return "# 建档失败\n\n" + "\n".join(f"- {w}" for w in report.get("warnings") or [])
    st = report["stack"]
    lines = [
        f"# 项目建档报告：{report['project']}（环境 {report['env']}）",
        "",
        f"- 地址：{report['url']}",
        f"- 建档时间：{report['probed_at']}",
        f"- 技术栈：{st.get('stack') or '未识别'}"
        + (f"（{st.get('evidence')}）" if st.get("evidence")
           and st.get("stack") not in (None, "unknown") else ""),
        "",
        "## 一、页面",
        "",
        f"- 归一化后路由：**{report['routes']['count']}** 个"
        f"（原始字面量 {report['routes']['raw_count']} 个，"
        f"合并实例路由 {len(report['routes']['collapsed'])} 组）",
        f"- 已建档（含控件清单）：**{report['pages']['registered']}** / "
        f"{report['pages']['total']}，未建档 {report['pages']['unregistered']} 个",
        "",
    ]
    if report["routes"]["collapsed"]:
        lines.append("被合并的实例路由示例（同页面不同参数）：")
        for k, v in list(report["routes"]["collapsed"].items())[:5]:
            lines.append(f"- `{k}` ← {', '.join(f'`{x}`' for x in v[:3])}"
                         + ("…" if len(v) > 3 else ""))
        lines.append("")
    if report["routes"].get("prefixes"):
        lines += ["拼接式路由前缀（如 `'/order/' + id`，说明有子页面无法静态枚举）：", ""]
        lines += [f"- `{p}`" for p in report["routes"]["prefixes"][:8]]
        lines.append("")
    if report["routes"]["sample"]:
        lines += ["路由样例：", ""]
        lines += [f"- `{r}`" for r in report["routes"]["sample"][:15]]
        lines.append("")

    lines += ["## 二、接口", "",
              f"- 接口数：**{report['apis']['count']}**"
              + (f"（OpenAPI {report['apis']['spec_version']}，来自 "
                 f"{report['apis']['source_url']}）" if report["apis"]["source_url"] else
                 "（未发现 OpenAPI 文档）"),
              f"- 模块：{', '.join(report['apis']['modules']) or '—'}", ""]

    lg = report["login"]
    lines += ["## 三、登录", "",
              f"- 表单识别：{_fmt_login(lg)}",
              f"- 验证码类型：`{lg.get('captcha_type') or 'unknown'}`",
              f"- 会话固化：{'已固化' if lg.get('session_saved') else '未固化（待阶段②）'}",
              f"- 判定依据：{lg.get('reason') or '—'}", ""]

    if report["modules"]["page_only"]:
        lines += ["## 四、页面与接口的模块错位", "",
                  "以下模块有页面但无同名接口清单。可能是接口走私有协议/未导出 OpenAPI，"
                  "也可能只是页面与接口的命名不同源（如页面 `login` ↔ 接口 `auth`），"
                  "**仅作提示，需人工判读**：", ""]
        lines += [f"- `{m}`" for m in report["modules"]["page_only"]]
        lines.append("")

    if report["risky_actions"]:
        lines += ["## 五、高危动作提示", "",
                  "| 文案 | 归类 |", "| --- | --- |"]
        lines += [f"| {r['text']} | `{r['action']}` |" for r in report["risky_actions"]]
        lines.append("")

    if report["warnings"]:
        lines += ["## 六、警告", ""] + [f"- ⚠️ {w}" for w in report["warnings"]] + [""]

    lines += ["## 七、下一步", ""] + [f"{i}. {s}" for i, s in
                                    enumerate(report["next_steps"], 1)] + [""]
    return "\n".join(lines)


def _fmt_login(lg: dict) -> str:
    v = lg.get("is_login")
    if v is True:
        return (f"是（置信度 {lg.get('confidence')}；用户名 `{lg.get('username_field')}`，"
                f"口令 `{lg.get('password_field')}`）")
    if v is False:
        return f"否（{lg.get('reason') or '未发现密码框'}）"
    return "无法确认（iframe/canvas 或独立登录页，需视觉模式）"


def write_bundle(out_dir: str | Path, maps: dict, report: dict) -> dict:
    """落盘：maps IR（YAML）+ 建档报告（Markdown）。原子写，避免半个文件。"""
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    maps_path = out / f"maps-{report.get('env') or 'default'}.yaml"
    rep_path = out / f"bootstrap-report-{report.get('env') or 'default'}.md"

    import yaml
    for path, content in ((maps_path, yaml.safe_dump(maps, allow_unicode=True,
                                                     sort_keys=False)),
                          (rep_path, render_report_markdown(report))):
        tmp = path.with_suffix(path.suffix + ".tmp")
        tmp.write_text(content, encoding="utf-8")
        tmp.replace(path)                     # 原子替换，防崩溃写半截
    return {"maps": str(maps_path), "report": str(rep_path)}
