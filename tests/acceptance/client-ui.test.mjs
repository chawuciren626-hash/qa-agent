import test from "node:test";
import assert from "node:assert/strict";
import {
  qaScope,
  qaRead,
  qaWrite,
  qaBindProject,
  qaTaskStatus,
  qaProjectForSession,
  qaLastOutcome,
} from "../../penguin/ui/workspace-ui.mjs";
import {
  clientPatchPairs,
  patchClientBundle,
} from "../../scripts/client-ui-patches.mjs";
const memory = () => {
  const map = new Map();
  return {
    getItem: (key) => map.get(key) || null,
    setItem: (key, value) => map.set(key, value),
  };
};
test("project metadata is isolated by account, host configuration and installation", () => {
  const store = memory();
  store.setItem("penguin.installId", "a");
  const scope = qaScope("host", "alice", store);
  qaWrite(
    scope,
    {
      projects: [{ id: "one", name: "中文项目", folders: ["E:/需求"] }],
      bindings: {},
    },
    store,
  );
  qaBindProject("host", "alice", "one", "session-1", store);
  assert.equal(qaRead(scope, store).bindings["session-1"], "one");
  assert.deepEqual(qaRead(qaScope("host", "bob", store), store).projects, []);
  assert.deepEqual(
    qaRead(qaScope("other", "alice", store), store).projects,
    [],
  );
  store.setItem("penguin.installId", "b");
  assert.deepEqual(qaRead(qaScope("host", "alice", store), store).projects, []);
});
test("failed metadata write is surfaced and unrelated session binding is never fabricated", () => {
  const store = memory(),
    scope = qaScope("h", "u", store);
  qaWrite(scope, { projects: [], bindings: {} }, store);
  qaBindProject("h", "u", "missing", "s", store);
  assert.deepEqual(qaRead(scope, store).bindings, {});
  assert.throws(
    () =>
      qaWrite(
        scope,
        {},
        {
          setItem: () => {
            throw Error("quota");
          },
        },
      ),
    /quota/,
  );
});
test("historical workspace grouping respects directory boundaries and explicit task association", () => {
  const projects = [
    { id: "a", folders: ["E:\\work\\商城"] },
    { id: "b", folders: ["E:/work/商城/sub"] },
  ];
  assert.equal(
    qaProjectForSession(
      projects,
      {},
      { sessionId: "s", workspace: "e:/work/商城/2026/run" },
    ).id,
    "a",
  );
  assert.equal(
    qaProjectForSession(
      projects,
      {},
      { sessionId: "s", workspace: "E:/work/商城/sub/run" },
    ).id,
    "b",
  );
  assert.equal(
    qaProjectForSession(
      projects,
      {},
      { sessionId: "s", workspace: "E:/work/商城备份/run" },
    ),
    null,
  );
  assert.equal(
    qaProjectForSession(
      projects,
      { s: "a" },
      { sessionId: "s", workspace: "E:/work/商城/sub/run" },
    ).id,
    "a",
  );
  assert.equal(
    qaProjectForSession(
      [...projects, { id: "c", folders: ["E:/work/商城"] }],
      {},
      { sessionId: "s", workspace: "E:/work/商城/run" },
    ),
    null,
  );
});
test("idle does not mean success; live error, approval and running state take precedence", () => {
  assert.equal(
    qaTaskStatus({ status: "idle", hasTrace: true }).label,
    "待继续",
  );
  assert.equal(qaTaskStatus({ status: "idle" }).label, "未开始");
  assert.equal(
    qaTaskStatus({ status: "idle" }, { stopReason: "completed" }).kind,
    "done",
  );
  assert.equal(
    qaTaskStatus({ status: "running" }, { stopReason: "completed" }).kind,
    "running",
  );
  assert.equal(
    qaTaskStatus({ status: "running" }, { pending: 1 }).kind,
    "waiting",
  );
  assert.equal(
    qaTaskStatus({ status: "running" }, { error: "lost connection" }).kind,
    "error",
  );
  assert.equal(qaTaskStatus({ status: "cancelled" }).label, "已停止");
});
test("client adapter refuses changed or duplicate host anchors", () => {
  const source = clientPatchPairs.map(([before]) => before).join("\n");
  assert.match(patchClientBundle(source), /QaLegacySidebar/);
  assert.throws(
    () => patchClientBundle(source + "\n" + clientPatchPairs[0][0]),
    /not unique/,
  );
  assert.throws(
    () => patchClientBundle(source.replace(clientPatchPairs[0][0], "")),
    /not unique/,
  );
});

test("new user turns and later aborts cannot inherit an old success badge", () => {
  const done = { kind: "assistant_text", stopReason: "completed" };
  assert.equal(qaLastOutcome([done, { kind: "user_text" }]), undefined);
  assert.equal(qaLastOutcome([done, { kind: "abort" }]), "aborted");
  assert.equal(
    qaLastOutcome([done, { kind: "abort", errorCode: "execution_error" }]),
    "failed",
  );
  assert.equal(
    qaTaskStatus({ status: "idle" }, { stopReason: "failed" }).kind,
    "error",
  );
});
