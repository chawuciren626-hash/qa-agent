"""P4 切片验收：执行前置闸（preflight）+ N 轮确定性重放（replay）。

这些测试守的是三类"看起来对、实际错"的地方：

  1. **首次运行 vs 基线损坏**——都表现为"没有可用的参考基线"，但前者要放行并降级
     （否则第一个 run 永远跑不了），后者要拒绝（否则没人发现基线被改过）。
     把两者混成一个分支，是最省事也最危险的写法。
  2. **结论一致性 vs 内容一致性**——actual 值抖动（request-id、时间戳）不等于结论
     不可复现。混在一起判，会把"服务端返回了不同 trace id"报成"用例 flaky"，
     从此没人相信这套判定。
  3. **分歧要能定位**——只说"第 3 轮和第 1 轮不一致"等于没说；必须收窄到计划、
     步骤、断言，并给出两轮的 actual 值。

依赖：`tests/mock_service.py` 提供固定数据靶子；不依赖真实环境。
"""
import json
import os
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.dirname(__file__))

import yaml

from aitestharness_tools.exec.baseline import BASELINE_FILE, build_baseline, write_baseline
from aitestharness_tools.exec.preflight import (PRECHECK_STATUSES, preflight,
                                                verify_restored)
from aitestharness_tools.exec.replay import REPLAY_FILE, llm_sdk_present, replay
from mock_service import MockService

ROOT = os.path.join(os.path.dirname(__file__), "..")
FIXTURES = os.path.join(os.path.dirname(__file__), "fixtures", "replay")


def _baseline(**overrides):
    args = dict(
        sut_version="p4-mock-1.0",
        files={"tests/mock_service.py": {"sha256": "a1", "size": 10}},
        credential_refs=["qa-secret://p4-account@v1"],
    )
    args.update(overrides)
    return build_baseline("p4-mock", **args)


def _plans():
    plans = []
    for name in sorted(os.listdir(FIXTURES)):
        if name.endswith(".yaml"):
            with open(os.path.join(FIXTURES, name), encoding="utf-8") as handle:
                plans.append(yaml.safe_load(handle))
    return plans


def _baseline_config():
    """把 mock 服务自身当环境定义：靶子代码变了，等于被测环境变了。"""
    return {
        "env": "p4-mock",
        "sut_version": "p4-mock-1.0",
        "files": {
            "root": os.path.abspath(ROOT),
            "paths": ["tests/mock_service.py"],
            "critical": ["tests/mock_service.py"],
        },
    }


def _fake_exec(plan_id, *, broken=False, actual_value=200, observe_flip=False):
    """构造一份最小 exec IR，用于在不依赖网络的情况下测分歧检测。

    `observe_flip` 只翻 observe 断言（不影响 verdict、不影响 step status）——
    真实场景里它就对应"采集到的事实变了但结论没变"，是最难被察觉的一类漂移。
    """
    return {
        "type": "exec", "driver": "api", "halt": None,
        "plan": {"id": plan_id, "version": 1},
        "verdict": "fail" if broken else "pass",
        "steps": [
            {"index": 0, "action": "GET /a", "status": "pass", "duration_ms": 1,
             "extracted_keys": [], "assertions": [
                 {"index": 0, "type": "status_code", "matcher": "equals", "expected": "200",
                  "actual": 200, "decide": True, "passed": True}]},
            {"index": 1, "action": "GET /b", "status": "fail" if broken else "pass",
             "duration_ms": 1, "extracted_keys": [], "assertions": [
                 {"index": 0, "type": "status_code", "matcher": "equals", "expected": "200",
                  "actual": actual_value, "decide": True, "passed": not broken},
                 {"index": 1, "type": "json_path", "matcher": "contains", "expected": "ok",
                  "actual": "ok" if not observe_flip else "changed",
                  "decide": False, "passed": not observe_flip}]},
        ],
    }


class _FakeEngine:
    """按调用序号决定结果的假引擎：第 broken_from 次起第 1 步断言失败。"""

    def __init__(self, plan_id, counter, broken_from, actual_seq=None, observe_from=None):
        self.plan_id, self.counter = plan_id, counter
        self.broken_from = broken_from
        self.actual_seq = actual_seq
        self.observe_from = observe_from

    def run_plan(self, plan):
        self.counter["n"] += 1
        n = self.counter["n"]
        actual = 200
        if self.actual_seq:
            actual = self.actual_seq(n)
        return _fake_exec(self.plan_id, broken=(n >= self.broken_from),
                          actual_value=actual,
                          observe_flip=(self.observe_from is not None and n >= self.observe_from))


# --------------------------------------------------------------- 前置闸：四种出口

def test_first_run_degrades_to_manual_and_records():
    with tempfile.TemporaryDirectory() as directory:
        result = preflight(directory, current=_baseline())
        assert result["allow"] is True, "首次运行必须放行，否则第一个 run 永远跑不了"
        assert result["status"] == "baseline_missing"
        assert result["degraded"] == "manual"
        assert result["verdict"] == "inconclusive", "无参考基线时不许声称 pass"
        assert result["prechecked"] is False
        assert result["recorded"] is True
        assert os.path.isfile(os.path.join(directory, BASELINE_FILE)), "首轮必须就地落盘成参考"


def test_strict_mode_denies_without_reference():
    with tempfile.TemporaryDirectory() as directory:
        result = preflight(directory, current=_baseline(), require_reference=True)
        assert result["allow"] is False
        assert result["status"] == "baseline_missing", "严格模式没有历史参考就不许开跑"


def test_no_collection_is_not_prechecked():
    with tempfile.TemporaryDirectory() as directory:
        result = preflight(directory)
        assert result["allow"] is True, "没配采集不该拦住执行，但必须如实标注未校验"
        assert result["prechecked"] is False
        assert result["degraded"] == "no_baseline"


def test_blocking_version_drift_denies():
    result = preflight(None, reference=_baseline(sut_version="v1"),
                       current=_baseline(sut_version="v2"))
    assert result["allow"] is False
    assert result["status"] == "not_comparable"
    assert result["verdict"] == "invalid", "环境不可比不是产品失败，不能标 fail"


def test_warning_file_drift_allows_but_degrades():
    reference = _baseline(files={"a.txt": {"sha256": "x", "size": 1}})
    current = _baseline(files={"a.txt": {"sha256": "y", "size": 2}})
    result = preflight(None, reference=reference, current=current)
    assert result["allow"] is True, "非关键文件漂移不该阻断执行"
    assert result["degraded"] == "warnings"
    assert result["verdict"] == "pass"


def test_missing_version_is_inconclusive_but_allowed():
    result = preflight(None, reference=_baseline(sut_version=None),
                       current=_baseline(sut_version=None))
    assert result["allow"] is True, "缺版本不该让环境永远跑不了"
    assert result["verdict"] == "inconclusive", "但结论不能当 pass（G3）"
    assert result["degraded"] == "version_unknown"


def test_corrupt_baseline_denies_and_is_not_overwritten():
    with tempfile.TemporaryDirectory() as directory:
        target = os.path.join(directory, BASELINE_FILE)
        with open(target, "w", encoding="utf-8") as handle:
            handle.write('{"baseline_version": 99}')
        result = preflight(directory, current=_baseline())
        assert result["allow"] is False
        assert result["status"] == "baseline_corrupt"
        with open(target, encoding="utf-8") as handle:
            assert handle.read() == '{"baseline_version": 99}', \
                "损坏的基线一旦被覆盖，上一轮的环境就永久查不回来了"


def test_all_statuses_are_declared():
    """防将来加分支忘登记：返回的 status 必须都在 PRECHECK_STATUSES 里。"""
    seen = set()
    with tempfile.TemporaryDirectory() as directory:
        seen.add(preflight(directory, current=_baseline())["status"])
        seen.add(preflight(directory)["status"])
        seen.add(preflight(None, reference=_baseline(sut_version="v1"),
                           current=_baseline(sut_version="v2"))["status"])
        seen.add(preflight(None, reference=_baseline(sut_version=None),
                           current=_baseline(sut_version=None))["status"])
        seen.add(preflight(None, reference=_baseline(files={"a.txt": {"sha256": "x", "size": 1}}),
                           current=_baseline(files={"a.txt": {"sha256": "y", "size": 2}}))["status"])
    assert seen <= set(PRECHECK_STATUSES), f"未登记的状态：{seen - set(PRECHECK_STATUSES)}"


# --------------------------------------------------------------- 恢复自验（P3b-1 壳）

def test_verify_restored_true_when_identical():
    reference = _baseline()
    assert verify_restored(reference, _baseline())["restored"] is True


def test_verify_restored_false_on_drift():
    reference = _baseline()
    current = _baseline(files={"tests/mock_service.py": {"sha256": "b2", "size": 11}})
    result = verify_restored(reference, current)
    assert result["restored"] is False, "文件没还原回去就算没恢复干净"
    assert result["warning"] >= 1


def test_verify_restored_can_tolerate_warnings():
    reference = _baseline()
    current = _baseline(files={"tests/mock_service.py": {"sha256": "b2", "size": 11}})
    assert verify_restored(reference, current, tolerate_warnings=True)["restored"] is True


def test_verify_restored_false_when_missing():
    assert verify_restored(None, _baseline())["restored"] is False
    assert verify_restored(_baseline(), None)["restored"] is False


# --------------------------------------------------------------- 重放：真实靶子

def test_replay_five_rounds_deterministic():
    with MockService() as service, tempfile.TemporaryDirectory() as directory:
        report = replay(_plans(), base_url=service.base_url,
                        data={"username": "qa", "password": "qa-pass"},
                        rounds=5, run_dir=directory, baseline_config=_baseline_config())
        assert report["deterministic"] is True, f"5 轮结论不一致：{report['divergence']}"
        assert report["content_stable"] is True
        assert report["rounds_done"] == 5
        assert report["divergence"] is None
        assert report["baseline"]["degraded"] == "manual", "首轮无参考，降级必须如实标注"
        assert os.path.isfile(os.path.join(directory, REPLAY_FILE))
        assert os.path.isfile(os.path.join(directory, BASELINE_FILE))
        for item in report["per_round"]:
            assert set(item["verdicts"].values()) == {"pass"}, f"第 {item['round']} 轮有非 pass"


def test_replay_isolates_sessions_between_rounds():
    """未登录剧本必须每轮都 401：轮间若复用会话，第 2 轮起会带着上轮登录态。"""
    with MockService() as service:
        report = replay(_plans(), base_url=service.base_url,
                        data={"username": "qa", "password": "qa-pass"}, rounds=3)
        for item in report["per_round"]:
            assert item["verdicts"]["PLAN-P4-02"] == "pass", \
                f"第 {item['round']} 轮越权剧本失败：疑似会话跨轮残留"


def test_environment_baseline_spans_runs():
    """两个不同的 run 目录共用一个环境目录：第二个 run 必须能比对，而不是又判首次。

    这是前置闸能否真正落地的前提——基线描述的是**环境**，不是某一次运行。
    若基线只活在 run 目录里，每个新 run 都读不到上一个，闸就永远是"首次运行"。
    """
    data = {"username": "qa", "password": "qa-pass"}
    config = _baseline_config()
    with MockService() as service, tempfile.TemporaryDirectory() as env_dir, \
            tempfile.TemporaryDirectory() as run_a, tempfile.TemporaryDirectory() as run_b:
        first = replay(_plans(), base_url=service.base_url, data=data, rounds=2,
                       run_dir=run_a, env_dir=env_dir, baseline_config=config)
        assert first["baseline"]["degraded"] == "manual"
        assert os.path.isfile(os.path.join(env_dir, BASELINE_FILE)), "环境目录必须建立参考基线"

        second = replay(_plans(), base_url=service.base_url, data=data, rounds=2,
                        run_dir=run_b, env_dir=env_dir, baseline_config=config)
        assert second["baseline"]["preflight"]["status"] == "comparable", \
            "换了 run 目录仍应读到同一个环境基线"
        assert second["baseline"]["degraded"] is None
        assert second["baseline"]["preflight"]["prechecked"] is True

        assert os.path.isfile(os.path.join(run_a, BASELINE_FILE)), "每个 run 各自留采集证据"
        assert os.path.isfile(os.path.join(run_b, BASELINE_FILE))


def test_replay_aborts_when_environment_drifts():
    """合法但版本不同的基线 → 拒绝执行，一轮都不跑。"""
    with MockService() as service, tempfile.TemporaryDirectory() as directory:
        write_baseline(directory, build_baseline("p4-mock", sut_version="p4-mock-9.9"),
                       overwrite=True)
        report = replay(_plans(), base_url=service.base_url,
                        data={"username": "qa", "password": "qa-pass"}, rounds=3,
                        run_dir=directory, baseline_config=_baseline_config())
        assert report["aborted"] is True
        assert report["abort_reason"] == "preflight_denied"
        assert report["rounds_done"] == 0, "被拒绝时不许偷偷跑几轮再报错"
        assert report["baseline"]["preflight"]["status"] == "not_comparable"


# --------------------------------------------------------------- 重放：分歧检测

def test_replay_detects_divergence_at_step_level():
    counter = {"n": 0}
    report = replay([{"lineage": {"id": "PLAN-FAKE", "version": 1}}], base_url="http://fake",
                    rounds=3, engine_factory=lambda url, data: _FakeEngine("PLAN-FAKE", counter, 3))
    assert report["deterministic"] is False
    divergence = report["divergence"]
    assert divergence["plan"] == "PLAN-FAKE"
    assert divergence["step"] == "1", f"应定位到步骤而非只说计划级：{divergence}"
    assert divergence["round"] == 3
    assert "步骤状态不一致" in divergence["because"]
    assert divergence["expected"] == "pass" and divergence["actual"] == "fail"


def test_replay_localizes_assertion_level_divergence():
    """observe 断言翻了但 verdict 和步骤状态都没变——只能靠断言级定位发现。"""
    counter = {"n": 0}
    report = replay([{"lineage": {"id": "PLAN-FAKE", "version": 1}}], base_url="http://fake",
                    rounds=3, engine_factory=lambda url, data: _FakeEngine(
                        "PLAN-FAKE", counter, 99, observe_from=2))
    assert report["deterministic"] is False, "observe 断言也是结论的一部分，翻转必须被看见"
    divergence = report["divergence"]
    assert divergence["plan"] == "PLAN-FAKE"
    assert divergence["step"] == "1"
    assert divergence["assertion"] == 1, f"应定位到具体断言序号：{divergence}"
    assert divergence["detail"]["round1_actual"] == "ok"
    assert divergence["detail"]["current_actual"] == "changed"


def test_replay_separates_content_drift_from_outcome_drift():
    """actual 每轮都变、但断言都过 → 结论仍确定性，只是内容不稳。"""
    counter = {"n": 0}
    report = replay([{"lineage": {"id": "PLAN-FAKE", "version": 1}}], base_url="http://fake",
                    rounds=3, engine_factory=lambda url, data: _FakeEngine(
                        "PLAN-FAKE", counter, 99, actual_seq=lambda n: 200 + n))
    assert report["deterministic"] is True, "actual 抖动不该被判成不可复现"
    assert report["content_stable"] is False, "但内容抖动必须被看见"


def test_replay_rejects_single_round():
    try:
        replay([{"lineage": {"id": "X"}}], base_url="http://fake", rounds=1)
    except ValueError as error:
        assert "至少为 2" in str(error)
    else:
        raise AssertionError("1 轮必须被拒绝：它只会产出一个看起来通过的假结论")


def test_replay_rejects_duplicate_plan_ids():
    plans = [{"lineage": {"id": "DUP"}}, {"lineage": {"id": "DUP"}}]
    try:
        replay(plans, base_url="http://fake", rounds=2)
    except ValueError as error:
        assert "重复" in str(error)
    else:
        raise AssertionError("重名计划必须被拒绝，否则分歧会指错计划")


def test_replay_llm_guard_records_zero_calls():
    with MockService() as service:
        report = replay(_plans(), base_url=service.base_url,
                        data={"username": "qa", "password": "qa-pass"}, rounds=2)
        guard = report["llm"]
        assert guard["calls"] == 0
        assert guard["loaded_during"] == [], f"重放期间加载了模型 SDK：{guard['loaded_during']}"
        assert guard["guard"] == "pass"
    assert "api_engine" not in llm_sdk_present()


# --------------------------------------------------------------- 引擎：变量传递

def test_extract_carries_order_id_into_next_path():
    """剧本 03 的最后一步路径必须带上一步提取的 order_id，否则串值链是断的。"""
    from aitestharness_tools.exec.api_engine import ApiEngine
    plan = [p for p in _plans() if p["lineage"]["id"] == "PLAN-P4-03"][0]
    with MockService() as service:
        engine = ApiEngine(service.base_url, {"username": "qa", "password": "qa-pass"})
        result = engine.run_plan(plan)
        assert result["verdict"] == "pass"
        assert result["steps"][-1]["action"].endswith("/2001"), \
            f"最后一步路径没有解析出订单号：{result['steps'][-1]['action']}"
        assert engine.data["order_id"] == 2001


if __name__ == "__main__":
    fails = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_"):
            try:
                fn()
                print(f"PASS {name}")
            except Exception as error:
                fails += 1
                import traceback
                print(f"FAIL {name}: {error}")
                traceback.print_exc()
    print("ALL PASS" if fails == 0 else f"{fails} FAILED")
    sys.exit(1 if fails else 0)
