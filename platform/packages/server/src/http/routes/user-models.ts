/**
 * User-scoped model configuration — the WorkBuddy-shaped settings page's own endpoint.
 *
 * 为什么单独一套：WorkBuddy 的模型配置是"一份用户级配置文件"，不挂在任何项目上；本产品的项目
 * 模型配置（`/api/projects/:p/models`）虽然能力齐全，但写入要求调用者是项目 owner——没建项目的
 * 用户就配不了模型，与"设置里的模型配置人人可用"矛盾。所以这里把**同一份数据结构**（providers /
 * models / default_model / vision_model + promotions）存进按用户的全局记录
 * `<root>/.account-models/<sha256(userId)>.json`（与共享模型机制同一份文件），再由
 * publishSharedModels 同步到该用户名下所有项目（含将来新建的项目）。
 *
 * 不依赖项目意味着：
 * - 读：直接读用户记录；没有记录时回退到该用户任一可访问项目的模型块（首次打开就有内容），
 *   再没有就回退内置种子（presetProjectConfig），保证页面永远有东西可看。
 * - 写：先把变更应用到"用户记录"，再同步到该用户名下的项目；没有项目时只写用户记录，
 *   建第一个项目时 project-service 的 writeInitialConfig 会自动继承。
 * - 凭证（api_key）与项目级一致：只写不读，响应里掩码。
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { Bind, Component, Use } from "@prismshadow/penguin-core/kernel";
import { Hono } from "hono";
import type { AppEnv } from "../../auth/middleware.js";
import { Config } from "../../hmr/capabilities.js";
import { badRequest, readJson } from "../validate.js";
import type { Access } from "../../mechanisms/projects.js";
import type { ProjectConfigStore } from "../../mechanisms/projects.js";
import type { RawTable } from "../../services/project-config-service.js";
import { presetProjectConfig } from "../../services/project-config-seed.js";

/** One user's stored model block, versioned so a future shape change can migrate instead of guess. */
interface UserModelRecord {
  version: 1;
  userId: string;
  updatedAt: string;
  models: RawTable;
}

export interface UserModelRoutesDeps {
  /** Data root; the account-model file lives under `.account-models/`. */
  root: string;
  projectConfigService: ProjectConfigStore;
  access: Access;
}

const recordPath = (root: string, userId: string): string =>
  path.join(root, ".account-models", `${createHash("sha256").update(userId).digest("hex")}.json`);

/** 读取用户级模型记录（含 legacy ownerUserId 共享记录兼容）；无记录返回 null。 */
export async function readUserModelRecord(root: string, userId: string): Promise<UserModelRecord | null> {
  let text: string;
  try {
    text = await fs.readFile(recordPath(root, userId), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const parsed = JSON.parse(text) as UserModelRecord & { sourceProjectId?: string };
  if (parsed.version !== 1 || parsed.userId !== userId || parsed.models === undefined) {
    // 兼容旧共享记录（字段是 ownerUserId）：同一份文件，格式不同只影响本用户自己的模型页。
    const legacy = JSON.parse(text) as { ownerUserId?: string; models?: RawTable };
    if (legacy.ownerUserId === userId && legacy.models !== undefined) {
      return { version: 1, userId, updatedAt: new Date().toISOString(), models: legacy.models };
    }
    throw new Error("Invalid user model configuration");
  }
  return parsed;
}

const optRefLocal = (v: unknown): { provider: string; modelId: string } | undefined => {
  if (!v || typeof v !== "object") return undefined;
  const t = v as Record<string, unknown>;
  const provider = typeof t.provider === "string" && t.provider.trim() ? t.provider.trim() : undefined;
  const modelId = typeof t.model_id === "string" && t.model_id.trim() ? t.model_id.trim() : undefined;
  return provider && modelId ? { provider, modelId } : undefined;
};

/**
 * 账号级模型解析（后台建会话用，与聊天页模型选择器同源）：default_model 优先，
 * 未设默认时回退第一个条目；用户没有模型记录或记录为空返回 undefined。
 */
export async function readUserModelRef(
  root: string,
  userId: string,
): Promise<{ provider: string; modelId: string } | undefined> {
  const record = await readUserModelRecord(root, userId);
  const block = record?.models as Record<string, unknown> | undefined;
  if (!block) return undefined;
  const fromDefault = optRefLocal(block.default_model);
  if (fromDefault) return fromDefault;
  const first = Array.isArray(block.models) ? (block.models as unknown[])[0] : undefined;
  return optRefLocal(first);
}

export function userModelRoutes(deps: UserModelRoutesDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  const readRecord = async (userId: string): Promise<UserModelRecord | null> =>
    readUserModelRecord(deps.root, userId);

  /** The project whose model block this user's record was first seeded from (any accessible one). */
  const seedFromProject = async (userId: string): Promise<RawTable | null> => {
    for (const projectId of deps.access.accessibleProjectIds(userId)) {
      try {
        const raw = await deps.projectConfigService.readRaw(projectId);
        if (Array.isArray(raw.models)) return raw;
      } catch {
        /* 该项目配置不可读：继续找下一个，最后退回种子 */
      }
    }
    return null;
  };

  /** Read: user record → accessible project block → built-in seed. Same view as the project page. */
  app.get("/", async (c) => {
    const userId = c.var.user.userId;
    const record = await readRecord(userId);
    const raw = record?.models ?? (await seedFromProject(userId)) ?? (presetProjectConfig() as unknown as RawTable);
    return c.json(await deps.projectConfigService.modelViewOfRaw(raw));
  });

  /**
   * Write: replace the user's model block, then publish it to the user's projects.
   * Body: { models: [...], providers?: {...}, defaultModel?: {...} } — the same entry shape the
   * project-level PUT takes; validation is delegated to the project service by applying the
   * same request to one of the user's projects when there is one.
   */
  app.put("/", async (c) => {
    const userId = c.var.user.userId;
    const body = await readJson(c);
    if (!Array.isArray(body.models)) throw badRequest("models must be an array.");
    const owned = deps.access
      .accessibleProjectIds(userId)
      .filter((id) => deps.access.find(userId, id)?.role === "owner");
    const target = owned[0];
    if (target !== undefined) {
      // 有项目：走项目级同一套校验（updateModels 只改项目 TOML，不会自己发布共享记录），
      // 再显式 publishSharedModels(activate=true) 把结果写成该用户的共享配置并同步其余项目。
      await deps.projectConfigService.updateModels(target, body as never);
      await deps.projectConfigService.publishSharedModels(target, true);
      return c.json(await deps.projectConfigService.modelViewOfRaw(
        (await deps.projectConfigService.readRaw(target)) as RawTable,
      ));
    }
    // 没有可写的项目：直接把配置发布成该用户的**共享模型记录**（就是新建项目要继承的那份），
    // 字段名归一到 TOML 形（model_id / display_name …），并与项目路径共用同一套 schema。
    const block = deps.projectConfigService.userModelBlockOf(body as never) as RawTable;
    await deps.projectConfigService.publishUserModelBlock(userId, block);
    return c.json(await deps.projectConfigService.modelViewOfRaw(block));
  });

  return app;
}

/**
 * 注册到 `/api/user-models`（登录用户即可，不需要管理员或项目）。
 * 挂载点选在 `/api` 下、`/api/projects/*` 之外，所以不触发账号中心的项目/会话守卫。
 */
@Component({
  contributes: {
    "HttpModule.routes": [
      {
        id: "UserModelRoutes.routes",
        prefix: "/api/user-models",
        auth: "user",
        order: 12,
      },
    ],
  },
})
export class UserModelRoutes {
  @Use() private readonly config!: Config;
  @Use() private readonly projectConfig!: ProjectConfigStore;
  @Use() private readonly access!: Access;
  @Bind("UserModelRoutes.routes") routes!: Hono<AppEnv>;
  setup() {
    this.routes = userModelRoutes({
      root: this.config.root,
      projectConfigService: this.projectConfig,
      access: this.access,
    });
  }
}
