"""执行登记的执行侧验收（判据 1 排查线）。

被测对象是 `exec/run_trace.py`，平台端用内存实现顶替。要守的不是"能登记"，而是几条
**错了也不会立刻报错**的地方：

  1. 缺 manifest 时不能先登记——否则库里留一条永远 running 的假记录，把派发链路缺件
     伪装成"执行卡住"，比不登记更难查；
  2. run_id 不一致时一个请求都不能发——服务端按 facts 登记，对不上会凭空多一条 run；
  3. 执行抛错不补 finish——run 停在 running 等"疑似中断"判定，由人重跑，不写假结论；
  4. 同一个 run 不能登记两次（发起/结束各自幂等边界）；
  5. 同一会话的多个 run 并行共存——产品里没有排队。
"""
import glob
import hashlib
import json
import os
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from aitestharness_tools.exec.run_trace import (
    ManifestMissing,
    RunIdentityMismatch,
    RunTrace,
    RunTraceError,
    manifest_sha256,
    recorded_run,
)

USER = "u1"
PROJECT = "p1"


class PlatformState:
    """平台端的 run 登记表：发起即 running，结束才收敛。没有队列、没有领取。"""

    def __init__(self):
        self.lock = threading.Lock()
        self.runs: dict[str, dict] = {}
        self.starts = 0
        self.finishes = 0

    def start(self, session_id: str, payload: dict) -> tuple[int, dict]:
        with self.lock:
            run_id = payload.get("runId")
            if not run_id:
                return 400, {"error": "invalid_run"}
            if run_id in self.runs:
                return 409, {"error": "run_exists"}
            self.starts += 1
            self.runs[run_id] = {
                "runId": run_id,
                "sessionId": session_id,
                "status": "running",
                "dispatch": payload.get("dispatch") or {},
                "manifestPath": "",
                "manifestSha256": "",
                "counts": {},
            }
            return 201, {"run": dict(self.runs[run_id])}

    def finish(self, session_id: str, run_id: str, payload: dict) -> tuple[int, dict]:
        with self.lock:
            run = self.runs.get(run_id)
            if not run or run["sessionId"] != session_id:
                return 404, {"error": "run_not_found"}
            facts = payload.get("facts") or {}
            if facts.get("runId") != run_id:
                return 400, {"error": "run_mismatch"}
            if run["status"] != "running":
                return 409, {"error": "run_not_running"}
            self.finishes += 1
            run["manifestPath"] = payload.get("manifestPath", "")
            run["manifestSha256"] = payload.get("manifestSha256", "")
            run["counts"] = payload.get("counts") or {}
            run["status"] = facts.get("status") or run["status"]
            return 200, {"run": dict(run)}


class _Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    state: PlatformState = None  # type: ignore[assignment]

    def log_message(self, *args):
        return

    def _send(self, code: int, payload: dict | None) -> None:
        body = b"" if payload is None else json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        if body:
            self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        if body:
            self.wfile.write(body)

    def do_POST(self) -> None:                        # noqa: N802 - http.server 约定
        length = int(self.headers.get("content-length") or 0)
        payload = json.loads(self.rfile.read(length) or b"{}")
        path = self.path.split(f"/api/projects/{PROJECT}", 1)[-1]
        parts = [part for part in path.split("/") if part]
        if len(parts) >= 4 and parts[0] == "qa" and parts[1] == "task-records":
            session_id = parts[2]
            if len(parts) == 4 and parts[3] == "runs":
                return self._send(*self.state.start(session_id, payload))
            if len(parts) == 6 and parts[3] == "runs" and parts[5] == "finish":
                return self._send(*self.state.finish(session_id, parts[4], payload))
        return self._send(404, {"error": "no_route"})


class FakePlatform:
    def __init__(self):
        self.state = PlatformState()
        handler = type("_Bound", (_Handler,), {"state": self.state})
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    @property
    def base_url(self) -> str:
        return f"http://127.0.0.1:{self.server.server_address[1]}"

    def trace(self) -> RunTrace:
        return RunTrace(self.base_url, "tk", PROJECT)

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()


def _run_dir(run_id: str, *, manifest_run_id: str | None = None, with_manifest: bool = True) -> str:
    root = tempfile.mkdtemp(prefix=f"run-{run_id}-")
    if with_manifest:
        payload = {
            "run_id": manifest_run_id or run_id,
            "status": "completed",
            "manifest_version": 1,
            "resource_pool": "web",
            "baseline_hash": "sha256:baseline",
        }
        with open(os.path.join(root, "manifest.json"), "w", encoding="utf-8") as handle:
            json.dump(payload, handle)
    return root


def _ok_executor(run_dir):
    with open(os.path.join(run_dir, "exec-ir.json"), "w", encoding="utf-8") as handle:
        json.dump({"verdict": "pass"}, handle)
    return {"verdict": "pass"}


# ------------------------------------------------------------------ 用例
def test_start_then_finish_keeps_one_run_id():
    platform = FakePlatform()
    run_dir = _run_dir("run-1")
    try:
        summary = recorded_run(platform.trace(), session_id="s1", run_id="run-1", run_dir=run_dir,
                               executor=_ok_executor, dispatch={"plan": "plans/run-1.yaml"},
                               counts_from=lambda result: {"passed": 3})
        assert summary["run_id"] == "run-1", summary
        assert summary["started_status"] == "running", summary
        assert summary["verdict"] == "pass", summary
        assert summary["run_status"] == "completed", summary
        assert summary["counts"] == {"passed": 3}, summary
        run = platform.state.runs["run-1"]
        assert run["manifestPath"] == os.path.join(run_dir, "manifest.json"), run
        assert run["manifestSha256"] == manifest_sha256(os.path.join(run_dir, "manifest.json")), run
        assert platform.state.starts == 1 and platform.state.finishes == 1, platform.state
    finally:
        platform.close()


def test_missing_manifest_does_not_start():
    platform = FakePlatform()
    run_dir = _run_dir("run-1", with_manifest=False)
    try:
        calls = []
        try:
            recorded_run(platform.trace(), session_id="s1", run_id="run-1", run_dir=run_dir,
                         executor=lambda path: calls.append(path) or {"verdict": "pass"})
            raise AssertionError("应当抛 ManifestMissing")
        except ManifestMissing:
            pass
        assert calls == [], "没有 manifest 就不该执行"
        assert platform.state.starts == 0, "也不能先登记一条永远 running 的假记录"
        assert platform.state.runs == {}, platform.state.runs
    finally:
        platform.close()


def test_manifest_run_id_mismatch_sends_nothing():
    platform = FakePlatform()
    run_dir = _run_dir("run-1", manifest_run_id="run-other")
    try:
        try:
            recorded_run(platform.trace(), session_id="s1", run_id="run-1", run_dir=run_dir,
                         executor=_ok_executor)
            raise AssertionError("应当抛 RunIdentityMismatch")
        except RunIdentityMismatch:
            pass
        assert platform.state.starts == 0, platform.state.starts
        assert platform.state.finishes == 0, platform.state.finishes
        assert platform.state.runs == {}, platform.state.runs
    finally:
        platform.close()


def test_executor_error_leaves_run_running_without_fake_verdict():
    platform = FakePlatform()
    run_dir = _run_dir("run-1")
    try:
        def boom(path):
            raise ValueError("browser crashed")

        try:
            recorded_run(platform.trace(), session_id="s1", run_id="run-1", run_dir=run_dir, executor=boom)
            raise AssertionError("执行异常必须上抛")
        except ValueError:
            pass
        run = platform.state.runs["run-1"]
        assert run["status"] == "running", run
        assert run["counts"] == {}, "不能把'没跑起来'写成用例统计"
        assert platform.state.finishes == 0, platform.state.finishes
    finally:
        platform.close()


def test_repeat_start_and_repeat_finish_are_rejected():
    platform = FakePlatform()
    run_dir = _run_dir("run-1")
    try:
        trace = platform.trace()
        recorded_run(trace, session_id="s1", run_id="run-1", run_dir=run_dir, executor=_ok_executor)
        for action in (
            lambda: trace.start("s1", "run-1", dispatch={"plan": "again"}),
            lambda: trace.finish("s1", "run-1", facts={"runId": "run-1", "status": "completed"},
                                 manifest_path=os.path.join(run_dir, "manifest.json"),
                                 sha256=manifest_sha256(os.path.join(run_dir, "manifest.json"))),
        ):
            try:
                action()
                raise AssertionError("重复登记必须被拒")
            except RunTraceError as error:
                assert "409" in str(error), error
    finally:
        platform.close()


def test_fingerprint_is_taken_after_execution():
    platform = FakePlatform()
    run_dir = _run_dir("run-1")
    try:
        manifest_path = os.path.join(run_dir, "manifest.json")

        def mutate(path):
            with open(os.path.join(path, "manifest.json"), encoding="utf-8") as handle:
                data = json.load(handle)
            data["baseline_hash"] = "sha256:after-exec"
            with open(os.path.join(path, "manifest.json"), "w", encoding="utf-8") as handle:
                json.dump(data, handle)
            return {"verdict": "pass"}

        before = hashlib.sha256(open(manifest_path, "rb").read()).hexdigest()
        recorded_run(platform.trace(), session_id="s1", run_id="run-1", run_dir=run_dir, executor=mutate)
        after = platform.state.runs["run-1"]["manifestSha256"]
        assert after == manifest_sha256(manifest_path), after
        assert after != f"sha256:{before}", "指纹必须是执行后的 manifest，不是执行前的"
    finally:
        platform.close()


def test_parallel_sessions_do_not_block_each_other():
    platform = FakePlatform()
    dirs = {run: _run_dir(run) for run in ("run-1", "run-2", "run-3")}
    try:
        trace = platform.trace()
        for run_id in ("run-1", "run-2"):
            recorded_run(trace, session_id="s1", run_id=run_id, run_dir=dirs[run_id], executor=_ok_executor)
        trace.start("s2", "run-3", dispatch={"plan": "plans/run-3.yaml"})
        assert platform.state.runs["run-1"]["status"] == "completed"
        assert platform.state.runs["run-2"]["status"] == "completed"
        assert platform.state.runs["run-3"]["status"] == "running"
        assert platform.state.runs["run-3"]["sessionId"] == "s2"
        assert platform.state.starts == 3, platform.state.starts
    finally:
        platform.close()


if __name__ == "__main__":
    import traceback
    fails = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_"):
            try:
                fn()
                print(f"PASS {name}")
            except Exception as error:
                fails += 1
                print(f"FAIL {name}: {error}")
                traceback.print_exc()
    print("ALL PASS" if fails == 0 else f"{fails} FAILED")
    sys.exit(1 if fails else 0)
