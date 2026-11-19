"""P6/G9 地图版本：判得出变化，且"不知道"不被当成"没变"。

四个断言各自挡一种静默失败：
  1. 用内容而不是 mtime（重建一次但内容没变，不该让所有 plan 变 stale）；
  2. different 不阻塞（地图是资产版本，不是环境指纹——阻塞会让人学会忽略告警）；
  3. unknown 与 same 分开（把"没登记过"归进 same，是最危险的通过）；
  4. run 内出现两版地图时记冲突而不是后写的赢。
"""
import json
import os
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from aitestharness_tools.exec.maps import (  # noqa: E402
    MAPS_STATUSES, attach_maps, compare_maps, maps_fingerprint)


def _write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(text)


def test_fingerprint_uses_content_not_mtime():
    with tempfile.TemporaryDirectory() as base:
        path = os.path.join(base, "maps.json")
        _write(path, '{"pages":["a"]}')
        first = maps_fingerprint(path)
        assert first and len(first) == 64
        # 触碰 mtime，内容不变 → hash 必须不变（否则每次探索都会让所有 plan 变 stale）
        future = time.time() + 3600
        os.utime(path, (future, future))
        assert maps_fingerprint(path) == first


def test_fingerprint_missing_file_is_none():
    assert maps_fingerprint(None) is None
    assert maps_fingerprint("/nonexistent/maps.json") is None


def test_compare_states_are_distinct():
    a, b = "a" * 64, "b" * 64
    same = compare_maps(a, a)
    assert same["status"] == "same" and same["blocking"] is False
    diff = compare_maps(a, b)
    assert diff["status"] == "different"
    # 地图变了不等于环境坏了：绝不能 blocking
    assert diff["blocking"] is False
    assert diff["reference"] == a and diff["current"] == b
    # "不知道"必须自成一档，不能与 same 合并
    assert compare_maps(None, None)["status"] == "unknown"
    assert compare_maps(None, b)["status"] == "unknown"
    assert compare_maps(a, None)["status"] == "unknown"
    assert set(MAPS_STATUSES) == {"same", "different", "unknown"}


def test_unknown_reasons_name_the_missing_side():
    assert "快照" in compare_maps(None, "b" * 64)["reason"]
    assert "读不到" in compare_maps("a" * 64, None)["reason"]


def test_one_byte_change_is_different():
    """阴性对照：如果只比大小或只比路径，这条会过。"""
    with tempfile.TemporaryDirectory() as base:
        path = os.path.join(base, "maps.json")
        _write(path, '{"pages":["a"]}')
        before = maps_fingerprint(path)
        _write(path, '{"pages":["b"]}')
        after = maps_fingerprint(path)
        assert before != after
        assert compare_maps(before, after)["status"] == "different"


def test_attach_writes_manifest_and_refuses_conflict():
    with tempfile.TemporaryDirectory() as base:
        manifest = os.path.join(base, "manifest.json")
        _write(manifest, json.dumps({"run_id": "run-x", "stages": {}}))
        first = attach_maps(base, {"current": "a" * 64, "status": "same", "reference": "a" * 64, "at": "2026-11-19T00:00:00Z"})
        assert first["attached"] is True
        stored = json.load(open(manifest, encoding="utf-8"))
        assert stored["maps"]["hash"] == "a" * 64
        # 同值再写：覆盖成同值，不算冲突
        assert attach_maps(base, {"current": "a" * 64, "status": "same"})["attached"] is True
        # 不同值：不覆盖，记冲突（同一次 run 读到两版地图必须让人看见）
        second = attach_maps(base, {"current": "b" * 64, "status": "different"})
        assert second["attached"] is False
        assert second["conflict"]["existing"] == "a" * 64
        assert json.load(open(manifest, encoding="utf-8"))["maps"]["hash"] == "a" * 64


def test_attach_without_run_dir_is_reported():
    assert attach_maps(None, {"current": "a" * 64})["attached"] is False


def test_preflight_reports_maps_without_changing_allow():
    """地图变化是"计划待复核"，不是"执行不许可"：allow 必须不受影响。"""
    from aitestharness_tools.exec.preflight import preflight
    with tempfile.TemporaryDirectory() as base:
        path = os.path.join(base, "maps.json")
        _write(path, '{"pages":["a"]}')
        current = maps_fingerprint(path)
        same = preflight(None, maps={"path": path, "reference": current})
        assert same["maps"]["status"] == "same"
        changed = preflight(None, maps={"path": path, "reference": "0" * 64})
        assert changed["maps"]["status"] == "different"
        # 关键：different 不阻塞执行，也不改变 allow
        assert changed["maps"]["blocking"] is False
        assert changed["allow"] == same["allow"]
        # 不接这条路时 maps=None，与 same 区分开（"没接"不等于"没变"）
        assert preflight(None)["maps"] is None


def test_preflight_maps_survives_corrupt_baseline():
    """基线损坏会早退拒绝执行，但地图信息仍应带上——报告要能说清当时的地图版本。"""
    from aitestharness_tools.exec.preflight import preflight
    with tempfile.TemporaryDirectory() as base:
        _write(os.path.join(base, "baseline.json"), "{ broken")
        path = os.path.join(base, "maps.json")
        _write(path, '{"pages":["a"]}')
        result = preflight(base, maps={"path": path, "reference": None})
        assert result["status"] == "baseline_corrupt"
        assert result["maps"]["status"] == "unknown"
        assert result["maps"]["current"] == maps_fingerprint(path)


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print("PASS", name)
    print("ALL PASS")
