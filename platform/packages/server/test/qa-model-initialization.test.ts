import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { wire } from "@prismshadow/penguin-core/kernel";
import type { AppEnv } from "../src/auth/middleware.js";
import type { Access } from "../src/mechanisms/projects.js";
import { userModelRoutes } from "../src/http/routes/user-models.js";
import { ProjectConfigService } from "../src/services/project-config-service.js";
import { makeTempRoot } from "./helpers.js";

vi.hoisted(() => vi.resetModules());
vi.mock("../src/services/qa-engine.js", () => ({ qaEnabled: true }));
const userId = "new-account";
const model = { provider: "custom", model_id: "my-model" };
let root: string;
let service: ProjectConfigService;
beforeEach(async () => {
  root = await makeTempRoot();
  service = wire(ProjectConfigService, { paths: { root } });
});
afterEach(async () => fs.rm(root, { recursive: true, force: true }));

it("does not pull any models from an accessible legacy project or the catalog", async () => {
  await service.writeRaw("legacy", { models: [model] });
  const accessibleProjectIds = vi.fn(() => ["legacy"]);
  const access = { accessibleProjectIds } as unknown as Access;
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("user", { userId, isAdmin: false, passwordHash: "", passwordIsInitial: false, displayName: null, avatar: null, createdAt: "" });
    await next();
  });
  app.route("/api/user-models", userModelRoutes({ root, access, projectConfigService: service }));
  const response = await app.request("/api/user-models");
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ models: [] });
  expect(accessibleProjectIds).not.toHaveBeenCalled();
  await service.publishUserModelBlock(userId, { models: [model] });
  expect(await (await app.request("/api/user-models")).json()).toMatchObject({
    models: [{ provider: "custom", modelId: "my-model" }],
  });
});

it("starts a QA project empty and does not backfill an adopted project", async () => {
  await service.writeInitialConfig("fresh", "Fresh", userId);
  const fresh = await service.readRaw("fresh");
  expect(fresh).toMatchObject({ name: "Fresh", models: [], command_policy: { rules: expect.any(Array) } });
  expect(fresh.default_model).toBeUndefined();
  expect(fresh.providers ?? {}).toEqual({});
  expect(await service.ensurePresetModels("fresh")).toBe(false);
  expect(await service.readRaw("fresh")).toEqual(fresh);
});

it("inherits only the project owner's published model configuration", async () => {
  await service.publishUserModelBlock(userId, { models: [model], default_model: model });
  const record = path.join(root, ".account-models", `${createHash("sha256").update(userId).digest("hex")}.json`);
  expect((await fs.stat(record)).isFile()).toBe(true);
  await service.writeInitialConfig("owned", "Owned", userId);
  expect(await service.readRaw("owned")).toMatchObject({ models: [model], default_model: model });
  await service.writeInitialConfig("other", "Other", "another-account");
  expect((await service.readRaw("other")).models).toEqual([]);
});
