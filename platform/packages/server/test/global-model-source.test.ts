/**
 * 全局单一真相源：模型默认指针以账号级 .account-models/<hash>.json 为准。
 *
 * 这里用 wire 注入一个最小的 Projects 替身（只提供 owner 归属），不启动完整平台，
 * 因此不受 manifest / DI 装配影响；验证的是「消费点读到哪一个模型」这一确定性逻辑。
 */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { wire } from "@prismshadow/penguin-core/kernel";
import { ProjectConfigService } from "../src/services/project-config-service.js";
import type { Projects } from "../src/mechanisms/projects.js";
import type { ProjectRow } from "../src/db/repos/projects.js";
import { makeTempRoot } from "./helpers.js";

const OWNER = "owner-user";
const modelA = { provider: "custom", model_id: "model-a", api_key: "sk-a", base_url: "https://a.example/v1" };
const modelB = { provider: "custom", model_id: "model-b", api_key: "sk-b", base_url: "https://b.example/v1" };

function projectsStub(owner: Record<string, string>): Projects {
  const rows: ProjectRow[] = Object.entries(owner).map(([projectId, ownerUserId]) => ({
    projectId, ownerUserId, createdAt: "2026-01-01T00:00:00.000Z",
  }));
  return {
    insert() {},
    findById(id) { return rows.find((r) => r.projectId === id) ?? null; },
    listAll() { return rows; },
    listAccessible() { return []; },
    listByOwner(userId) { return rows.filter((r) => r.ownerUserId === userId); },
    delete() {},
  } as Projects;
}

describe("account-global model as the single source of truth", () => {
  let root: string;
  let service: ProjectConfigService;

  beforeEach(async () => {
    root = await makeTempRoot();
    service = wire(ProjectConfigService, {
      paths: { root },
      projects: projectsStub({ "p-owned": OWNER, "p-foreign": "another-user" }),
    });
  });
  afterEach(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(root, { recursive: true, force: true });
  });

  it("reads the account-global default model even when the project TOML points elsewhere", async () => {
    // 项目 TOML 指向 model-b，但账号全局配置指向 model-a。
    await service.writeRaw("p-owned", {
      models: [modelB],
      default_model: { provider: "custom", model_id: "model-b" },
    });
    await service.publishUserModelBlock(OWNER, {
      models: [modelA, modelB],
      default_model: { provider: "custom", model_id: "model-a" },
    });

    expect(await service.getDefaultModelRef("p-owned")).toEqual({ provider: "custom", model_id: "model-a" });
  });

  it("falls back to the first account model when no default pointer is set", async () => {
    await service.publishUserModelBlock(OWNER, { models: [modelB, modelA] });
    expect(await service.getDefaultModelRef("p-owned")).toEqual({ provider: "custom", model_id: "model-b" });
  });

  it("falls back to the project TOML when the project owner has no global config", async () => {
    // p-foreign 的 owner 没有发布过全局模型块 → 回退读项目自己的 TOML。
    await service.writeRaw("p-foreign", {
      models: [modelB],
      default_model: { provider: "custom", model_id: "model-b" },
    });
    expect(await service.getDefaultModelRef("p-foreign")).toEqual({ provider: "custom", model_id: "model-b" });
  });

  it("sets and clears the global default pointer without touching model entries", async () => {
    await service.publishUserModelBlock(OWNER, {
      models: [modelA, modelB],
      default_model: { provider: "custom", model_id: "model-a" },
    });
    await service.setUserDefaultModel(OWNER, { provider: "custom", modelId: "model-b" });
    expect(await service.getDefaultModelRef("p-owned")).toEqual({ provider: "custom", model_id: "model-b" });

    // 清除后回退第一条（model-a），两条模型条目仍在。
    await service.setUserDefaultModel(OWNER, null);
    expect(await service.getDefaultModelRef("p-owned")).toEqual({ provider: "custom", model_id: "model-a" });
    const recordPath = path.join(root, ".account-models", `${createHash("sha256").update(OWNER).digest("hex")}.json`);
    const record = JSON.parse(await fs.readFile(recordPath, "utf8")) as { models: { models: Array<{ model_id: string }> } };
    expect(record.models.models.map((m) => m.model_id)).toEqual(["model-a", "model-b"]);
  });

  it("rejects a default pointer that names no configured model", async () => {
    await service.publishUserModelBlock(OWNER, { models: [modelA] });
    await expect(
      service.setUserDefaultModel(OWNER, { provider: "custom", modelId: "missing" }),
    ).rejects.toThrow(/included in models/);
  });

  it("resolves completeOnce's model from the account-global block, not the project TOML", async () => {
    // 项目 TOML 有一个可用模型；全局块的 default 指向一个没有条目的模型。
    // completeOnce 若读项目会去调用 SDK（网络），若读全局会立即返回 no_model 且文案含该 id。
    await service.writeRaw("p-owned", { models: [modelA], default_model: { provider: "custom", model_id: "model-a" } });
    await service.publishUserModelBlock(OWNER, {
      models: [modelA],
      default_model: { provider: "custom", model_id: "global-only-missing" },
    });
    const result = await service.completeOnce("p-owned", "test prompt");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.cause).toBe("no_model");
      expect(result.error).toContain("global-only-missing");
    }
  });
});
