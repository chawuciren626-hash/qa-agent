import { afterEach, beforeEach, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { ControlStore, controlRoutes } from "../src/http/control-plane.js";
import type { AppEnv } from "../src/auth/middleware.js";
import { HttpError } from "../src/http/errors.js";

let db: DatabaseSync, store: ControlStore, app: Hono<AppEnv>;
beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE users(user_id TEXT PRIMARY KEY,is_admin INTEGER NOT NULL DEFAULT 0); INSERT INTO users VALUES ('admin',1),('alice',0);");
  store = new ControlStore(db);
  app = new Hono<AppEnv>();
  app.onError(error => new Response(JSON.stringify({ error: error.message }), { status: error instanceof HttpError ? error.status : 500, headers: { "content-type": "application/json" } }));
  app.use("*", async (c, next) => { c.set("user", { userId: c.req.header("x-user") ?? "admin", isAdmin: c.req.header("x-user") !== "alice" } as AppEnv["Variables"]["user"]); await next(); });
  app.route("/api/control", controlRoutes(store));
});
afterEach(() => { db.close(); });

type Tool = { id: string; name: string; permissions: string; version: number; revision: number; enabled: boolean; builtin: boolean; categoryId: string; agents: string[]; parameters: string };
type Payload = { tools: Tool[]; categories: { id: string; name: string }[] };
const send = (path: string, method = "GET", body?: unknown, user = "admin") =>
  app.request("/api/control/tools" + path, { method, headers: { "content-type": "application/json", "x-user": user }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const list = async () => (await (await send("/admin")).json()) as Payload;
const catalog = async () => ((await (await send("/catalog")).json()) as { tools: Tool[] }).tools;
const draft = { displayName: "自定义校验", summary: "一句话", description: "详细说明", categoryId: "case", permissions: "write", parameters: '{"type":"object"}', returns: '{"type":"object"}' };

it("seeds the builtin tools and keeps the stage order of the skills page", async () => {
  const data = await list();
  expect(data.categories.map(item => item.id)).toEqual(["common", "req", "design", "case", "web", "api", "app", "mini", "report", "defect"]);
  // 种子数与 SEED 数组一致：早期 9 个，v1.1 后补登各阶段已落地工具（B1~B12 + Python 侧）。
  expect(data.tools.length).toBe(33);
  // 内置工具必须挂到真实 Agent 上，否则「引用关系」只是装饰。
  expect(data.tools.every(tool => tool.agents.length > 0)).toBe(true);
  expect(data.tools.find(tool => tool.name === "assets.library")?.permissions).toBe("write");
  // 规划中的按「停用」入库，而不是伪装成可用能力。
  // 判定标准是「仓库里指不指得出具体文件」。当前 SEED 全部有具体实现文件——
  // knowledge.incremental 与 requirement.completeness 已分别落地（knowledge/incremental.py、
  // qa/scripts/requirement-completeness.mjs），不再按规划中停用。
  expect(data.tools.every(tool => tool.enabled)).toBe(true);
  expect(data.tools.every(tool => tool.builtin)).toBe(true);
});

it("creates a tool, versions it only on contract changes, and drops it from the runtime catalog when disabled", async () => {
  const created = await send("/admin", "POST", { ...draft, name: "custom.check" });
  expect(created.status).toBe(201);
  const tool = (await created.json()) as Tool;
  expect(tool.version).toBe(1);
  expect((await catalog()).some(item => item.name === "custom.check")).toBe(true);

  const contracted = await send(`/admin/${tool.id}`, "PUT", { ...draft, name: "custom.check", parameters: '{"type":"object","required":["x"]}', revision: tool.revision });
  expect(contracted.status).toBe(200);
  const afterContract = (await contracted.json()) as Tool;
  expect(afterContract.version).toBe(2);

  // 只改显示名称这类表述，不算契约变更：版本号不该被噪声推高。
  const touched = await send(`/admin/${tool.id}`, "PUT", { displayName: "自定义校验（改名）", revision: afterContract.revision });
  expect(((await touched.json()) as Tool).version).toBe(2);

  const disabled = (await (await send(`/admin/${tool.id}/toggle`, "POST", {})).json()) as Tool;
  expect(disabled.enabled).toBe(false);
  expect((await catalog()).some(item => item.name === "custom.check")).toBe(false);

  // 编辑页保存也能落启停，两条入口写同一列。
  const reenabled = await send(`/admin/${tool.id}`, "PUT", { enabled: true, revision: disabled.revision });
  expect(((await reenabled.json()) as Tool).enabled).toBe(true);
  expect((await catalog()).some(item => item.name === "custom.check")).toBe(true);
});

it("keeps builtin tools undeletable, rejects unknown agents and duplicates, and guards stale revisions", async () => {
  const builtin = (await list()).tools[0]!;
  expect((await send(`/admin/${builtin.id}`, "DELETE")).status).toBe(409);

  expect((await send("/admin", "POST", { ...draft, name: "ghost.tool", agents: ["no_such_agent"] })).status).toBe(400);
  expect((await send("/admin", "POST", { ...draft, name: "custom.check" })).status).toBe(201);
  expect((await send("/admin", "POST", { ...draft, name: "custom.check" })).status).toBe(409);
  expect((await send("/admin", "POST", { ...draft, name: "Bad Name" })).status).toBe(400);

  const tool = (await list()).tools.find(item => item.name === "custom.check")!;
  expect((await send(`/admin/${tool.id}`, "PUT", { summary: "冲突", revision: tool.revision + 9 })).status).toBe(409);

  const removed = await send(`/admin/${tool.id}`, "DELETE");
  expect(removed.status).toBe(200);
  expect((await list()).tools.some(item => item.name === "custom.check")).toBe(false);
});

it("binds tools to real agents and records every mutation", async () => {
  store.save("admin", { kind: "agents", name: "Runtime role", payload: { agentId: "test_agent", prompt: "p", agentsMd: "m" }, audience: ["alice"] });
  const created = (await (await send("/admin", "POST", { ...draft, name: "linked.tool", agents: ["test_agent"] })).json()) as Tool;
  expect(created.agents).toEqual(["test_agent"]);

  expect((await send(`/admin/${created.id}/toggle`, "POST", {})).status).toBe(200);
  const audit = (await (await send(`/admin/${created.id}/audit`)).json()) as { entries: { action: string; actor: string }[] };
  expect(audit.entries.map(entry => entry.action)).toEqual(expect.arrayContaining(["create", "disable"]));
  expect(audit.entries.every(entry => entry.actor === "admin")).toBe(true);
});

it("refuses member access to the tool console and its writes", async () => {
  expect((await send("/admin", "GET", undefined, "alice")).status).toBe(403);
  expect((await send("/admin", "POST", { ...draft, name: "member.tool" }, "alice")).status).toBe(403);
  // 只读目录对普通成员开放：运行期要拿它装配可用工具。
  expect((await send("/catalog", "GET", undefined, "alice")).status).toBe(200);
});

/**
 * 运行面接入的三条契约：
 * 1. 没有引擎根目录时，必须明确「未同步」，而不是假装生效；
 * 2. 列表要带「管着多少 action」，否则停用一条无绑定的工具会被误以为拦住了什么；
 * 3. usage 接口在无引擎时返回零值而不是报错——观测缺失不该让页面打不开。
 */
it("reports runtime enforcement state honestly instead of pretending the switch works", async () => {
  const before = process.env.AITEST_ENGINE_ROOT;
  delete process.env.AITEST_ENGINE_ROOT;
  try {
    const data = await (await send("/admin")).json() as { enforced: boolean; engine_configured: boolean; bindings_available: boolean; tools: (Tool & { bindings: unknown; calls: number })[] };
    expect(data.engine_configured).toBe(false);
    expect(data.enforced).toBe(false);
    // 读不到绑定表时给 null，而不是空对象——空对象会被前端当成「管 0 个 action」。
    expect(data.bindings_available).toBe(false);
    expect(data.tools.every(tool => tool.bindings === null)).toBe(true);
    expect(data.tools.every(tool => tool.calls === 0)).toBe(true);

    const usage = await (await send("/admin/usage")).json() as { total: number; enforced: boolean; note: string | null };
    expect(usage.total).toBe(0);
    expect(usage.enforced).toBe(false);
    // 这句话是给人看的：没有它，运营会以为停用是生效的。
    expect(usage.note).toContain("不会拦住 Agent");
  } finally {
    if (before === undefined) delete process.env.AITEST_ENGINE_ROOT; else process.env.AITEST_ENGINE_ROOT = before;
  }
});

it("catalog exposes enforced flag so装配方 knows whether disabling is real", async () => {
  const data = await (await send("/catalog")).json() as { enforced: boolean; tools: { name: string }[] };
  expect(data.enforced).toBe(false);
  // catalog 只暴露已启用的工具；种子 33 个全部落地启用。
  expect(data.tools.length).toBe(33);
});
