"""把"这一次跑在什么环境上"写进 run manifest。

为什么由执行侧写，而不是服务端自己去找基线文件
----------------------------------------------
服务端不该知道 `output/environments/<env>/baseline.json` 这种本地目录约定——那是执行
侧的落盘布局，换一次布局就要改服务端。执行侧刚刚采过、也比对过基线，顺手写进
manifest；服务端继续只认 manifest 这一个真源（`readRunFacts` 就是从它派生
`baseline_hash` 的）。

两条不许含糊的规则
------------------
1. **没有 manifest 就不创建**。manifest 是 run 的身份，由 `create-run.mjs` 写；执行侧
   只在"已经存在"的 manifest 上追加事实。自己造一份会得到没有 directory_context、
   没有 run_id 的假 run，而它长得跟真的一模一样。
2. **已有 `baseline_hash` 且不同 → 不覆盖，记冲突**。两次执行读到不同基线，说明这中间
   环境变过，或者有人替换了环境基线目录。静默覆盖会让"哪一次到底跑在哪个环境上"永久
   丢失，而覆盖后的结果看起来完全正常——这是最坏的一种"看起来对"。
"""
from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from typing import Any, Mapping

__all__ = ["attach_baseline", "MANIFEST_FILE"]

MANIFEST_FILE = "manifest.json"


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _atomic_write(path: str, payload: str) -> None:
    temp = f"{path}.tmp-{os.getpid()}"
    with open(temp, "w", encoding="utf-8") as handle:
        handle.write(payload)
    os.replace(temp, path)


def attach_baseline(run_dir: str | os.PathLike[str] | None,
                    baseline: Mapping[str, Any] | None, *,
                    source: str | None = None) -> dict:
    """在已存在的 manifest 上记录本次基线。返回结果供调用方写进报告。

    返回 `{"attached": bool, "reason": str, ...}`；`attached=False` 不是错误，
    调用方只需如实记录，不该因此中断一次已经成功的执行。
    """
    if run_dir is None:
        return {"attached": False, "reason": "未指定 run_dir"}
    if not baseline:
        return {"attached": False, "reason": "没有基线可写（未采集或采集失败）"}
    content_hash = str(baseline.get("content_hash") or "")
    if len(content_hash) != 64:
        # 写半截事实比不写更糟：服务端会把一个校验不过的哈希当比较依据
        return {"attached": False, "reason": f"基线 content_hash 非法（{content_hash[:8]}…）"}

    path = os.path.join(os.fspath(run_dir), MANIFEST_FILE)
    if not os.path.exists(path):
        return {"attached": False, "reason": "run 目录下没有 manifest（不由执行侧创建）"}

    try:
        with open(path, encoding="utf-8") as handle:
            manifest = json.load(handle)
    except (OSError, ValueError) as error:
        return {"attached": False, "reason": f"manifest 不可读：{error}"}
    if not isinstance(manifest, dict):
        return {"attached": False, "reason": "manifest 不是对象"}

    existing = str(manifest.get("baseline_hash") or "")
    block = {
        "env": baseline.get("env"),
        "sut_version": baseline.get("sut_version"),
        "content_hash": content_hash,
        "collected_at": baseline.get("collected_at"),
        "source": source,
        "verified_at": _now(),
    }

    if existing == content_hash:
        # 已写过同一份基线：不重复写，但把 baseline 段补齐（老 manifest 可能只有 hash）
        if isinstance(manifest.get("baseline"), dict) and manifest["baseline"] == block:
            return {"attached": False, "reason": "基线未变化", "baseline_hash": content_hash}
        manifest.setdefault("baseline", block)
        _atomic_write(path, json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
        return {"attached": True, "reason": "补齐 baseline 段", "baseline_hash": content_hash}

    if existing:
        conflicts = manifest.get("baseline_conflicts")
        if not isinstance(conflicts, list):
            conflicts = []
        entry = {"previous_hash": existing, "incoming_hash": content_hash,
                 "incoming_env": baseline.get("env"),
                 "incoming_sut_version": baseline.get("sut_version"),
                 "recorded_at": _now()}
        if entry not in conflicts:
            conflicts.append(entry)
        manifest["baseline_conflicts"] = conflicts
        _atomic_write(path, json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
        return {"attached": False, "reason": "已有不同基线，保留原值并记录冲突",
                "baseline_hash": existing, "conflict": entry}

    manifest["baseline"] = block
    manifest["baseline_hash"] = content_hash
    # sut_version 只在缺失时补：manifest 里显式写的被测版本优先级高于基线采集值
    if not manifest.get("sut_version") and baseline.get("sut_version"):
        manifest["sut_version"] = baseline.get("sut_version")
    _atomic_write(path, json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    return {"attached": True, "reason": "已写入 baseline 与 baseline_hash",
            "baseline_hash": content_hash}
