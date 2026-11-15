import { Hono } from 'hono';
import { Bind, Component, Use } from '@prismshadow/penguin-core/kernel';
import type { DatabaseSync } from 'node:sqlite';
import type { AuthState, Config, Db } from '../../hmr/capabilities.js';
import type { AppEnv } from '../../auth/middleware.js';
import { ConnectorService, ConnectorError } from '../../connectors/service.js';
import { TrustedPluginStore } from '../../plugins/store.js';
import { HttpError } from '../errors.js';
import { readJson } from '../validate.js';
import { buildInfo } from '@prismshadow/penguin-core';

@Component({ contributes: { 'HttpModule.routes': [{ id: 'LocalCapabilities.routes', prefix: '/api/local-capabilities/v1', auth: 'user', order: 214 }] } })
export class LocalCapabilitiesRoutes {
  @Use() private readonly db!: Db;
  @Use() private readonly config!: Config;
  @Use() private readonly authState!: AuthState;
  @Bind('LocalCapabilities.routes') routes!: Hono<AppEnv>;
  setup() {
    const service = new ConnectorService({ db: this.db as unknown as DatabaseSync, dataRoot: this.config.root, authorizer: {
      beginInvocation: async (...args) => {
        const bridge = this.authState.accountClient;
        if (!bridge) throw new HttpError(503, 'authorization_unavailable', '连接器调用需要在线账号授权。');
        return bridge.beginInvocation(...args);
      },
    } });
    const store = new TrustedPluginStore(this.db as unknown as DatabaseSync, { dataRoot: this.config.root, serverVersion: buildInfo().version });
    const app = new Hono<AppEnv>();
    app.use('*', async (c, next) => {
      await this.authState.accountClient?.authorizeUserPath(c.var.user.userId, '/api/plugins', c.req.method);
      try { await next(); } catch (error) {
        if (error instanceof ConnectorError) throw new HttpError(error.status, error.code, error.message);
        throw error;
      }
    });
    app.get('/connectors', c => c.json({ connectors: service.list(c.var.user.userId), executionLocation: process.env.AITEST_ACCOUNT_CENTER === '1' ? 'server' : 'local' }));
    app.post('/connectors', async c => {
      const body = await readJson(c);
      if (body.kind !== 'http' && body.kind !== 'local-test') throw new HttpError(400, 'invalid_kind', '连接器类型无效。');
      return c.json(service.create(c.var.user.userId, { name: String(body.name ?? ''), kind: body.kind,
        ...(typeof body.projectId === 'string' ? { projectId: body.projectId } : {}), recipient: String(body.recipient ?? '') }), 201);
    });
    app.put('/connectors/:id/credential', async c => {
      const body = await readJson(c);
      return c.json(service.setCredential(c.var.user.userId, c.req.param('id'), String(body.secret ?? '')));
    });
    app.put('/connectors/:id', async c => {
      const body = await readJson(c);
      if (typeof body.enabled !== 'boolean') throw new HttpError(400, 'invalid_enabled', '请指定启用状态。');
      return c.json(service.update(c.var.user.userId, c.req.param('id'), { enabled: body.enabled }));
    });
    app.delete('/connectors/:id', c => c.json(service.revoke(c.var.user.userId, c.req.param('id'))));
    app.post('/connectors/:id/invoke', async c => {
      const body = await readJson(c);
      const connector = service.get(c.var.user.userId, c.req.param('id'));
      return c.json(await service.invoke({ userId: c.var.user.userId, projectId: connector.projectId }, connector.connectorId, {
        toolName: String(body.toolName ?? ''), payload: body.payload && typeof body.payload === 'object' && !Array.isArray(body.payload) ? body.payload as Record<string, unknown> : {},
      }));
    });
    app.get('/connectors/audit/log', c => c.json({ audit: service.auditLog(c.var.user.userId) }));
    app.get('/plugins', c => c.json({ versions: store.listVersions().map(version => ({ ...version,
      executionStatus: 'runtime_adapter_required', activeVersion: store.activeVersion(version.pluginId) })) }));
    app.post('/plugins', async c => {
      if (!c.var.user.isAdmin) throw new HttpError(403, 'admin_required', '仅管理员可以导入宿主插件包。');
      const body = await readJson(c);
      return c.json(await store.install(String(body.archiveBase64 ?? '')));
    });
    this.routes = app;
  }
}
