"""地图版本（P6/G9）：地图变了要能判出来，但不能把地图变化当成环境坏了。

为什么单独一路而不是并进 baseline 的 `files` 段：
    - 语义不同。`files` 段比的是"环境指纹"——它变了意味着这次执行的前提不成立；
      地图是**资产版本**，它变了只说明"按旧地图写的计划可能过期"，执行本身照跑。
      混在一起，要么地图变化被误判成 blocking（每次页面改版就黄一片），要么把环境
      漂移降级成 warning（更糟）。两条路都会让人学会忽略告警。
    - 判定点不同。环境指纹每次执行前都比；地图只在**两个检查点**判：plan 固化点
      与执行前置。不在每次读地图时算 hash——那既贵，也会误伤正在跑的任务。

三个状态而不是布尔：
    same      快照与当前一致，plan 没过期
    different 地图变了，按旧地图写的计划要复核（**不阻塞**执行，只是标记）
    unknown   没有快照或读不到文件。这一条必须单独存在：把"不知道"归进 same 是
              最危险的一种通过——它让"从没登记过地图版本"看起来像"地图没变过"。
"""
from __future__ import annotations

import hashlib
import os

__all__ = ["MAPS_STATUSES", "maps_fingerprint", "compare_maps", "attach_maps"]

MAPS_STATUSES = ("same", "different", "unknown")

MANIFEST_MAPS_KEY = "maps"


def maps_fingerprint(path: str | os.PathLike[str] | None) -> str | None:
    """地图文件内容的 sha256；文件不存在或读不出来返回 None（不是空串）。

    用内容而不是 mtime：重新探索一次但地图没变，不该让所有 plan 变 stale。
    """
    if not path:
        return None
    try:
        hasher = hashlib.sha256()
        with open(os.fspath(path), "rb") as handle:
            for chunk in iter(lambda: handle.read(65536), b""):
                hasher.update(chunk)
        return hasher.hexdigest()
    except OSError:
        return None


def compare_maps(reference: str | None, current: str | None) -> dict:
    """比对快照与当前地图版本。

    `reference`/`current` 都可能为 None（没登记过 / 读不到），两者都按 unknown 处理，
    并且分别说清是哪一侧缺——"没有快照"和"地图文件没了"是两种不同的处置。
    """
    if reference is None and current is None:
        status, reason = "unknown", "没有地图快照，且当前地图读不到；无法判断计划是否过期"
    elif reference is None:
        status, reason = "unknown", "没有地图快照（首次登记）；本次的 hash 可作为下次的参考"
    elif current is None:
        status, reason = "unknown", "地图文件读不到，无法与快照比对"
    elif reference == current:
        status, reason = "same", "地图版本与快照一致"
    else:
        status, reason = "different", "地图已变更；按旧地图固化的计划需要复核（不阻塞执行）"
    return {
        "status": status,
        # 明确给两边的值：报告上要能说清"跟哪一版比的"，而不是只说"不一致"
        "reference": reference,
        "current": current,
        "reason": reason,
        # different 不阻塞：调用方据此标记 plan 待复核，而不是拒绝执行
        "blocking": False,
    }


def attach_maps(run_dir: str | os.PathLike[str] | None, maps: dict,
                *, manifest_name: str = "manifest.json") -> dict:
    """把本次地图版本写进 run manifest。

    `maps` 是 `compare_maps` 的结果（或至少含 `current`）。已有不同值时**不覆盖**，
    记 `conflict`——同一次 run 里读到两版地图说明探索与执行在交叉进行，
    这时"哪个是这轮用的"必须让人看见，而不是让后写的赢。
    """
    import json

    if run_dir is None:
        return {"attached": False, "reason": "缺少 run_dir"}
    path = os.path.join(os.fspath(run_dir), manifest_name)
    try:
        with open(path, "r", encoding="utf-8") as handle:
            manifest = json.load(handle)
    except (OSError, ValueError) as error:
        return {"attached": False, "reason": f"manifest 读取失败：{error}"}

    incoming = maps.get("current")
    existing = (manifest.get(MANIFEST_MAPS_KEY) or {}).get("hash")
    if existing and incoming and existing != incoming:
        entry = {"status": "conflict", "existing": existing, "incoming": incoming}
        manifest.setdefault(MANIFEST_MAPS_KEY, {})["conflict"] = entry
        with open(path, "w", encoding="utf-8") as handle:
            json.dump(manifest, handle, ensure_ascii=False, indent=2)
        return {"attached": False, "reason": "run 内已记有不同地图版本", "conflict": entry}

    manifest[MANIFEST_MAPS_KEY] = {
        "hash": incoming,
        "status": maps.get("status"),
        "reference": maps.get("reference"),
        "at": maps.get("at"),
    }
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(manifest, handle, ensure_ascii=False, indent=2)
    return {"attached": True, "hash": incoming}
