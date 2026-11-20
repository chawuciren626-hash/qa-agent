"""真实系统 5 轮确定性重放（只填不提交，因此天然幂等）。

每轮新建 context 并复用同一份 storageState：会话一致、页面状态干净，
差别只剩"服务端返回是否稳定"——这正是要测的东西。

不接基线采集：真实系统的 DB 与文件指纹不在本机可达范围，
接一个假的基线比没有基线更危险（会让 comparability 显示成"可比"）。
"""
from __future__ import annotations

import json
import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

import yaml

from aitestharness_tools.exec.replay import replay
from aitestharness_tools.exec.web_driver import BrowserHost
from aitestharness_tools.exec.web_engine import WebEngine

BASE = os.environ.get("AITH_SUT_BASE", "https://local.console.gov-bid.com").rstrip("/")
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
PLAN = os.path.join(ROOT, "tests", "fixtures", "real", "plan-bbiao-user-add.yaml")
OUT = os.path.abspath(os.path.join(ROOT, "..", "output", "probe-bbiao-20261119"))
STATE_JSON = os.path.join(OUT, "session-state.json")
RUN_DIR = os.path.abspath(os.path.join(ROOT, "..", "output", "runs", "real-bbiao-20261119"))


def main() -> int:
    if not os.path.exists(STATE_JSON):
        print("NO_SESSION", flush=True)
        return 2
    os.makedirs(RUN_DIR, exist_ok=True)
    plan = yaml.safe_load(open(PLAN, encoding="utf-8"))

    with BrowserHost() as host:
        factory = lambda url, data: WebEngine(host.new_driver(url, storage_state=STATE_JSON), data)
        report = replay([plan], base_url=BASE, data={}, rounds=5,
                        run_dir=RUN_DIR, engine_factory=factory)

    print("deterministic =", report["deterministic"])
    print("content_stable =", report["content_stable"])
    print("rounds_done =", report["rounds_done"], "| aborted =", report["aborted"])
    print("divergence =", json.dumps(report.get("divergence"), ensure_ascii=False))
    print("llm =", json.dumps(report["llm"], ensure_ascii=False))
    for rnd in report["per_round"]:
        print(f"  round {rnd['round']}: verdicts={rnd['verdicts']} elapsed={rnd['elapsed_ms']}ms")
    print("run files:", sorted(os.listdir(RUN_DIR)))

    with open(os.path.join(OUT, "replay-real.json"), "w", encoding="utf-8") as handle:
        json.dump(report, handle, ensure_ascii=False, indent=2)
    return 0 if report["deterministic"] else 3


if __name__ == "__main__":
    raise SystemExit(main())
