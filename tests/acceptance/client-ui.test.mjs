import test from "node:test";
import assert from "node:assert/strict";
import {
  qaScope,
  qaRead,
  qaWrite,
  qaBindProject,
  qaTaskStatus,
  qaProjectForSession,
  qaWorkspaceGroups,
  qaLastOutcome,
  qaReadBookmarks,
  qaToggleBookmark,
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
test('conversation bookmarks survive item ID changes and stay isolated by session and user',()=>{
  const store=memory(),alice=qaScope('project','alice',store)+'.bookmarks.session-1',other=qaScope('project','alice',store)+'.bookmarks.session-2',bob=qaScope('project','bob',store)+'.bookmarks.session-1';
  assert.deepEqual(qaToggleBookmark(alice,37,store),[37]);
  assert.deepEqual(qaReadBookmarks(alice,store),[37]);
  assert.deepEqual(qaReadBookmarks(other,store),[]);assert.deepEqual(qaReadBookmarks(bob,store),[]);
  assert.deepEqual(qaToggleBookmark(alice,37,store),[]);
  store.setItem(alice,'[2,2,-1,"3",null]');assert.deepEqual(qaReadBookmarks(alice,store),[2]);
  store.setItem(alice,'broken');assert.deepEqual(qaReadBookmarks(alice,store),[]);
  assert.throws(()=>qaToggleBookmark(alice,-1,store),/Invalid/);
  assert.throws(()=>qaToggleBookmark(alice,2,{getItem:()=>null,setItem:()=>{throw Error('quota');}}),/quota/);
});
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

test("every historical task remains in a workspace while explicit bindings win", () => {
  const original = {projects:[{id:"named",name:"已有空间",folders:["E:/work/shop"]}],bindings:{s1:"named"}};
  const sessions = [{sessionId:"s1",workspace:"E:/other"},{sessionId:"s2",workspace:"E:/work/legacy/2026-10-26-10-00-00-aabb"},{sessionId:"s3",workspace:"E:/work/legacy/2026-10-26-11-00-00-ccdd"},{sessionId:"s4",workspace:""}];
  const result = qaWorkspaceGroups(original,sessions);
  assert.equal(result.bindings.s1,"named");
  assert.equal(result.bindings.s2,result.bindings.s3);
  assert.equal(result.projects.find(p=>p.id===result.bindings.s2).name,"legacy");
  for(const session of sessions) assert.ok(qaProjectForSession(result.projects,result.bindings,session));
  assert.equal(original.projects.length,1);
  assert.deepEqual(original.bindings,{s1:"named"});
});
test("a task sent without an explicit selection receives a default workspace within its project",()=>{
  const store=memory();
  qaBindProject("business-a","alice",null,"new-task",store);
  const saved=qaRead(qaScope("business-a","alice",store),store);
  assert.equal(saved.bindings["new-task"],"default-workspace");
  assert.equal(saved.projects[0].name,"默认工作空间");
  assert.equal(qaRead(qaScope("business-b","alice",store),store).projects.length,0);
});
