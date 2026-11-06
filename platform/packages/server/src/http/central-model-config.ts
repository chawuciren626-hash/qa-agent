/** Administrator model catalogue. The original model service owns validation/credential
 * merging; this adapter stores its complete configuration in SQLite, encrypted at rest. */
import fs from "node:fs";
import path from "node:path";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { projectConfigFromTable } from "@prismshadow/penguin-core";
import { atomicWriteFile, renderProjectConfigToml } from "@prismshadow/penguin-core";
import { parse as parseToml } from "smol-toml";
import { ProjectConfigService, type RawTable } from "../services/project-config-service.js";
import type { ModelPromotion } from "../mechanisms/projects.js";
import type { AppEnv } from "../auth/middleware.js";
import { HttpError } from "./errors.js";
import { modelsRoutes } from "./routes/models.js";

export const CENTRAL_MODEL_CATALOG_ID = "central-model-catalog";
interface CatalogDocument { raw: RawTable; promotions: ModelPromotion[]; modelScopeToken?: unknown }

export class CentralModelConfig extends ProjectConfigService {
  private readonly key: Buffer;
  /** Core sessions still load TOML. Refresh only the model block from the authoritative DB. */
  async syncAssistantRuntime(root: string): Promise<void> {
    const document = this.document();
    if (!Array.isArray(document.raw.models)) return;
    const file = path.join(root, "admin_agent_catalog", ".project_config.toml");
    if (!fs.existsSync(file)) return;
    const before = fs.readFileSync(file, "utf8");
    const raw = parseToml(before) as RawTable;
    for (const key of ["models", "providers", "default_model", "vision_model"]) {
      if (document.raw[key] === undefined) delete raw[key];
      else raw[key] = document.raw[key];
    }
    const after = renderProjectConfigToml(raw);
    if (after !== before) await atomicWriteFile(file, after, { mode: 0o600 });
  }
  constructor(private readonly db: DatabaseSync, root?: string) {
    super();
    db.exec(`CREATE TABLE IF NOT EXISTS central_model_config(id INTEGER PRIMARY KEY CHECK(id=1), ciphertext TEXT NOT NULL, updated_at TEXT NOT NULL)`);
    if (!root) {
      if (db.prepare("SELECT 1 FROM central_model_config").get()) throw Error("Central model encryption key root missing");
      this.key = randomBytes(32);
    } else {
      const file = path.join(root, "central-model-config.key");
      const stat = fs.lstatSync(file, { throwIfNoEntry: false });
      if (!stat) {
        if (db.prepare("SELECT 1 FROM central_model_config").get()) throw Error("Central model encryption key missing");
        fs.mkdirSync(root, { recursive: true });
        fs.writeFileSync(file, randomBytes(32).toString("base64"), { flag: "wx", mode: 0o600 });
      } else if (!stat.isFile() || stat.isSymbolicLink()) throw Error("Unsafe central model key path");
      this.key = Buffer.from(fs.readFileSync(file, "utf8").trim(), "base64");
      if (this.key.length !== 32) throw Error("Invalid central model encryption key");
    }
    this.promotions = {
      list: () => this.document().promotions,
      get: (_id, provider, modelId) => this.document().promotions.find(p => p.provider === provider && p.modelId === modelId)?.discount,
      replaceAll: (_id, rows) => this.save({ ...this.document(), promotions: [...rows] }),
      replaceProvider: (_id, provider, rows) => this.save({ ...this.document(), promotions: [...this.document().promotions.filter(p => p.provider !== provider), ...rows] }),
    };
  }
  private document(): CatalogDocument {
    const row = this.db.prepare("SELECT ciphertext FROM central_model_config WHERE id=1").get() as { ciphertext: string } | undefined;
    if (!row) return { raw: {}, promotions: [] };
    const bytes = Buffer.from(row.ciphertext, "base64");
    const cipher = createDecipheriv("aes-256-gcm", this.key, bytes.subarray(0, 12));
    cipher.setAAD(Buffer.from(CENTRAL_MODEL_CATALOG_ID));
    cipher.setAuthTag(bytes.subarray(12, 28));
    return JSON.parse(Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString("utf8"));
  }
  private save(value: CatalogDocument): void {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    cipher.setAAD(Buffer.from(CENTRAL_MODEL_CATALOG_ID));
    const bytes = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
    const sealed = Buffer.concat([nonce, cipher.getAuthTag(), bytes]).toString("base64");
    this.db.prepare("INSERT INTO central_model_config VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET ciphertext=excluded.ciphertext,updated_at=excluded.updated_at").run(sealed, new Date().toISOString());
  }
  override async readRaw(_id: string): Promise<RawTable> { return this.document().raw; }
  /** Remove one group atomically, including credentials, promotions and dangling defaults. */
  async deleteProvider(provider: string) {
    if (!provider || provider.length > 200) throw new HttpError(400, "invalid_provider", "渠道商标识无效。");
    const document = this.document();
    const raw = document.raw;
    const models = (Array.isArray(raw.models) ? raw.models : []) as RawTable[];
    const providers = { ...(raw.providers as RawTable ?? {}) };
    if (!models.some(model => model.provider === provider) && !Object.hasOwn(providers, provider))
      throw new HttpError(404, "provider_not_found", "渠道商已不存在，请刷新列表。");
    delete providers[provider];
    const next: RawTable = { ...raw, models: models.filter(model => model.provider !== provider), providers };
    for (const key of ["default_model", "vision_model"]) {
      if ((next[key] as RawTable | undefined)?.provider === provider) delete next[key];
    }
    this.save({ ...document, raw: next, promotions: document.promotions.filter(item => item.provider !== provider) });
    return this.getModels(CENTRAL_MODEL_CATALOG_ID);
  }
  override async writeRaw(_id: string, raw: RawTable): Promise<void> { this.save({ ...this.document(), raw }); }
  override async loadConfig(id: string) { return projectConfigFromTable("central-model-config", await this.readRaw(id)); }
  protected override async configUpdatedAt(_id: string) {
    return (this.db.prepare("SELECT updated_at FROM central_model_config WHERE id=1").get() as { updated_at: string } | undefined)?.updated_at;
  }
  /** One-time migration, never an overwrite of an administrator's later changes. */
  async importAccount(value: unknown) {
    if (this.db.prepare("SELECT 1 FROM central_model_config").get()) throw new HttpError(409, "catalog_exists", "模型配置已迁移，不能重复覆盖。");
    const record = value as { models?: RawTable; promotions?: ModelPromotion[]; modelScopeToken?: unknown };
    if (!record || !record.models || !Array.isArray(record.models.models) || !record.models.models.length || !Array.isArray(record.promotions)) throw new HttpError(400, "invalid_catalog", "模型迁移数据不完整。");
    projectConfigFromTable("central-model-config", record.models);
    this.save({ raw: record.models, promotions: record.promotions, modelScopeToken: record.modelScopeToken });
    return this.getModels(CENTRAL_MODEL_CATALOG_ID);
  }
}

export function centralModelConfigRoutes(service: CentralModelConfig): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    if (!c.var.user?.isAdmin) throw new HttpError(403, "admin_required", "仅管理员可以管理模型配置。");
    await next();
  });
  app.post("/import", async c => c.json(await service.importAccount(await c.req.json())));
  app.delete("/:projectId/providers/:provider", async c => {
    if (c.req.param("projectId") !== CENTRAL_MODEL_CATALOG_ID) throw new HttpError(404, "catalog_not_found", "模型配置不存在。");
    return c.json(await service.deleteProvider(c.req.param("provider")));
  });
  app.all("/:projectId/authorization/*", () => {
    throw new HttpError(501, "catalog_authorization_unavailable", "服务端尚未接入渠道商网页登录授权；请在原渠道设置窗口填写 API Key 和地址。");
  });
  const check = (_user: string, id: string) => {
    if (id !== CENTRAL_MODEL_CATALOG_ID) throw new HttpError(404, "catalog_not_found", "模型配置不存在。");
  };
  app.route("/:projectId", modelsRoutes({ catalog: true, projectConfigService: service, access: { requireProjectAccess: check, requireProjectOwner: check } }));
  return app;
}
