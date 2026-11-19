"""探针接口与失败语义（M2a）。

四个方法就是一张「原料清单」：**bundle（脚本原文）/ flat_dom（扁平结构）/ screenshot（像素）/ act（动作）**。
四个方法之外的一切判断都不在这里做——判定属于纯函数层，动作编排属于 run 派发层。

为什么是这四个而不是"一个 evaluate 随便你传 JS"：

1. 随便传 JS 等于把浏览器句柄泄给上层，判定代码就会开始依赖 page，单测立刻需要浏览器；
2. 四个方法的产物都是**可序列化**的（str / list[dict] / bytes），因此可以整体存档、回放、做基线 diff；
3. 将来换驱动（Appium / 小程序）只需实现同样四个方法，上层一行不改——这是 M3/M5 能复用 M2 的前提。
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Protocol, runtime_checkable

__all__ = ["PartialFailure", "ProbeUnavailable", "Bundle", "ScriptRef", "FlatDom",
           "ActResult", "WebProbe", "SOURCE_BUNDLE", "SOURCE_DOM", "SOURCE_VISUAL",
           "SOURCE_UNRESOLVED"]

# 产物来源标记：maps 里每个页面/每个控件都带，回答"这条信息是怎么来的"。
# 没有这个标记，就无法区分"页面确实没有这个控件"与"我们没看到这个页面"——这是探索最容易骗自己的地方。
SOURCE_BUNDLE = "bundle"          # ① 静态解析：JS 原文里读出来的路由/组件
SOURCE_DOM = "dom"                # ② 结构巡检：浏览器里读出来的扁平 DOM
SOURCE_VISUAL = "visual"          # ③ 视觉兜底：截图 + VLM（M2b，由 agent 经 MCP 发起）
SOURCE_UNRESOLVED = "unresolved"  # 三层都没拿到：交人工圈选，不猜


@dataclass
class ScriptRef:
    """一段脚本来源：内联或外链，text 为取到的原文（外链取不到时为 None）。"""
    url: str
    text: str | None = None
    inline: bool = False
    error: str | None = None


@dataclass
class Bundle:
    """① 静态解析产物：HTML 原文 + 脚本原文。

    注意它是**唯一的零浏览器产物**：现代 Web 应用的路由表、组件名、接口前缀都在 JS 里，
    直接取原文比"点着看"快两个数量级，且完全确定（同输入同输出，可单测、可缓存）。
    """
    url: str
    status: int
    html: str
    scripts: list[ScriptRef] = field(default_factory=list)
    source: str = SOURCE_BUNDLE
    content_type: str = ""
    error: str | None = None

    def js_text(self) -> str:
        """把所有拿到的脚本原文拼起来（路由提取、技术栈识别的输入）。"""
        return "\n".join(item.text for item in self.scripts if item.text)

    def to_dict(self, include_text: bool = False) -> dict:
        return {
            "url": self.url, "status": self.status, "source": self.source,
            "content_type": self.content_type, "error": self.error,
            "scripts": [{"url": item.url, "inline": item.inline,
                         "error": item.error,
                         "chars": len(item.text or "") if item.text else 0,
                         **({"text": item.text} if include_text else {})}
                        for item in self.scripts],
            "html_chars": len(self.html or ""),
            "html": self.html if include_text else None,
        }


@dataclass
class FlatDom:
    """② 结构巡检产物：扁平元素列表 + 出现过的 frame。

    元素结构刻意与 `exec/snapshot.build_snapshot` 的入参一致（tag/text/id/name/type/role/
    aria-label/placeholder/data-testid/href/disabled/frames/shadow_host），
    这样"取原料"与"判定"之间不需要一个转换层——少一层就少一处漂移。
    """
    url: str
    elements: list[dict[str, Any]] = field(default_factory=list)
    frames: list[str] = field(default_factory=list)
    source: str = SOURCE_DOM
    truncated: bool = False

    def to_dict(self) -> dict:
        return {"url": self.url, "source": self.source, "frames": self.frames,
                "truncated": self.truncated, "element_count": len(self.elements),
                "elements": self.elements}


@dataclass
class ActResult:
    """动作结果：只报"做了什么、结果如何"，不报"应不应该做"（那是剧本的事）。"""
    ok: bool
    action: str
    detail: dict[str, Any] = field(default_factory=dict)
    url: str = ""
    error: str | None = None

    def to_dict(self) -> dict:
        return {"ok": self.ok, "action": self.action, "url": self.url,
                "detail": self.detail, "error": self.error}


class PartialFailure(Exception):
    """某一页/某一层取不到原料。**必须带上下文**，不许静默降级。

    `tried` 记录已经试过的手段（["bundle", "dom"]），这是 M2b 起视觉兜底时的判据：
    只有前两层都失败才允许上视觉，而不是"模型觉得看不清就上视觉"（那样成本不可控）。
    """

    def __init__(self, url: str, reason: str, tried: list[str] | None = None,
                 detail: dict[str, Any] | None = None):
        self.url = url
        self.reason = reason
        self.tried = list(tried or [])
        self.detail = dict(detail or {})
        super().__init__(f"{url}: {reason}（已试：{'/'.join(self.tried) or '无'}）")

    def as_dict(self) -> dict:
        return {"url": self.url, "reason": self.reason, "tried": self.tried,
                "detail": self.detail, "source": SOURCE_UNRESOLVED}


class ProbeUnavailable(RuntimeError):
    """驱动不可用（未安装 / 浏览器内核缺失）。与 PartialFailure 区分开：
    前者是"这台机器跑不了"，后者是"这一页取不到"——两者排障方向完全不同。"""


@runtime_checkable
class WebProbe(Protocol):
    """Web 探针四个方法。实现方负责连接生命周期，调用方不持有 page。"""

    name: str

    def fetch_bundle(self, url: str, *, timeout_ms: int = 15000) -> Bundle:
        """① 静态解析：HTTP 取 HTML + 脚本原文。**不需要浏览器**。"""
        ...

    def flat_dom(self, url: str, *, timeout_ms: int = 15000) -> FlatDom:
        """② 结构巡检：扁平化 DOM（含 frame / shadow 路径标注）。"""
        ...

    def screenshot(self, url: str, *, full_page: bool = True, timeout_ms: int = 15000) -> bytes:
        """③ 像素：PNG 字节。仅视觉兜底（M2b）与人工排查使用。"""
        ...

    def act(self, url: str, action: dict[str, Any], *, timeout_ms: int = 15000) -> ActResult:
        """④ 动作：click / fill / press / navigate 等**封闭枚举**，不接受任意脚本。"""
        ...

    def close(self) -> None:
        ...
