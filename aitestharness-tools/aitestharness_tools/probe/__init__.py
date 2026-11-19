"""探针层（M2a）：全仓唯一「碰浏览器」的地方。

分层纪律（这是 M2 能否接上的关键，别打破）：

    probe/   → 取原料（HTTP / Playwright / 将来的 Appium、小程序）
    判定层   → 纯函数（explore/explorer.py、exec/snapshot.py）
    agent 层 → 只在「原料取不到」时兜底（M2b 视觉）

三条硬约束：

1. **`import playwright` 只允许出现在 probe/子包内**。判定层与 explore/pipeline 单测时不需要装浏览器，
   一旦有人把 page 对象传进判定函数，这条就废了（也意味着改一条 DOM 规则都要开浏览器验证）。
2. **失败要带上下文**：取不到就抛 `PartialFailure`（页面 + 原因 + 已试手段），
   不许 `except: pass` 后返回空列表——空列表会被下游当成"这个页面没有控件"。
3. **不给 LLM 留钩子**：pipeline 全程零 token，视觉兜底由 agent 经 MCP 单独发起，
   本包任何函数都不准调模型。
"""
from .base import (ActResult, Bundle, FlatDom, PartialFailure, ProbeUnavailable,
                   ScriptRef, WebProbe,
                   SOURCE_BUNDLE, SOURCE_DOM, SOURCE_UNRESOLVED, SOURCE_VISUAL)
from .http_probe import HttpProbe, parse_bundle
from .playwright_probe import PlaywrightProbe, playwright_available

__all__ = ["ActResult", "Bundle", "FlatDom", "PartialFailure", "ProbeUnavailable",
           "ScriptRef", "WebProbe", "HttpProbe", "parse_bundle",
           "PlaywrightProbe", "playwright_available",
           "SOURCE_BUNDLE", "SOURCE_DOM", "SOURCE_UNRESOLVED", "SOURCE_VISUAL",
           "default_probe"]


def default_probe(**kwargs):
    """按可用性装配探针：有 Playwright 用 Playwright，没有就退化成只做 bundle 的 HTTP 探针。

    退化不是"悄悄地降级"——`default_probe` 会把实际情况写进 `probe_name`，
    pipeline 再把它写进 maps 的 `source`，让"这次探索只做了静态解析"这一点在产物里看得见。
    """
    if playwright_available():
        return PlaywrightProbe(**kwargs)
    return HttpProbe(**kwargs)
