import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import { expect, it } from 'vitest';
import { knowledgeReceiverRoutes } from '../src/http/routes/knowledge-receiver.js';
import type { AppEnv } from '../src/auth/middleware.js';
import { HttpError } from '../src/http/errors.js';

it('persists confirmed bytes, rejects hash drift, isolates users and acknowledges deletion', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'knowledge-receiver-'));
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => { c.set('user', { userId: c.req.header('x-test-user') ?? 'owner' } as AppEnv['Variables']['user']); await next(); });
  app.onError((error, c) => c.json({ error: error.message }, error instanceof HttpError ? error.status as 400 : 500));
  app.route('/', knowledgeReceiverRoutes(root));
  const body = { projectId: 'p', uploadId: 'u1', attributionUserId: 'owner', recipient: 'remote_knowledge_service', dataScope: 'project_only',
    content: 'confirmed document', byteSize: 18, contentHash: createHash('sha256').update('confirmed document').digest('hex') };
  const post = (route: string, payload: unknown, user = 'owner') => app.request(route, { method: 'POST', headers: { 'content-type': 'application/json', 'x-test-user': user }, body: JSON.stringify(payload) });
  try {
    expect((await post('/copies', body)).status).toBe(200);
    expect((await post('/copies', body)).status).toBe(200);
    expect((await post('/copies', { ...body, content: 'changed' })).status).toBe(400);
    expect((await post('/copies', body, 'stranger')).status).toBe(403);
    const otherRemoval = await post('/copies/remove', body, 'stranger');
    expect(otherRemoval.status).toBe(200);
    const files = await fs.readdir(root, { recursive: true });
    expect(files.some(file => file.endsWith('u1.json'))).toBe(true);
    expect(await (await post('/copies/remove', body)).json()).toMatchObject({ deleted: true });
    expect((await fs.readdir(root, { recursive: true })).some(file => file.endsWith('u1.json'))).toBe(false);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
