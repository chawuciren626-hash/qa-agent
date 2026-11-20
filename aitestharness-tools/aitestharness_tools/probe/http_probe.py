"""HTTP 探针：只做 ① 静态解析，**不开浏览器**。

这条路径的价值不是"省资源"，是**确定性**：取一页 HTML + 若干 JS 原文，跑纯函数就能拿到路由清单，
10 秒级、0 token、可缓存、可在 CI 里对任意站点跑（只要允许访问）。2026-11-19 之前的探索之所以
"十几分钟起、token 上万"，是因为一上来就开浏览器点着看——把可以静态拿的东西用动态方式拿。

`flat_dom` / `screenshot` / `act` 在这是 `ProbeUnavailable`：明确说"这条路径做不到"，
而不是返回空列表假装做到了（空列表会被下游当成"页面没有控件"）。
"""
from __future__ import annotations

import gzip
import re
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

from .base import (Bundle, FlatDom, ProbeUnavailable, ScriptRef, SOURCE_BUNDLE,
                   ActResult)

__all__ = ["parse_bundle", "HttpProbe", "MAX_SCRIPT_BYTES", "MAX_SCRIPTS", "USER_AGENT"]

MAX_SCRIPTS = 40                      # 一页挂 200 个 chunk 的应用很多，全取会把探索时间拖回分钟级
MAX_SCRIPT_BYTES = 4 * 1024 * 1024    # 单个脚本上限：超过多半是 sourcemap 或误命中的大文件
USER_AGENT = "AITestHarness-Explore/1.0 (+probe/http)"

_SCRIPT_TAG = re.compile(r"<script\b([^>]*)>(.*?)</script\s*>", re.I | re.S)
_LINK_TAG = re.compile(r"<link\b([^>]*)>", re.I)
_ATTR = re.compile(r"([a-zA-Z-]+)\s*=\s*(\"[^\"]*\"|'[^']*'|[^\s>]+)")
_CHARSET = re.compile(r"charset\s*=\s*[\"']?([\w-]+)", re.I)


def _attrs(raw: str) -> dict[str, str]:
    out: dict[str, str] = {}
    for name, value in _ATTR.findall(raw or ""):
        out[name.lower()] = value.strip("\"'")
    return out


def parse_bundle(html: str, base_url: str) -> list[ScriptRef]:
    """从 HTML 里抽脚本来源（内联原文 / 外链 URL）。纯函数，可单测，不联网。

    一并抽 `<link rel=modulepreload|preload as=script>`：Vite/Rspack 的生产构建常把真正的
    路由 chunk 放在 preload 里，只认 `<script src>` 会漏掉一半页面。
    """
    refs: list[ScriptRef] = []
    for raw_attrs, body in _SCRIPT_TAG.findall(html or ""):
        attrs = _attrs(raw_attrs)
        src = attrs.get("src")
        if src:
            refs.append(ScriptRef(url=urllib.parse.urljoin(base_url, src), inline=False))
        elif body and body.strip():
            refs.append(ScriptRef(url=base_url, text=body, inline=True))
    for raw_attrs in _LINK_TAG.findall(html or ""):
        attrs = _attrs(raw_attrs)
        rel = (attrs.get("rel") or "").lower()
        if "script" not in rel and "modulepreload" not in rel:
            continue
        href = attrs.get("href")
        if href:
            refs.append(ScriptRef(url=urllib.parse.urljoin(base_url, href), inline=False))
    # 去重但保持出现顺序（同一 chunk 被 preload 与 script 各引用一次很常见）
    seen: set[str] = set()
    unique: list[ScriptRef] = []
    for ref in refs:
        key = f"{ref.url}#{ref.inline}"
        if key in seen:
            continue
        seen.add(key)
        unique.append(ref)
    return unique


def _decode(raw: bytes, content_type: str) -> str:
    match = _CHARSET.search(content_type or "")
    encoding = match.group(1) if match else "utf-8"
    try:
        return raw.decode(encoding, errors="replace")
    except LookupError:
        return raw.decode("utf-8", errors="replace")


class HttpProbe:
    """只实现 ① 的探针。`name` 会进产物，用来解释"这次探索为什么只有静态结果"。"""

    name = "http"

    def __init__(self, *, max_scripts: int = MAX_SCRIPTS,
                 max_script_bytes: int = MAX_SCRIPT_BYTES, timeout_s: float = 15.0):
        self.max_scripts = max_scripts
        self.max_script_bytes = max_script_bytes
        self.timeout_s = timeout_s

    # ---- 内部：一次 GET -------------------------------------------------
    def _get(self, url: str, timeout_s: float | None = None) -> tuple[int, str, str]:
        request = urllib.request.Request(url, headers={
            "User-Agent": USER_AGENT,
            "Accept": "text/html,application/xhtml+xml,application/javascript,*/*",
            "Accept-Encoding": "gzip",
        })
        with urllib.request.urlopen(request, timeout=timeout_s or self.timeout_s) as response:
            raw = response.read(self.max_script_bytes)
            if (response.headers.get("Content-Encoding") or "").lower() == "gzip":
                try:
                    raw = gzip.decompress(raw)
                except OSError:
                    pass
            content_type = response.headers.get("Content-Type") or ""
            return response.status, _decode(raw, content_type), content_type

    # ---- ① 静态解析 ------------------------------------------------------
    def fetch_bundle(self, url: str, *, timeout_ms: int = 15000) -> Bundle:
        timeout_s = max(1.0, timeout_ms / 1000.0)
        try:
            status, html, content_type = self._get(url, timeout_s)
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError) as error:
            return Bundle(url=url, status=0, html="", source=SOURCE_BUNDLE,
                          error=f"{type(error).__name__}: {error}")
        refs = parse_bundle(html, url)
        fetched: list[ScriptRef] = []
        for ref in refs[: self.max_scripts]:
            if ref.inline:
                fetched.append(ref)
                continue
            try:
                _, text, _ = self._get(ref.url, timeout_s)
                fetched.append(ScriptRef(url=ref.url, text=text, inline=False))
            except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError) as error:
                # 单脚本失败不致命：记下 error，路由提取继续用拿到的部分。
                fetched.append(ScriptRef(url=ref.url, text=None, inline=False,
                                         error=f"{type(error).__name__}: {error}"))
        return Bundle(url=url, status=status, html=html, scripts=fetched,
                      source=SOURCE_BUNDLE, content_type=content_type)

    # ---- ②③④ 需要浏览器，明确拒绝 ---------------------------------------
    def flat_dom(self, url: str, *, timeout_ms: int = 15000) -> FlatDom:
        raise ProbeUnavailable("HttpProbe 不支持结构巡检：结构巡检需要 Playwright（probe/playwright_probe.py）")

    def screenshot(self, url: str, *, full_page: bool = True, timeout_ms: int = 15000) -> bytes:
        raise ProbeUnavailable("HttpProbe 不支持截图：视觉兜底需要 Playwright（M2b）")

    def act(self, url: str, action: dict[str, Any], *, timeout_ms: int = 15000) -> ActResult:
        raise ProbeUnavailable("HttpProbe 不支持动作：受控动作需要 Playwright（M4）")

    def close(self) -> None:
        return None
