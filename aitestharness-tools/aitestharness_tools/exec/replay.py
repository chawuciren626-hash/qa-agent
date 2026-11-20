"""N 轮确定性重放（P4 切片二）：证明"同一份计划、同一份数据，跑 N 次结论一致"。

这一层要回答的问题只有一个
--------------------------
**这份计划的结论是不是可复现的？** 不是"跑通了没有"——那是单次执行的事；也不是
"覆盖了多少需求"——那是报告层的事。可复现是回归的前提：一份时好时坏的用例，无论
判 pass 还是 fail 都没有信息量。

三种"一致性"必须分开看，混在一起会得出错误结论：

  1. **结论一致性**（硬判据）：verdict + 每步 status + 每条断言的 decide/passed。
     只有这一项参与 `deterministic`，因为它是"结论"本身。
  2. **内容一致性**（软指标）：断言里的 actual 值是否每轮相同。时间戳、自增 id、
     trace id 会让它天然抖动，而结论照样稳定。把它算进硬判据，等于把"服务端返回了
     不同的 request-id"判成"用例不可复现"——这类误判会直接让人不再相信这套判定。
  3. **可比性**（前置条件）：由 `preflight` 回答，环境是否还是参考基线。环境变了
     而结论也变了，不是 flaky，是两次不同的实验。

为什么每轮都新建引擎实例
------------------------
`ApiEngine` 内部持有一个 `requests.Session`，会话 cookie 会跨轮留存。复用引擎跑 5
轮，第 2 轮起就带着第 1 轮的登录态——那条"未登录必须 401"的剧本会从第 2 轮开始
失败，而这跟被测系统一点关系都没有。轮间必须隔离，隔离点在引擎实例，不在用例。

LLM 守卫（`llm` 字段）
----------------------
"重放零模型"不能靠声明，得能观测：
  · 执行前记录已加载/可导入的模型 SDK 集合，执行后再记一次，**新增即告警**；
  · `sdk_present` 非空不等于违规（环境里装了不代表用了），`loaded_during` 才是硬信号。
"""
from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import sys
import time
import uuid
from datetime import datetime, timezone
from typing import Any, Iterable, Mapping

from .api_engine import ApiEngine
from .manifest import attach_baseline
from .preflight import preflight

# 区分"没给签发回调"（不传参，沿用引擎自带授权）与"显式无授权"
_NO_APPROVAL = object()

__all__ = ["replay", "llm_sdk_present", "REPLAY_SCHEMA", "REPLAY_FILE"]

REPLAY_SCHEMA = "p4-replay/1"
REPLAY_FILE = "replay.json"

# 只做"是否出现"的探测，不尝试调用：这些包一旦被执行链路加载，说明重放可能走了模型
_LLM_SDKS = (
    "openai", "anthropic", "dashscope", "zhipuai", "volcenginesdkarkruntime",
    "langchain", "langchain_core", "llama_index", "google.generativeai",
)


def llm_sdk_present() -> list[str]:
    """当前进程里"已加载或可导入"的模型 SDK。用于重放前后对比。"""
    hits: list[str] = []
    for name in _LLM_SDKS:
        if name in sys.modules:
            hits.append(name)
            continue
        try:
            if importlib.util.find_spec(name) is not None:
                hits.append(name)
        except (ImportError, ValueError, ModuleNotFoundError):
            # 带点的父包不存在时 find_spec 会抛，视同"没装"
            continue
    return hits


def _utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _plan_id(plan: Mapping[str, Any], index: int) -> str:
    lineage = plan.get("lineage") or {}
    return str(lineage.get("id") or f"plan-{index}")


def _declared_credentials(plans: list[Mapping[str, Any]]) -> list[str]:
    """收集各计划顶层 `credentials` 声明（引用形态，去重排序）。

    为什么从计划收集而不是要求调用方记得传：`credential_refs` 此前只有测试夹具传过，
    生产链路全空——指纹机制在，但没人喂。计划是最清楚"这次要登录哪个账号"的一方，
    让它声明，replay 负责搬运。
    """
    refs: list[str] = []
    for plan in plans:
        for ref in plan.get("credentials") or ():
            text = str(ref).strip()
            if text:
                refs.append(text)
    return sorted(set(refs))


def _outcome_key(exec_ir: Mapping[str, Any]) -> tuple:
    """结论指纹：参与确定性判定。刻意不含 actual 值（见模块 docstring 第 2 点）。"""
    steps = tuple(
        (str(step.get("index")), str(step.get("status")),
         tuple((str(a.get("type")), bool(a.get("decide")), bool(a.get("passed")))
               for a in (step.get("assertions") or [])))
        for step in (exec_ir.get("steps") or []))
    return (str(exec_ir.get("verdict")), steps)


def _content_key(exec_ir: Mapping[str, Any]) -> str:
    """内容指纹：只观察。actual 抖动不算不可复现，但要能被看见。"""
    payload = [[str(step.get("index")), [[str(a.get("actual")) for a in (step.get("assertions") or [])]]]
               for step in (exec_ir.get("steps") or [])]
    return hashlib.sha256(json.dumps(payload, ensure_ascii=False, sort_keys=True,
                                     default=str).encode("utf-8")).hexdigest()


def _divergence(baseline_round: Mapping[str, Any], other: Mapping[str, Any],
                round_no: int) -> dict | None:
    """定位首个分歧：轮到轮 → 计划 → 步骤 → 断言，逐层收窄。

    先定位到步骤、再报 verdict 差异——反过来会让"某一步的某个断言翻了"被压缩成
    "verdict 从 pass 变 fail"，等于把唯一的排查线索丢掉。
    """
    for pid, base_ir in baseline_round["execs"].items():
        if pid not in other["execs"]:
            return {"round": round_no, "plan": pid, "step": None, "assertion": None,
                    "because": "该轮缺少这份计划的执行结果"}
        cur_ir = other["execs"][pid]
        if _outcome_key(base_ir) == _outcome_key(cur_ir):
            continue
        base_steps = {str(s.get("index")): s for s in (base_ir.get("steps") or [])}
        cur_steps = {str(s.get("index")): s for s in (cur_ir.get("steps") or [])}
        if set(base_steps) != set(cur_steps):
            return {"round": round_no, "plan": pid, "step": None, "assertion": None,
                    "because": "执行的步骤集合不同（可能中途止步）",
                    "expected": sorted(base_steps), "actual": sorted(cur_steps)}
        for sid, base_step in base_steps.items():
            cur_step = cur_steps[sid]
            if base_step.get("status") != cur_step.get("status"):
                return {"round": round_no, "plan": pid, "step": sid, "assertion": None,
                        "because": f"步骤状态不一致：第 1 轮 {base_step.get('status')}，"
                                   f"本轮 {cur_step.get('status')}"
                                   f"（verdict {base_ir.get('verdict')} → {cur_ir.get('verdict')}）",
                        "expected": base_step.get("status"), "actual": cur_step.get("status")}
            base_as = base_step.get("assertions") or []
            cur_as = cur_step.get("assertions") or []
            if len(base_as) != len(cur_as):
                return {"round": round_no, "plan": pid, "step": sid, "assertion": None,
                        "because": "断言条数不同", "expected": len(base_as), "actual": len(cur_as)}
            for index, (a, b) in enumerate(zip(base_as, cur_as)):
                if bool(a.get("passed")) != bool(b.get("passed")):
                    return {"round": round_no, "plan": pid, "step": sid, "assertion": index,
                            "because": f"断言 #{index}（{a.get('type')}）结果不一致",
                            "expected": "passed" if a.get("passed") else "failed",
                            "actual": "passed" if b.get("passed") else "failed",
                            "detail": {"matcher": a.get("matcher"),
                                       "expected_value": a.get("expected"),
                                       "round1_actual": a.get("actual"),
                                       "current_actual": b.get("actual")}}
        # 步骤逐条都对得上，但 verdict 不同：典型来源是引擎内的一致性复跑
        # 判出了 flaky——这个信息必须单独说，否则会被当成"无法定位的抖动"
        return {"round": round_no, "plan": pid, "step": None, "assertion": None,
                "because": f"步骤结论一致但 verdict 不同：{base_ir.get('verdict')} → "
                           f"{cur_ir.get('verdict')}（通常来自一致性复跑判 flaky）",
                "expected": base_ir.get("verdict"), "actual": cur_ir.get("verdict")}
    return None


def replay(plans: Iterable[Mapping[str, Any]], *, base_url: str,
           data: Mapping[str, Any] | None = None, rounds: int = 5,
           run_dir: str | os.PathLike[str] | None = None,
           env_dir: str | os.PathLike[str] | None = None,
           baseline_config: Mapping[str, Any] | None = None,
           reference: Mapping[str, Any] | None = None,
           require_reference: bool = False,
           persist: bool = True,
           engine_factory: Any = None, authorization_for: Any = None,
           env_id: str | None = None) -> dict:
    """把一组计划连跑 `rounds` 轮，判定结论是否可复现。

    参数：
        plans            计划列表（api plan：lineage + session? + steps）
        base_url         被测根地址，计划里不落环境细节
        data             变量池初值（账号等），会被引擎在轮内写入
        run_dir          给了则每轮跑 preflight，并把 replay.json 落盘
        env_dir          环境基线目录（跨 run 共享）。不给则退回 run_dir——
                         给了它，下一个 run 换个 run_dir 也仍能读到参考基线，
                         否则每次都是"首次运行"，闸装上了也永远在放行
        baseline_config  给 preflight 的采集配置；None 表示不采基线。
                         计划顶层 `credentials: [...]`（引用形态，如 `${cred:orders-admin}`）
                         声明的凭据引用会在采集时自动并入 `credential_refs`——计划最清楚
                         这次要登录哪个账号，不该要求调用方记得转抄。但 None 仍是"不采"，
                         不会因计划声明了凭据就擅自开启；这种组合会在报告
                         `credentials.into_baseline=false` 里如实标出
        reference        显式参考基线（测试用），优先级高于 run_dir 里的
        require_reference True = 没有历史参考就拒绝开跑
        persist          首轮采集是否落盘成参考基线
        engine_factory   可注入的引擎构造器 `(base_url, data) -> engine`，
                         默认 ApiEngine。存在只为让"分歧检测"本身可被单测——
                         否则要造一个时好时坏的靶子，等于把确定性测试建立在不
                         确定的服务上。
        authorization_for 签发回调 `(plan) -> approval`。replay 只做搬运，不自己签发：
                         执行器自批自跑等于没有闸，签发方必须是调用方。
                         不给则引擎拿不到授权，含写动作的计划会被拒（这是对的）。
        env_id           授权绑定的环境标识，与 `authorization_for` 一起用。

    `deterministic=True` 只表示"这 N 轮结论一致"，不表示结论是 pass——一份稳定失败
    的用例同样 deterministic，那才是有用的失败。
    """
    if rounds < 2:
        raise ValueError("rounds 至少为 2：1 轮无法比较，只会产出一个看起来通过的假结论")
    plan_list = [dict(plan) for plan in plans]
    if not plan_list:
        raise ValueError("plans 为空：没有可重放的计划")
    make_engine = engine_factory or (lambda url, payload: ApiEngine(url, payload))

    ids = [_plan_id(plan, i) for i, plan in enumerate(plan_list)]
    duplicates = {pid for pid in ids if ids.count(pid) > 1}
    if duplicates:
        # 重名会让 per_round 的字典覆盖，分歧定位也会指错计划
        raise ValueError(f"计划 id 重复：{sorted(duplicates)}")

    directory = os.fspath(run_dir) if run_dir is not None else None
    env_dir_str = os.fspath(env_dir) if env_dir is not None else directory
    # 计划声明的凭据引用并入基线采集：**只在调用方本来就要求采基线时**。
    # baseline_config=None 是"这次不采基线"的明确决定，不因计划声明了凭据就擅自开启——
    # 那会让"有没有基线"取决于计划内容而不是调用方意图。
    declared_credentials = _declared_credentials(plan_list)
    if declared_credentials and baseline_config is not None:
        merged_refs = sorted({*declared_credentials,
                              *(str(r).strip() for r in (baseline_config.get("credential_refs") or [])
                                if str(r).strip())})
        baseline_config = {**baseline_config, "credential_refs": merged_refs}
    run_id = f"replay-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S')}-{uuid.uuid4().hex[:8]}"
    started_at = _utc_now()
    sdk_before = set(llm_sdk_present())
    per_round: list[dict] = []
    baseline_notes: list[dict] = []
    reference_now = reference
    first_baseline: dict | None = None

    for round_no in range(1, rounds + 1):
        pre = None
        if baseline_config is not None or directory is not None:
            pre = preflight(directory, reference_dir=env_dir, config=baseline_config,
                            reference=reference_now,
                            require_reference=require_reference, persist=persist)
            baseline_notes.append({
                "round": round_no, "status": pre["status"], "allow": pre["allow"],
                "prechecked": pre["prechecked"], "degraded": pre["degraded"],
                "hash": pre["baseline_hash"], "reasons": pre["reasons"],
                # 完整比对清单只在真的比对过时有意义；前几轮可能还没有参考
                "drift": (pre.get("comparison") or {}).get("drift") if pre["comparison"] else None,
            })
            if directory is not None and pre["allow"] and not pre["prechecked"]:
                # 首轮落盘后，后续轮次就该拿它当参考；否则会一直停在"无参考"
                reference_now = pre["baseline"] if reference_now is None else reference_now
            if first_baseline is None and pre["allow"] and pre.get("baseline"):
                first_baseline = pre["baseline"]
            if not pre["allow"]:
                return _write_report({
                    "type": "replay", "schema": REPLAY_SCHEMA, "run_id": run_id,
                    "deterministic": False, "aborted": True,
                    "abort_reason": "preflight_denied",
                    "baseline": {"preflight": pre, "per_round": baseline_notes,
                                 "degraded": pre["degraded"]},
                    "credentials": {"declared": declared_credentials,
                                    "into_baseline": bool(declared_credentials) and baseline_config is not None},
                    "plans": [{"id": pid} for pid in ids], "rounds_requested": rounds,
                    "rounds_done": 0, "per_round": [], "divergence": None,
                    "llm": {"calls": 0, "sdk_present": sorted(sdk_before),
                            "loaded_during": [], "guard": "not_run"},
                    "started_at": started_at, "finished_at": _utc_now(),
                }, directory)

        round_started = time.time()
        execs: dict[str, dict] = {}
        for pid, plan in zip(ids, plan_list):
            # 每份计划一个引擎实例：轮内隔离会话，但跨轮也隔离——见模块 docstring
            engine = make_engine(base_url, dict(data or {}))
            approval = authorization_for(plan) if authorization_for else _NO_APPROVAL
            try:
                if approval is _NO_APPROVAL:
                    execs[pid] = engine.run_plan(plan)
                else:
                    execs[pid] = engine.run_plan(plan, authorization=approval,
                                                 env_id=env_id)
            finally:
                # web 引擎持有一个浏览器 context（不开则泄漏，5 轮 x 3 计划就是 15 个），
                # api 引擎没有 close，getattr 兜住
                closer = getattr(engine, "close", None)
                if callable(closer):
                    try:
                        closer()
                    except Exception:
                        pass
        per_round.append({
            "round": round_no,
            "execs": execs,
            "outcome_keys": {pid: _outcome_key(ir) for pid, ir in execs.items()},
            "content_keys": {pid: _content_key(ir) for pid, ir in execs.items()},
            "verdicts": {pid: ir.get("verdict") for pid, ir in execs.items()},
            "elapsed_ms": int((time.time() - round_started) * 1000),
        })

    baseline_round = per_round[0]
    divergence = None
    for item in per_round[1:]:
        divergence = _divergence(baseline_round, item, item["round"])
        if divergence is not None:
            break

    content_stable = all(
        item["content_keys"] == baseline_round["content_keys"] for item in per_round[1:])

    sdk_after = set(llm_sdk_present())
    loaded_during = sorted(sdk_after - sdk_before)
    guard = "loaded_during_run" if loaded_during else "pass"

    degraded = baseline_notes[0]["degraded"] if baseline_notes else None
    _DEGRADED_NOTES = {
        "manual": "首轮没有参考基线：本次采集已就地落盘为参考，结论标 inconclusive (baseline=manual)",
        "no_baseline": "未配置基线采集：本次执行未经环境前置校验，结论不可与历史比较",
        "warnings": "基线存在 warning 级漂移（文件/凭据），结论可比但需留意",
        "version_unknown": "被测版本缺失：结论标 inconclusive，不当作通过",
    }
    report = {
        "type": "replay", "schema": REPLAY_SCHEMA, "run_id": run_id,
        "deterministic": divergence is None,
        "aborted": False,
        "divergence": divergence,
        "content_stable": content_stable,
        "plans": [{"id": pid, "version": (plan.get("lineage") or {}).get("version")}
                  for pid, plan in zip(ids, plan_list)],
        "rounds_requested": rounds,
        "rounds_done": len(per_round),
        "per_round": [{"round": item["round"], "verdicts": item["verdicts"],
                       "elapsed_ms": item["elapsed_ms"]} for item in per_round],
        "baseline": {"preflight": baseline_notes[-1] if baseline_notes else None,
                     "per_round": baseline_notes, "degraded": degraded,
                     "degraded_note": _DEGRADED_NOTES.get(degraded),
                     # 跟谁比的：跨 run 共享的环境基线目录
                     "env_dir": env_dir_str},
        # 计划声明的凭据引用。declared 非空而 into_baseline=False = 调用方没采基线——
        # 如实标出来，不冒充"已纳入轮换检测"。
        "credentials": {"declared": declared_credentials,
                        "into_baseline": bool(declared_credentials) and baseline_config is not None},
        "llm": {"calls": 0, "sdk_present": sorted(sdk_before),
                "loaded_during": loaded_during, "guard": guard},
        # 基线写回 run manifest：服务端只认 manifest，不认本地目录布局
        "manifest": attach_baseline(directory, first_baseline, source=env_dir_str),
        "started_at": started_at,
        "finished_at": _utc_now(),
    }
    return _write_report(report, directory)


def _write_report(report: dict, directory: str | None) -> dict:
    if directory is None:
        return report
    os.makedirs(directory, exist_ok=True)
    target = os.path.join(directory, REPLAY_FILE)
    with open(target, "w", encoding="utf-8") as handle:
        json.dump(report, handle, ensure_ascii=False, indent=2, sort_keys=True, default=str)
    report["report_path"] = target
    return report
