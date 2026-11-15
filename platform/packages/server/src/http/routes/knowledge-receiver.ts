/** Authenticated service-side storage for explicitly confirmed project copies. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { Bind, Component, Use } from '@prismshadow/penguin-core/kernel';
import type { Config } from '../../hmr/capabilities.js';
import type { AppEnv } from '../../auth/middleware.js';
import { readJson } from '../validate.js';
import { HttpError } from '../errors.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export function knowledgeReceiverRoutes(root: string) {
  const app = new Hono<AppEnv>();
  const context = (userId: string, body: Record<string, unknown>) => {
    if (typeof body.projectId !== 'string' || typeof body.uploadId !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(body.uploadId))
      throw new HttpError(400, 'invalid_copy', '资料副本标识无效。');
    const dir = path.join(root, 'received-knowledge', hash(userId), hash(body.projectId));
    const file = path.join(dir, `${body.uploadId}.json`);
    return { dir, file, remoteRef: `knowledge-copy:${hash(userId)}:${hash(body.projectId)}:${body.uploadId}` };
  };
  app.post('/copies', async c => {
    const body = await readJson(c);
    const { dir, file, remoteRef } = context(c.var.user.userId, body);
    if (body.attributionUserId !== c.var.user.userId || body.recipient !== 'remote_knowledge_service' || body.dataScope !== 'project_only')
      throw new HttpError(403, 'copy_scope_mismatch', '资料副本归属或范围不一致。');
    if (typeof body.content !== 'string' || Buffer.byteLength(body.content) > 2 * 1024 * 1024 || Buffer.byteLength(body.content) !== body.byteSize || ![hash(body.content), `sha256:${hash(body.content)}`].includes(String(body.contentHash)))
      throw new HttpError(400, 'copy_hash_mismatch', '资料内容与确认的哈希或大小不一致。');
    await fs.mkdir(dir, { recursive: true });
    const tmp = `${file}.${randomUUID()}.tmp`;
    await fs.writeFile(tmp, JSON.stringify({ ...body, storedAt: new Date().toISOString() }), { mode: 0o600 });
    try {
      // A hard link publishes a complete file without replacing an existing receipt.
      await fs.link(tmp, file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const previous = JSON.parse(await fs.readFile(file, 'utf8'));
      if (previous.contentHash !== body.contentHash) throw new HttpError(409, 'copy_conflict', '同一上传标识已用于不同内容。');
    } finally { await fs.rm(tmp, { force: true }); }
    return c.json({ remoteRef });
  });
  app.post('/copies/remove', async c => {
    const body = await readJson(c);
    const { file, remoteRef } = context(c.var.user.userId, body);
    await fs.rm(file, { force: true });
    return c.json({ remoteRef, deleted: true });
  });
  return app;
}

@Component({ contributes: { 'HttpModule.routes': [{ id: 'KnowledgeReceiver.routes', prefix: '/api/knowledge-receiver/v1', auth: 'user', order: 213 }] } })
export class KnowledgeReceiverRoutes {
  @Use() private readonly config!: Config;
  @Bind('KnowledgeReceiver.routes') routes!: Hono<AppEnv>;
  setup() {
    const app = new Hono<AppEnv>();
    app.use('*', async (c, next) => {
      if (process.env.AITEST_ACCOUNT_CENTER !== '1') throw new HttpError(409, 'server_receiver_required', '请使用服务端资料接收地址。');
      await next();
    });
    app.route('/', knowledgeReceiverRoutes(this.config.root));
    this.routes = app;
  }
}
