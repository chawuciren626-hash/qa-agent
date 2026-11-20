"""执行前置闸（P4 切片一）：把环境基线接到执行入口，而不是只躺在 run 目录里。

为什么要有这一层
----------------
P3a 做完基线采集与比对后，它只是一份"事后能看"的产物：执行照跑，漂移照旧，
谁也拦不住。可比性链要真的成立，基线必须站在**执行之前**当一个闸：

    collect → compare(参考基线) → allow / deny → 才轮到第一个剧本

闸的三个出口（缺一个就会退化成"总是放行"或"总是拦住"）：

  1. **拒绝**：存在 blocking 漂移（被测版本变了 / mock 定义变了 / 关键表结构变了）。
     此时跑出来的结论与历史不可比，跑了也是浪费资源，还会产出一批"看起来像回归
     的新失败"。这一步判 `verdict=invalid`——注意不是 `fail`，被测系统没坏。
  2. **放行但降级**：只有 warning（fixture 文件变了、凭据轮换了），或者根本还没有
     参考基线（首次运行）。放行，但结论要标 `inconclusive`，不许冒充 pass。
  3. **放行且可比**：无漂移或仅 info，判 `pass`。

首次运行为什么要"降级放行"而不是"拒绝"
------------------------------------
拒绝会让第一个 run 永远跑不了（没有参考基线 → 拒绝 → 更不会有基线）。所以首次
运行的做法是：把本次采集**就地落盘成参考基线**，然后把这个 run 标成
`inconclusive (baseline=manual)`——它的结论单看有效，但不能声称"与上次一致"。
这正是 §8.2 判据 2 在 P3b（环境恢复）未就位时的降级路径，二者是同一件事。

`verify_restored` 是这层的镜像
------------------------------
前置闸问"开跑前环境是否还是基线"，`verify_restored` 问"恢复后环境是否真的回到了
基线"。后者是 P3b-1 的壳：**恢复成功与否不能被测系统自报**（脚本 return 0 不代表
数据回到了基线），必须用同一套指纹反验。两个方向共用 P3a 的比对函数，所以放在
同一个文件里，避免将来各写一套判定。
"""
from __future__ import annotations

import os
from typing import Any, Mapping

from .maps import compare_maps, maps_fingerprint
from .baseline import (BASELINE_FILE, collect_baseline, compare_baseline,
                       read_baseline, verdict, write_baseline)

__all__ = ["preflight", "verify_restored", "PRECHECK_STATUSES"]

# preflight 能返回的状态集合，便于调用方穷举（不做真假值判断）
PRECHECK_STATUSES = (
    "comparable", "comparable_with_warnings",
    "inconclusive", "not_comparable", "baseline_missing", "baseline_corrupt",
)


def _result(*, allow: bool, status: str, prechecked: bool, degraded: str | None,
            exec_verdict: str, reasons: list[str], baseline: Mapping[str, Any] | None,
            comparison: Mapping[str, Any] | None, recorded: bool,
            run_dir: str | None, env_dir: str | None = None,
            maps: Mapping[str, Any] | None = None) -> dict:
    return {
        "allow": allow,
        "status": status,
        # 是否真的拿参考基线比对过：False 表示这次"放行"没带任何校验，
        # 报告层必须据此把结论标成未验证，不能因为 allow=True 就当环境没问题
        "prechecked": prechecked,
        "degraded": degraded,
        # 给执行结论用的标签：pass / invalid（环境不可比，不算产品失败）/ inconclusive
        "verdict": exec_verdict,
        "reasons": reasons,
        "baseline_hash": (baseline or {}).get("content_hash"),
        # 原样带回本次采集的基线对象：调用方（如 replay）要拿它当下一轮的参考，
        # 不然每轮都会重新落一次"首次运行"，degraded 永远停在 manual
        "baseline": dict(baseline) if baseline is not None else None,
        "comparison": comparison,
        "recorded": recorded,
        "run_dir": run_dir,
        # 参考基线所在目录：报告里要能说清"跟谁比的"，而不是只说"比对通过"
        "env_dir": env_dir,
        # 地图版本（P6/G9）。与 baseline 分开一路：地图是资产版本，不是环境指纹，
        # 它变了不代表这次执行的前提不成立（见 exec/maps.py 的说明）
        "maps": dict(maps) if maps is not None else None,
    }


def preflight(run_dir: str | os.PathLike[str] | None = None, *,
              reference_dir: str | os.PathLike[str] | None = None,
              config: Mapping[str, Any] | None = None,
              reference: Mapping[str, Any] | None = None,
              current: Mapping[str, Any] | None = None,
              require_reference: bool = False,
              persist: bool = True,
              maps: Mapping[str, Any] | None = None) -> dict:
    """执行前校验环境是否仍是参考基线。

    参数（都是"给什么用什么"，本函数不猜）：
        run_dir           本次 run 目录；本次采集的**证据**落这里
        reference_dir     环境基线目录（跨 run 共享），参考基线从这里读写。
                          不给则退回 run_dir（单目录用法）。
                          **为什么必须能分开**：基线描述的是环境，不是某一次运行。
                          只放在 `runs/<id>/` 下，下一个 run 换目录就读不到，
                          每次都判"首次运行"——闸看起来装上了，其实永远在放行。
        config            采集配置，透传给 `collect_baseline`；None 表示不采集
        reference         显式参考基线，优先级最高
        current           显式本次基线，给了就不再采集（测试用）
        require_reference True = 没有历史参考就拒绝执行（严格回归场景）
        persist           首次运行是否把本次基线落盘成参考
        maps              {"path": 当前地图文件, "reference": 快照 hash}；不给就是没接这条路
                          （返回 maps=None，与"地图没变"的 same 不是一回事）

    返回见 `_result`。`allow=False` 时调用方**不应执行**任何剧本。
    """
    directory = os.fspath(run_dir) if run_dir is not None else None
    env_dir = os.fspath(reference_dir) if reference_dir is not None else directory
    reasons: list[str] = []
    corrupt: str | None = None

    # 地图版本只在这里算一次（执行前置检查点）。`maps` 没给就等于没接这条路，
    # 而不是"地图没变"——两种情况的返回分别是 None 与 same/different/unknown。
    maps_result: dict | None = None
    if maps is not None:
        maps_result = compare_maps(maps.get("reference"), maps_fingerprint(maps.get("path")))

    if reference is None and env_dir is not None:
        try:
            reference = read_baseline(env_dir)      # 文件不存在 → None，不是错误
        except ValueError as error:
            # 文件在、但读不出来（被手改/截断）：**不能**当作"首次运行"放过去。
            # "首次运行"的判据是目录里没有基线，不是"有基线但坏了"——
            # 后者的正确处理是拒绝执行：既不能比，也不该假装没写过基线。
            corrupt = str(error)
            reasons.append(f"已有基线不可读，拒绝执行：{corrupt}")

    if corrupt is not None:
        # 早退：不采集、不落盘、不比对。损坏的基线一旦被新基线覆盖，
        # "上一轮到底是什么环境"就永久失去了，比拒绝执行严重得多。
        return _result(
            allow=False, status="baseline_corrupt", prechecked=False, degraded=None,
            exec_verdict="invalid", reasons=reasons, baseline=None,
            comparison=None, recorded=False, run_dir=directory, env_dir=env_dir, maps=maps_result)

    if current is None and config is not None:
        # 采集失败会直接抛（见 baseline.collect_baseline 的说明）：
        # 一份"什么都没采到"的基线比没有基线更危险，这里不做降级
        current = collect_baseline(config)

    recorded = False
    if current is not None:
        # 参考基线（环境级）：没有就建立。这是下一个 run 能读到的唯一来源。
        if reference is None and persist and env_dir is not None:
            try:
                write_baseline(env_dir, current)
                recorded = True
            except ValueError as error:
                # 环境目录里已有内容不同的基线（并发或人工放入）：以盘上的为准，
                # 本次不覆盖——否则"参考基线"就成了谁最后写谁说了算
                reasons.append(f"本次基线未落盘，改用环境目录已有的：{error}")
                try:
                    reference = read_baseline(env_dir)
                except ValueError:
                    reference = None
        # 证据（run 级）：这次采集看到的是什么。已有就不动，历史 run 的证据不覆盖。
        if (directory is not None and directory != env_dir
                and not os.path.isfile(os.path.join(directory, BASELINE_FILE))):
            try:
                write_baseline(directory, current)
            except ValueError:
                # 证据写不进去不影响判定，也不该让执行失败
                reasons.append("本次采集未能落为 run 证据（目录内已有不同基线）")

    if current is None:
        return _result(
            allow=not require_reference, status="baseline_missing", prechecked=False,
            degraded="no_baseline", exec_verdict="inconclusive",
            reasons=reasons + ["未提供采集配置，本次执行未经环境前置校验"],
            baseline=None, comparison=None, recorded=False, run_dir=directory, env_dir=env_dir, maps=maps_result)

    if reference is None:
        return _result(
            allow=not require_reference, status="baseline_missing", prechecked=False,
            degraded="manual", exec_verdict="inconclusive",
            reasons=reasons + [
                "无参考基线（首次运行）：本次采集已作为参考基线"
                + ("落盘" if recorded else "记录在返回值中")
                + "，结论标 inconclusive (baseline=manual)，不冒充与历史一致"
            ],
            baseline=current, comparison=None, recorded=recorded, run_dir=directory, env_dir=env_dir, maps=maps_result)

    checked = verdict(reference, current)
    status = checked["status"]
    comparison = checked.get("comparison")
    if status == "not_comparable":
        return _result(
            allow=False, status=status, prechecked=True, degraded=None,
            exec_verdict="invalid",
            reasons=reasons + checked["reasons"] + ["存在 blocking 漂移，执行已拒绝"],
            baseline=current, comparison=comparison, recorded=recorded, run_dir=directory, env_dir=env_dir, maps=maps_result)
    if status == "inconclusive":
        # 版本缺失等：不阻断执行（否则缺 sut_version 的环境永远跑不了），
        # 但结论不许当 pass——G3 的要求就落在这里
        return _result(
            allow=True, status=status, prechecked=True, degraded="version_unknown",
            exec_verdict="inconclusive",
            reasons=reasons + checked["reasons"],
            baseline=current, comparison=comparison, recorded=recorded, run_dir=directory, env_dir=env_dir, maps=maps_result)
    if status == "comparable_with_warnings":
        return _result(
            allow=True, status=status, prechecked=True, degraded="warnings",
            exec_verdict="pass", reasons=reasons + checked["reasons"],
            baseline=current, comparison=comparison, recorded=recorded, run_dir=directory, env_dir=env_dir, maps=maps_result)
    return _result(
        allow=True, status=status, prechecked=True, degraded=None,
        exec_verdict="pass", reasons=reasons,
        baseline=current, comparison=comparison, recorded=recorded, run_dir=directory, env_dir=env_dir, maps=maps_result)


def verify_restored(reference: Mapping[str, Any] | None,
                    current: Mapping[str, Any] | None,
                    *, tolerate_warnings: bool = False) -> dict:
    """恢复自验（P3b-1 的壳）：环境是否真的回到了参考基线。

    为什么必须反验而不是信被测系统的返回码：`restore.sh` 返回 0 只说明"它跑完了"，
    可能只恢复了部分表、可能 mock 没重置、可能恢复了旧版本。用同一套指纹比一次，
    才知道"回到基线"是事实还是自述。

    `tolerate_warnings=False` 时 warning 也算未恢复：fixture 文件内容变了，说明恢复
    脚本没把它还原回去，此时重跑出来的结论同样不可比——宁可判未恢复，也不要放过。
    """
    if reference is None or current is None:
        missing = "参考基线" if reference is None else "当前采集"
        return {"restored": False, "blocking": None, "warning": None, "drift": [],
                "because": f"{missing}缺失，无法判断是否已恢复", "summary": None}
    comparison = compare_baseline(reference, current)
    summary = comparison["summary"]
    noise = 0 if tolerate_warnings else summary["warning"]
    restored = summary["blocking"] == 0 and noise == 0
    return {
        "restored": restored,
        "blocking": summary["blocking"],
        "warning": summary["warning"],
        "drift": comparison["drift"],
        "reference_hash": comparison["reference_hash"],
        "current_hash": comparison["current_hash"],
        "because": ("已回到基线" if restored else
                    "与基线仍不一致：恢复未完成或恢复了错误版本"),
    }
