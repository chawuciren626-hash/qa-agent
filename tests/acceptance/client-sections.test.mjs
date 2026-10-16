import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  libraryOperation,
  patchLibraryServer,
  libraryAnchor,
} from "../../scripts/client-library.mjs";
import {
  qaScheduleBody,
  qaScheduleContent,
} from "../../penguin/ui/workspace-ui.mjs";
const fixture = (t) => {
  const root = mkdtempSync(join(tmpdir(), "qa-library-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return (method, id, body, project = "p", user = "alice") =>
    libraryOperation(root, project, user, method, id, body);
};
test("library persists Unicode documents and binary imports without exposing content in listings", async (t) => {
  const op = fixture(t),
    file = await op("POST", null, {
      name: "需求.md",
      kind: "file",
      content: "# 中文需求",
    });
  assert.equal((await op("GET", file.id)).content, "# 中文需求");
  const all = await op("GET");
  assert.equal(all.entries[0].name, "需求.md");
  assert.equal(all.entries[0].content, undefined);
  const bytes = Buffer.from([0, 255, 1, 200]);
  const upload = await op("POST", null, {
    name: "report.pdf",
    kind: "file",
    content: bytes.toString("base64"),
    encoding: "base64",
  });
  assert.deepEqual(
    Buffer.from((await op("GET", upload.id)).content, "base64"),
    bytes,
  );
  assert.equal((await op("GET", null, null, "p", "bob")).entries.length, 0);
  assert.equal(
    (await op("GET", null, null, "other", "alice")).entries.length,
    0,
  );
  await assert.rejects(op("GET", file.id, null, "p", "bob"), /不存在/);
});
test("library refuses traversal, unsupported URLs, duplicate names, stale saves and nonempty folder deletion", async (t) => {
  const op = fixture(t);
  for (const name of ["../secret", "a/b", "NUL.txt", "C:\\test", "file."])
    await assert.rejects(
      op("POST", null, { name, kind: "file", content: "" }),
      /名称/,
    );
  await assert.rejects(op("GET", "../outside"), /标识/);
  await assert.rejects(
    op("POST", null, {
      name: "link",
      kind: "link",
      content: "javascript:alert(1)",
    }),
    /仅支持/,
  );
  const folder = await op("POST", null, { name: "需求", kind: "folder" });
  const doc = await op("POST", null, {
    name: "case.md",
    kind: "file",
    content: "v1",
    parentId: folder.id,
  });
  await assert.rejects(
    op("POST", null, {
      name: "CASE.md",
      kind: "file",
      content: "",
      parentId: folder.id,
    }),
    /同名/,
  );
  await assert.rejects(
    op("DELETE", folder.id, { revision: folder.revision }),
    /文件夹内/,
  );
  const update = await op("PUT", doc.id, { ...doc, content: "v2" });
  assert.equal((await op("GET", doc.id)).content, "v2");
  await assert.rejects(
    op("PUT", doc.id, { ...doc, content: "lost update" }),
    /已更新/,
  );
  await op("DELETE", doc.id, { revision: update.revision });
  await op("DELETE", folder.id, { revision: folder.revision });
  assert.equal((await op("GET")).entries.length, 0);
});
test("concurrent writes preserve both files and reject racing same-name creates", async (t) => {
  const op = fixture(t);
  await Promise.all(
    ["a.md", "b.md"].map((name) =>
      op("POST", null, { name, kind: "file", content: "x" }),
    ),
  );
  assert.equal((await op("GET")).entries.length, 2);
  const results = await Promise.allSettled(
    [1, 2].map(() =>
      op("POST", null, { name: "race.md", kind: "file", content: "x" }),
    ),
  );
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
});
test("library validates import sizes, encodings and missing parents", async (t) => {
  const op = fixture(t);
  await assert.rejects(
    op("POST", null, {
      name: "large.txt",
      kind: "file",
      content: "x".repeat(10 * 1024 * 1024 + 1),
    }),
    /10 MB/,
  );
  await assert.rejects(
    op("POST", null, {
      name: "bad.pdf",
      kind: "file",
      content: "!!!!",
      encoding: "base64",
    }),
    /编码/,
  );
  await assert.rejects(
    op("POST", null, {
      name: "bad.md",
      kind: "file",
      content: "x",
      parentId: "missing",
    }),
    /文件夹不存在/,
  );
});
test("schedule forms retain native model/workspace/session and validate recurring times", () => {
  const form = {
    title: "每日回归",
    prompt: "检查登录",
    startAt: "2030-01-01T10:00",
    repeat: "1d",
    period: "",
    endAt: "",
    workspace: "E:/测试",
    enabled: true,
    model: JSON.stringify({ provider: "p", modelId: "m" }),
  };
  const body = qaScheduleBody(form, null, 0);
  assert.equal(body.period, "1d");
  assert.equal(body.workspace, "E:/测试");
  assert.equal(body.modelId, "m");
  assert.equal(body.enabled, true);
  assert.deepEqual(qaScheduleContent({ ...body, name: "qa-123" }), {
    title: "每日回归",
    prompt: "检查登录",
  });
  assert.equal(
    qaScheduleBody(form, { sessionId: "existing" }, 0).sessionId,
    "existing",
  );
  assert.throws(
    () => qaScheduleBody({ ...form, startAt: "2000-01-01" }, null),
    /晚于当前/,
  );
  for (const period of ["4m", "1.5h", "0d", "abc"])
    assert.throws(
      () => qaScheduleBody({ ...form, repeat: "custom", period }, null, 0),
      /重复间隔/,
    );
  assert.throws(
    () => qaScheduleBody({ ...form, endAt: "2029-01-01" }, null, 0),
    /有效期/,
  );
  assert.throws(
    () => qaScheduleBody({ ...form, title: "坏\n标题" }, null, 0),
    /名称/,
  );
  assert.equal(
    qaScheduleContent({ name: "legacy", prompt: "原有提示词" }).prompt,
    "原有提示词",
  );
});
test("library patch preserves host authentication and rejects unknown hosts", () => {
  const patched = patchLibraryServer(libraryAnchor, "file:///test/library.mjs");
  assert.match(
    patched,
    /qaRegisterLibrary\(app, deps, \{requireValidId, HttpError\}\)/,
  );
  assert.throws(() => patchLibraryServer("unknown", "x"), /anchor/);
});
import { registerLibraryRoutes } from "../../scripts/client-library.mjs";
test("library HTTP routes enforce host access before touching data and keep errors actionable", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "qa-library-http-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const routes = new Map(),
    app = {};
  for (const verb of ["get", "post", "put", "delete"])
    app[verb] = (path, fn) => routes.set(verb + path, fn);
  class HttpError extends Error {
    constructor(status, code, message) {
      super(message);
      this.status = status;
      this.code = code;
    }
  }
  let allowed = false;
  registerLibraryRoutes(
    app,
    {
      memoryService: { root },
      access: {
        requireProjectAccess(user, project) {
          assert.equal(user, "alice");
          assert.equal(project, "p");
          if (!allowed) throw new HttpError(403, "denied", "denied");
        },
      },
    },
    { requireValidId: () => "p", HttpError },
  );
  const context = (method, body, id) => ({
    var: { user: { userId: "alice" } },
    req: {
      method,
      param: () => id,
      raw: new Request("http://local/api", {
        method,
        ...(method === "GET" ? {} : { body }),
      }),
    },
    json: (data, status) => ({ data, status }),
  });
  await assert.rejects(
    routes.get("get/library")(context("GET")),
    (e) => e.status === 403,
  );
  allowed = true;
  const made = await routes.get("post/library")(
    context(
      "POST",
      JSON.stringify({ name: "api.md", kind: "file", content: "saved" }),
    ),
  );
  assert.equal(made.status, 201);
  const listed = await routes.get("get/library")(context("GET"));
  assert.equal(listed.data.entries.length, 1);
  await assert.rejects(
    routes.get("post/library")(context("POST", "{bad")),
    (e) => e.status === 400,
  );
  await assert.rejects(
    routes.get("post/library")(context("POST", "null")),
    (e) => e.status === 400,
  );
  await assert.rejects(
    routes.get("post/library")(
      context("POST", "x".repeat(15 * 1024 * 1024 + 1)),
    ),
    (e) => e.status === 413,
  );
});
