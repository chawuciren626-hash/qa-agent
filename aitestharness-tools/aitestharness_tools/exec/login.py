"""§12.6 登录器与验证码策略链（领导批评的痛点正解）。

策略链：探测分类 → 按项目配置排序 → 逐策略尝试。图形验证码必须自动完成；只有短信、扫码、滑块、点选等人工验证码才进入人工接管。

四条实战红线（§12.6，全部落进代码）：
1. **先分类再处理**：图形码/滑块/点选/短信/无验证码 处理链路完全不同，禁止盲目尝试；
2. **验证码失败最多重试 1 次**——反复尝试触发风控锁号，把"一次失败"变成"账号被封"；
3. **策略成功率按项目维度统计并排序**——A 项目滑块靠打码平台，B 项目只接受测试万能码；
4. **会话复用是终极解法**：把验证码从"每次执行"降到"每周一次"。
   **登录器首要价值不是"能登录"，而是固化会话。**

探测是零 LLM 的（DOM 特征规则：拉 DOM 找 input[type=password] 及相邻 input）。
"""
from __future__ import annotations

from dataclasses import dataclass, field

__all__ = ["CAPTCHA_TYPES", "detect_login_form", "detect_captcha_type",
           "LoginStrategyChain", "SessionCache", "LOGIN_STANDARD_FLOW"]

# 验证码分类（封闭枚举）
CAPTCHA_TYPES = ("none", "image", "slider", "click_select", "sms", "unknown")

# 每种分类的处理链路（策略顺序）：先便宜后昂贵；image 最后由代理视觉自动识别
_STRATEGY_ORDER = {
    "none": ("direct",),
    "image": ("test_bypass_code", "ocr", "captcha_service", "agent_vision"),
    "slider": ("slider_solver", "captcha_service", "manual"),
    "click_select": ("captcha_service", "manual"),
    "sms": ("sms_fixed_code", "manual"),
    "unknown": ("manual",),
}

# §12.6 标准解法五步（工具化效果示例）
LOGIN_STANDARD_FLOW = (
    ("detect", "拉 DOM 找 input[type=password] 及相邻 input → 识别登录表单；iframe/canvas 才降级视觉", "毫秒级，零 LLM"),
    ("fill", "账号密码按配置写入", "零 LLM"),
    ("captcha", "检测元素类型 → 分类 → 图形码自动策略链（万能码 → OCR → 打码平台 → 代理视觉）；短信/扫码/滑块/点选才人工接管", "图形码不转人工"),
    ("persist", "一次成功即把表单特征+提交路径+会话存储位置写入登录配置", "一次性"),
    ("replay", "下次注入会话，1 秒内进入可测状态", "零 LLM"),
)


def detect_login_form(dom_summary: dict) -> dict:
    """零 LLM 探测（§12.6 步 1）：从结构化 DOM 摘要判断是否有登录表单。

    dom_summary: {"inputs": [{"type": "password", "name": "...", ...}, ...],
                  "forms": n, "iframes": n, "canvas": n}
    """
    inputs = dom_summary.get("inputs") or []
    pwd = [i for i in inputs if (i.get("type") or "").lower() == "password"]
    if pwd:
        idx = inputs.index(pwd[0])
        adjacent = inputs[max(idx - 1, 0):idx]      # 相邻 input = 用户名
        return {"is_login": True, "confidence": "high",
                "username_field": adjacent[0].get("name") if adjacent else None,
                "password_field": pwd[0].get("name"),
                "reason": "命中 input[type=password] 及相邻 input（零 LLM 规则）"}
    if (dom_summary.get("iframes") or 0) > 0 or (dom_summary.get("canvas") or 0) > 0:
        return {"is_login": None, "confidence": "low",
                "reason": "iframe/canvas 场景：DOM 规则不适用，降级视觉模式"}
    return {"is_login": False, "confidence": "medium",
            "reason": "未发现密码框特征"}


def detect_captcha_type(dom_summary: dict) -> str:
    """验证码分类（零 LLM 规则）→ CAPTCHA_TYPES 之一。"""
    blob = str(dom_summary).lower()
    if not any(k in blob for k in ("captcha", "验证码", "slider", "滑块", "yzm")):
        return "none"
    if "slider" in blob or "滑块" in blob:
        return "slider"
    if "click" in blob or "点选" in blob:
        return "click_select"
    if "sms" in blob or "短信" in blob or "code_input" in blob:
        return "sms"
    if "image" in blob or "img" in blob:
        return "image"
    return "unknown"


@dataclass
class LoginStrategyChain:
    """策略链执行器：按项目统计成功率排序（§12.6 红线 3）。

    stats: {project: {strategy: {"success": n, "attempt": n}}}（跨执行累积）
    """

    stats: dict = field(default_factory=dict)
    max_attempts: int = 1        # 红线 2：验证码失败最多重试 1 次

    def order_for(self, project: str, captcha_type: str) -> list[str]:
        base = list(_STRATEGY_ORDER.get(captcha_type, ("manual",)))
        proj = (self.stats.get(project) or {})
        # 有成功记录的策略按成功率降序提前，人工策略只在人工验证码类型中保留
        scored = []
        for s in base:
            st = proj.get(s) or {}
            rate = (st.get("success", 0) / st["attempt"]) if st.get("attempt") else -1
            scored.append((s, rate))
        auto = [s for s, _ in sorted(scored, key=lambda x: (x[0] == "manual", -x[1]))]
        return auto

    def run(self, project: str, captcha_type: str, executors: dict, context: dict) -> dict:
        """逐策略尝试；executors: {strategy_name: callable(context)->bool}。

        红线 2：同一分类下自动策略最多尝试 max_attempts 次；图形验证码用尽后返回自动识别失败。
        """
        attempts = []
        tried = 0
        for strategy in self.order_for(project, captcha_type):
            if strategy == "manual":
                if captcha_type == "image":
                    continue
                attempts.append({"strategy": "manual", "ok": None})
                return self._record(project, attempts,
                                    {"status": "manual_required",
                                     "reason": f"验证码类型 {captcha_type} 需要人工处理（短信/扫码/滑块/点选）"})
            if tried >= self.max_attempts + 1:   # 首次 + 1 次重试
                break
            fn = executors.get(strategy)
            if fn is None:
                attempts.append({"strategy": strategy, "ok": None, "skipped": "未配置"})
                continue
            tried += 1
            ok = bool(fn(context))
            attempts.append({"strategy": strategy, "ok": ok})
            if ok:
                return self._record(project, attempts, {"status": "ok", "used": strategy})
        if captcha_type == "image":
            # 状态值收敛到既有的 `manual_required`：上层（browser-task 与验收用例）只认
            # ok / manual_required 两种收尾，`recognition_failed` 是没有任何消费方的孤儿值——
            # 新增一个没人处理的状态，效果是"识别失败被当成未知结果丢掉"。
            # 区分仍然保留在 `auto_recognition_failed` 上：诊断要分清"类型就得人工"
            # 与"自动识别试过了但没成"。
            return self._record(project, attempts,
                                {"status": "manual_required",
                                 "auto_recognition_failed": True,
                                 "reason": f"已尝试 {tried} 次（含 ≤1 次重试，防风控锁号），图形验证码自动识别失败，转人工"})
        attempts.append({"strategy": "manual", "ok": None})
        return self._record(project, attempts,
                            {"status": "manual_required",
                             "reason": f"已尝试 {tried} 次（含 ≤1 次重试，防风控锁号），人工验证码等待人工处理"})

    def _record(self, project, attempts, result):
        slot = self.stats.setdefault(project, {})
        for a in attempts:
            if a.get("skipped"):
                continue
            s = slot.setdefault(a["strategy"], {"success": 0, "attempt": 0})
            s["attempt"] += 1
            if a.get("ok"):
                s["success"] += 1
        result["attempts"] = attempts
        return result


class SessionCache:
    """会话固化（§12.6 红线 4：会话复用是终极解法）。

    一次成功 → 存 {cookie/token, 表单特征, 提交路径} → 下次直接注入（1 秒内进入可测态）。
    """

    def __init__(self):
        self._sessions: dict[str, dict] = {}

    def save(self, project: str, session: dict):
        for key in ("storage", "form_signature", "submit_path"):
            if key not in session:
                raise ValueError(f"会话固化缺字段 {key}：无法在下一次复现进入路径")
        self._sessions[project] = dict(session)

    def inject(self, project: str) -> dict | None:
        return self._sessions.get(project)

    def invalidate(self, project: str):
        self._sessions.pop(project, None)
