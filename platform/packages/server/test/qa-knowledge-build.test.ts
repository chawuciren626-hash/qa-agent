/**
 * A6 知识构建：资料 → 条款（带原文位置）→ 知识版本，以及版本 diff / 引用反查。
 *
 * 这里钉的几条都是"看起来建好了、其实没法用"的形态：
 *   1. 没原文位置的知识项必须被丢弃，并在 stats.dropped 里计数；
 *   2. 条款 id 跨资料不能撞，否则"原文位置"指向别的文件；
 *   3. 同一输入重复构建不得升版本（content_hash 相同 → unchanged）；
 *   4. 资料改了之后 diff 必须能说清是语义变了还是只改了措辞。
 */
import { afterEach, describe, expect, it } from "vitest";
import { apiClient, createTestApp, provisionUser, type TestApp } from "./helpers.js";

const projectId = "kb_owner-builds";
const base = `/api/projects/${projectId}/agents/qa`;

describe.skipIf(!process.env.AITEST_ENGINE_ROOT)("QA knowledge builds", () => {
  let app: TestApp;
  afterEach(async () => {
    await app?.cleanup();
  });

  const setup = async () => {
    app = await createTestApp();
    const owner = apiClient(app.app, (await provisionUser(app.app, "kb_owner")).cookie);
    expect((await owner.post("/api/projects", { projectId })).status).toBe(201);
    return owner;
  };

  it("keeps原文位置 for every item and drops what cannot be located", async () => {
    const owner = await setup();
    const created = await owner.post(`${base}/documents`, {
      title: "退款规则",
      content: "# 退款\n\n## 上限\n\n单笔退款不超过 500 元。\n\n## 时效\n\n- 审批后 3 个工作日到账\n",
    });
    expect(created.status).toBe(201);

    const built = await owner.post(`${base}/knowledge/builds`, {
      items: [
        { type: "rule", name: "退款上限", statement: "单笔退款不超过 500 元", clause_id: "s01-c0001" },
        { type: "constraint", name: "到账时效", statement: "审批后 3 个工作日到账", clause_id: "s01-c0002" },
        { type: "rule", name: "凭空捏造", statement: "这条没有任何原文出处" },
        { type: "bogus", name: "类型非法", statement: "类型不在封闭枚举里" },
      ],
    });
    expect(built.status).toBe(201);
    const result = (await built.json()) as {
      build: { version: number; contentHash: string; items: { name: string; source: { file: string; line: number }; section: string }[]; stats: Record<string, number>; sources: { documentId: string; title: string }[] };
      unchanged: boolean;
    };
    expect(result.unchanged).toBe(false);
    expect(result.build.version).toBe(1);
    expect(result.build.items.map(item => item.name)).toEqual(["退款上限", "到账时效"]);
    // 位置是"退款规则"这份资料的第 5 行——不是 1，也不是别的文件。
    expect(result.build.items[0]!.source.line).toBe(5);
    expect(result.build.items[0]!.section).toBe("退款 / 上限");
    expect(result.build.items[1]!.section).toBe("退款 / 时效");
    expect(result.build.sources[0]!.title).toBe("退款规则");
    expect(result.build.stats.dropped).toBe(2);

    // 同一输入再建一次：不升版本、不产生噪音 diff。
    const again = await owner.post(`${base}/knowledge/builds`, { items: [
      { type: "rule", name: "退款上限", statement: "单笔退款不超过 500 元", clause_id: "s01-c0001" },
      { type: "constraint", name: "到账时效", statement: "审批后 3 个工作日到账", clause_id: "s01-c0002" },
    ] });
    expect(again.status).toBe(200);
    const repeat = (await again.json()) as { unchanged: boolean; build: { version: number; contentHash: string } };
    expect(repeat.unchanged).toBe(true);
    expect(repeat.build.version).toBe(1);

    const list = await owner.get(`${base}/knowledge/builds`);
    expect(((await list.json()) as { builds: unknown[] }).builds).toHaveLength(1);
  });

  it("diffs two versions, and tells wording-only changes apart from semantic ones", async () => {
    const owner = await setup();
    const created = await owner.post(`${base}/documents`, {
      title: "退款规则", content: "# 退款\n\n单笔退款不超过 500 元。\n",
    });
    const documentId = ((await created.json()) as { document: { documentId: string } }).document.documentId;
    await owner.post(`${base}/knowledge/builds`, {
      items: [{ type: "rule", name: "退款上限", statement: "单笔退款不超过 500 元", clause_id: "s01-c0001" }],
    });

    // 只改措辞（加了个空格 + 换了标点）：不得触发重算。
    await owner.put(`${base}/documents/${documentId}`, { expectedRevision: 1, content: "# 退款\n\n单笔退款 不超过 500 元。\n" });
    const wording = await owner.post(`${base}/knowledge/builds`, {
      items: [{ type: "rule", name: "退款上限", statement: "单笔退款 不超过 500 元", clause_id: "s01-c0001" }],
    });
    expect(wording.status).toBe(201);
    const wordingBody = (await wording.json()) as { build: { version: number }; diff: { triggersRecompute: boolean; stats: Record<string, number> } };
    expect(wordingBody.build.version).toBe(2);
    expect(wordingBody.diff.triggersRecompute).toBe(false);
    expect(wordingBody.diff.stats.wording_only).toBe(1);

    // 真改了语义：必须触发重算。
    await owner.put(`${base}/documents/${documentId}`, { expectedRevision: 2, content: "# 退款\n\n单笔退款不超过 200 元。\n" });
    const semantic = await owner.post(`${base}/knowledge/builds`, {
      items: [{ type: "rule", name: "退款上限", statement: "单笔退款不超过 200 元", clause_id: "s01-c0001" }],
    });
    const semanticBody = (await semantic.json()) as { build: { version: number }; diff: { triggersRecompute: boolean; stats: Record<string, number> } };
    expect(semanticBody.build.version).toBe(3);
    expect(semanticBody.diff.triggersRecompute).toBe(true);
    expect(semanticBody.diff.stats.semantic_changed).toBe(1);

    const diffRoute = await owner.get(`${base}/knowledge/builds/3/diff`);
    expect(diffRoute.status).toBe(200);
    const explicit = (await diffRoute.json()) as { from: number; to: number };
    expect(explicit).toMatchObject({ from: 2, to: 3 });
  });

  it("finds which knowledge items a piece of text refers to", async () => {
    const owner = await setup();
    await owner.post(`${base}/documents`, {
      title: "退款规则", content: "# 退款\n\n单笔退款不超过 500 元。\n\n# 登录\n\n连续五次失败锁定十五分钟。\n",
    });
    await owner.post(`${base}/knowledge/builds`, {
      items: [
        { type: "rule", name: "退款上限", statement: "单笔退款不超过 500 元", clause_id: "s01-c0001" },
        { type: "rule", name: "锁定时长", statement: "连续五次失败锁定十五分钟", clause_id: "s01-c0002" },
      ],
    });

    const found = await owner.post(`${base}/knowledge/references`, { text: "验证退款上限在 500 元边界的行为" });
    expect(found.status).toBe(200);
    const body = (await found.json()) as { version: number; hits: { name: string; source: { file: string; line: number } }[] };
    expect(body.version).toBe(1);
    expect(body.hits.map(hit => hit.name)).toEqual(["退款上限"]);
    expect(body.hits[0]!.source.line).toBe(3);

    // 空文本反查是坏请求，不是"没引用"——两者混起来页面会显示"无影响"。
    expect((await owner.post(`${base}/knowledge/references`, { text: "  " })).status).toBe(400);
  });

  it("has no build yet when nothing was built", async () => {
    const owner = await setup();
    const found = await owner.post(`${base}/knowledge/references`, { text: "退款上限" });
    expect(found.status).toBe(200);
    expect((await found.json()) as { version: number }).toMatchObject({ version: 0, hits: [] });
    expect((await owner.get(`${base}/knowledge/builds/1`)).status).toBe(404);
  });
});
