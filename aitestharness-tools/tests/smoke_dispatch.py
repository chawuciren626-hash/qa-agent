"""派发队列的执行侧验收（判据 1 执行侧）。

被测对象是 `exec/dispatch.py` 这个消费端，平台端用内存实现顶替（固定状态、可注入
过期租约）。要守的不是"能领能交"，而是几条**错了也不会立刻报错**的地方：

  1. 同一条 run 不能被两个执行器领走——双领等于副作用跑两遍，而平台里只有一条记录；
  2. 交回的 run_id 必须与领到的一致——不一致时平台会按 facts 另登记一条，派发的那条
     永远卡在 running，而看板显示"从未执行"；
  3. 缺 manifest 不是执行失败——交回队列并留下原因，别把派发链路的缺件写成产品缺陷；
  4. 执行抛错也不伪造结论——交回原因带异常类型，由平台按 attempts 观察；
  5. 交回之后再交一次必须被拒——同一次执行只能有一份结论。
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

from aitestharness_tools.exec.dispatch import (
    DispatchError,
    ManifestMissing,
    PlatformQueue,
    RunIdentityMismatch,
    consume_once,
    manifest_sha256,
)

USER = "u1"
PROJECT = "p1"


# ---------------------------------------------------------------- 平台替身
class QueueState:
    def __init__(self):
        self.lock = threading.Lock()
        self.runs: dict[str, dict] = {}

    def enqueue(self, run_id: str, *, run_dir: str, kind: str = "execution") -> dict:
        with self.lock:
            if run_id in self.runs:
                raise AssertionError(f"repeat enqueue is a test bug: {run_id}")
            self.runs[run_id] = {
                "runId": run_id,
                "status": "queued",
                "kind": kind,
                "runIndex": len(self.runs) + 1,
                "dispatch": {"run_dir": run_dir},
                "claimedBy": None,
                "leaseUntil": None,
                "manifestPath": "",
                "manifestSha256": "",
                "counts": {},
            }
            return dict(self.runs[run_id])

    def expire(self, run_id: str) -> None:
        with self.lock:
            self.runs[run_id]["leaseUntil"] = "2000-01-01T00:00:00Z"

    def claim(self, worker: str, lease_ms: int = 60_000, kind: str | None = None) -> dict | None:
        now = "2026-11-19T12:00:00Z"
        with self.lock:
            for run in self.runs.values():
                if kind and run["kind"] != kind:
                    continue
                free = run["status"] == "queued" or (
                    run["status"] == "running" and (run["leaseUntil"] or "") <= now
                )
                if not free:
                    continue
                reclaimed = run["status"] == "running"
                run["status"] = "running"
                run["claimedBy"] = worker
                run["leaseUntil"] = "2099-01-01T00:00:00Z"
                run["attempts"] = run.get("attempts", 0) + 1
                return {"run": _public(run), "reclaimed": reclaimed, "leaseUntil": run["leaseUntil"]}
            return None

    def report(self, run_id: str, worker: str, payload: dict) -> dict | None:
        with self.lock:
            run = self.runs.get(run_id)
            if not run:
                return None
            if run["claimedBy"] != worker:
                raise PermissionError("claim_lost")
            facts = payload.get("facts") or {}
            if facts.get("runId") != run_id:
                raise ValueError("run_mismatch")
            run["manifestPath"] = payload.get("manifestPath", "")
            run["manifestSha256"] = payload.get("manifestSha256", "")
            run["counts"] = payload.get("counts") or {}
            run["status"] = facts.get("status") or run["status"]
            run["claimedBy"] = None
            run["leaseUntil"] = None
            return _public(run)

    def release(self, run_id: str, worker: str, reason: str) -> dict | None:
        with self.lock:
            run = self.runs.get(run_id)
            if not run or run["claimedBy"] != worker:
                return None
            run["status"] = "queued"
            run["claimedBy"] = None
            run["leaseUntil"] = None
            run["dispatch"]["last_release_reason"] = reason
            return _public(run)


def _public(run: dict) -> dict:
    return {key: (dict(value) if isinstance(value, dict) else value) for key, value in run.items()}


class _Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    state: QueueState = None  # type: ignore[assignment]

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
        path = self.path.split("/api/projects/", 1)[-1]
        parts = path.split("/")
        worker = f"{USER}::{(payload or {}).get('worker')}"
        try:
            if path.endswith("/qa/run-queue/claim"):
                claimed = self.state.claim(worker, int(payload.get("leaseMs") or 60_000), payload.get("kind"))
                return self._send(204, None) if claimed is None else self._send(200, claimed)
            if "/qa/run-queue/" in path:
                run_id = parts[-2]
                if path.endswith("/report"):
                    run = self.state.report(run_id, worker, payload)
                    return self._send(404, {"error": "not_found"}) if run is None else self._send(200, {"run": run})
                if path.endswith("/release"):
                    run = self.state.release(run_id, worker, payload.get("reason") or "")
                    return self._send(409, {"error": "claim_lost"}) if run is None else self._send(200, {"run": run})
        except PermissionError:
            return self._send(409, {"error": "claim_lost"})
        except ValueError as error:
            return self._send(400, {"error": str(error)})
        return self._send(404, {"error": "no_route"})


class FakePlatform:
    def __init__(self):
        self.state = QueueState()
        handler = type("_Bound", (_Handler,), {"state": self.state})
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    @property
    def base_url(self) -> str:
        return f"http://127.0.0.1:{self.server.server_address[1]}"

    def queue(self, worker: str) -> PlatformQueue:
        return PlatformQueue(self.base_url, "tk", PROJECT, worker)

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


def _platform_with(run_id: str = "run-1", **kwargs) -> tuple[FakePlatform, str]:
    platform = FakePlatform()
    run_dir = _run_dir(run_id, **kwargs)
    platform.state.enqueue(run_id, run_dir=run_dir)
    return platform, run_dir


def _ok_executor(dispatch, run_dir):
    with open(os.path.join(run_dir, "exec-ir.json"), "w", encoding="utf-8") as handle:
        json.dump({"run_id": dispatch.get("run_id", "run-1"), "verdict": "pass"}, handle)
    return {"verdict": "pass"}


# ------------------------------------------------------------------ 用例
def test_claim_execute_report_keeps_one_run_id():
    platform, run_dir = _platform_with()
    try:
        summary = consume_once(platform.queue("w1"), _ok_executor, counts_from=lambda result: {"passed": 3})
        assert summary["claimed"] is True and summary["executed"] is True, summary
        assert summary["run_id"] == "run-1", summary
        assert summary["verdict"] == "pass", summary
        assert summary["run_status"] == "completed", summary
        assert summary["counts"] == {"passed": 3}, summary
        run = platform.state.runs["run-1"]
        assert run["manifestPath"] == os.path.join(run_dir, "manifest.json"), run
        assert run["manifestSha256"] == manifest_sha256(os.path.join(run_dir, "manifest.json")), run
        assert len(platform.state.runs) == 1, "交回不应新增 run 行"
    finally:
        platform.close()


def test_empty_queue_is_not_an_error():
    platform = FakePlatform()
    try:
        assert consume_once(platform.queue("w1"), _ok_executor) == {"claimed": False}
    finally:
        platform.close()


def test_missing_manifest_releases_and_never_executes():
    platform = FakePlatform()
    try:
        run_dir = _run_dir("run-1", with_manifest=False)
        platform.state.enqueue("run-1", run_dir=run_dir)
        calls = []
        try:
            consume_once(platform.queue("w1"), lambda *a: calls.append(a) or {"verdict": "pass"})
            raise AssertionError("应当抛 ManifestMissing")
        except ManifestMissing:
            pass
        assert calls == [], "没有 manifest 就不该执行"
        run = platform.state.runs["run-1"]
        assert run["status"] == "queued", run
        assert run["dispatch"]["last_release_reason"] == "manifest_missing", run
    finally:
        platform.close()


def test_manifest_run_id_mismatch_is_refused_without_report():
    platform, _ = _platform_with("run-1", manifest_run_id="run-other")
    try:
        try:
            consume_once(platform.queue("w1"), _ok_executor)
            raise AssertionError("应当抛 RunIdentityMismatch")
        except RunIdentityMismatch:
            pass
        run = platform.state.runs["run-1"]
        assert run["status"] == "running", "身份不一致时既不能交回也不能放回，必须留给人看"
        assert run["manifestPath"] == "", run
    finally:
        platform.close()


def test_executor_error_releases_with_reason_and_no_fake_verdict():
    platform, _ = _platform_with()
    try:
        def boom(dispatch, run_dir):
            raise ValueError("browser crashed")

        summary = consume_once(platform.queue("w1"), boom)
        assert summary["executed"] is False, summary
        assert summary["reason"] == "executor_error:ValueError", summary
        assert summary["run_id"] == "run-1", summary
        run = platform.state.runs["run-1"]
        assert run["status"] == "queued", run
        assert run["dispatch"]["last_release_reason"] == "executor_error:ValueError", run
    finally:
        platform.close()


def test_two_workers_cannot_claim_the_same_run():
    platform, _ = _platform_with()
    try:
        first = platform.queue("w1").claim()
        second = platform.queue("w2").claim()
        assert first is not None and first["run"]["runId"] == "run-1", first
        assert second is None, second
    finally:
        platform.close()


def test_expired_lease_is_reclaimable_and_flagged():
    platform, _ = _platform_with()
    try:
        platform.queue("w1").claim()
        platform.state.expire("run-1")
        again = platform.queue("w2").claim()
        assert again is not None and again["reclaimed"] is True, again
        assert again["run"]["attempts"] == 2, again
    finally:
        platform.close()


def test_second_report_after_release_is_rejected():
    platform, run_dir = _platform_with()
    try:
        queue = platform.queue("w1")
        summary = consume_once(queue, _ok_executor, counts_from=lambda r: {"passed": 1})
        assert summary["executed"] is True, summary
        # 结果已交付后，这条 run 不会再被领取（它不是待办了），队列返回空而不是重复跑。
        assert consume_once(queue, _ok_executor) == {"claimed": False}
        # 而直接重复交回同一份结果，必须被租约校验挡住。
        try:
            queue.report("run-1", facts={"runId": "run-1", "status": "completed"},
                         manifest_path=os.path.join(run_dir, "manifest.json"),
                         sha256=manifest_sha256(os.path.join(run_dir, "manifest.json")),
                         counts={"passed": 1})
            raise AssertionError("第二次交回应被拒（同一次执行只有一份结论）")
        except DispatchError as error:
            assert "409" in str(error), error
        assert platform.state.runs["run-1"]["counts"] == {"passed": 1}
    finally:
        platform.close()


def test_fingerprint_is_taken_after_execution():
    platform, run_dir = _platform_with()
    try:
        manifest_path = os.path.join(run_dir, "manifest.json")

        def mutate(dispatch, path):
            with open(os.path.join(path, "manifest.json"), encoding="utf-8") as handle:
                data = json.load(handle)
            data["baseline_hash"] = "sha256:after-exec"
            with open(os.path.join(path, "manifest.json"), "w", encoding="utf-8") as handle:
                json.dump(data, handle)
            return {"verdict": "pass"}

        before = hashlib.sha256(open(manifest_path, "rb").read()).hexdigest()
        consume_once(platform.queue("w1"), mutate)
        after = platform.state.runs["run-1"]["manifestSha256"]
        assert after == manifest_sha256(manifest_path), after
        assert after != f"sha256:{before}", "指纹必须是执行后的 manifest，不是执行前的"
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
