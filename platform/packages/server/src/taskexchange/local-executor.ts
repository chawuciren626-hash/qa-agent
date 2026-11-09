/** Opt-in outbound task consumer. Credentials and execution receipts remain on this device. */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { Bind, Component, Interface, Use } from '@prismshadow/penguin-core/kernel';
import { userText } from '@prismshadow/penguin-core';
import type { AuthState, Config } from '../hmr/capabilities.js';
import type { Access } from '../mechanisms/projects.js';
import type { ScheduleSessionCreator, ScheduleTaskRunner } from '../runtime/scheduler.js';
import type { RunCanceller, RunOutcomeSource } from '../runtime/unattended/types.js';
import type { AppEnv } from '../auth/middleware.js';
import { readJson } from '../http/validate.js';
import { HttpError } from '../http/errors.js';

interface RemoteTask {
  taskId: string; deviceId: string; userId: string; projectRef: string; objective: string;
  status: string; cancelRequested: boolean; cancelVersion: number; deadlineMs: number | null;
}
interface Receipt {
  task: RemoteTask; epoch: number; createdAt: string; sessionId?: string;
  state: 'preparing' | 'dispatching' | 'running' | 'unknown' | 'settled';
  result?: 'succeeded' | 'failed'; reason?: string;
}
interface Binding {
  id: string; userId: string; origin: string; deviceId: string; token: string;
  projectRef: string; projectId: string; agentId: string; enabled: boolean;
  active?: Receipt; history: Receipt[];
}
export abstract class LocalExchangePolling extends Interface<{ start(): void; stop(): void }>() {}

@Component({ contributes: { 'HttpModule.routes': [{ id: 'LocalExchange.routes', prefix: '/api/local-exchange/v1', auth: 'user', order: 212 }] } })
export class LocalExchangeExecutor implements LocalExchangePolling {
  @Use() private readonly config!: Config;
  @Use() private readonly authState!: AuthState;
  @Use() private readonly access!: Access;
  @Use() private readonly creator!: ScheduleSessionCreator;
  @Use() private readonly runner!: ScheduleTaskRunner;
  @Use() private readonly outcomes!: RunOutcomeSource;
  @Use() private readonly canceller!: RunCanceller;
  @Bind('LocalExchange.routes') routes!: Hono<AppEnv>;
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  private stopped = false;
  private generation = 0;
  private bindings: Binding[] = [];
  private get file() { return path.join(this.config.root, 'exchange-local', 'bindings.json'); }

  setup({ effect }: { effect(hook: () => void): void }) {
    try { this.bindings = JSON.parse(fs.readFileSync(this.file, 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    for (const binding of this.bindings) {
      if (binding.active && ['preparing', 'dispatching'].includes(binding.active.state)) binding.active.state = 'unknown';
    }
    const app = new Hono<AppEnv>();
    app.get('/bindings', c => c.json({ bindings: this.bindings.filter(b => b.userId === c.var.user.userId).map(({ token, ...b }) => ({ ...b, tokenConfigured: !!token })) }));
    app.post('/bindings', async c => {
      if (process.env.AITEST_ACCOUNT_CENTER === '1') throw new HttpError(409, 'local_execution_required', '请在本机配置执行器。');
      const body = await readJson(c);
      const required = (key: string) => {
        const value = body[key];
        if (typeof value !== 'string' || !value.trim() || value.length > 2000) throw new HttpError(400, 'invalid_binding', `Invalid ${key}`);
        return value;
      };
      const origin = new URL(required('origin'));
      if (origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash ||
        (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname))))
        throw new HttpError(400, 'invalid_origin', '服务端地址必须使用 HTTPS（本机入口可使用 HTTP）。');
      const binding: Binding = { id: randomUUID(), userId: c.var.user.userId, origin: origin.origin,
        deviceId: required('deviceId'), token: required('deviceToken'), projectRef: required('projectRef'),
        projectId: required('projectId'), agentId: required('agentId'), enabled: true, history: [] };
      this.access.requireProjectOwner(binding.userId, binding.projectId);
      if (!this.authState.accountClient) throw new HttpError(409, 'account_required', '请先连接服务端账号。');
      await this.authState.accountClient.validateUser(binding.userId);
      const identity = await this.request(binding, '/identity', undefined);
      if (identity.userId !== binding.userId || identity.deviceId !== binding.deviceId) throw new HttpError(403, 'device_owner_mismatch', '设备必须属于当前用户。');
      if (this.bindings.some(b => b.origin === binding.origin && b.deviceId === binding.deviceId)) throw new HttpError(409, 'device_already_bound', '此设备已绑定。');
      this.bindings.push(binding); this.persist();
      return c.json({ id: binding.id, enabled: true }, 201);
    });
    app.delete('/bindings/:id', async c => {
      const binding = this.bindings.find(b => b.id === c.req.param('id') && b.userId === c.var.user.userId);
      if (!binding) throw new HttpError(404, 'binding_not_found', '绑定不存在。');
      binding.enabled = false;
      this.persist();
      if (binding.active?.sessionId) await this.canceller.cancel(binding.active.sessionId);
      return c.json({ enabled: false });
    });
    this.routes = app;
    effect(() => this.stop());
  }

  private persist() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${randomUUID()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.bindings), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
  start() {
    if (this.timer || process.env.AITEST_ACCOUNT_CENTER === '1') return;
    this.stopped = false;
    this.timer = setInterval(() => { void this.tickOnce(); }, 10_000);
    this.timer.unref?.();
  }
  stop() { this.stopped = true; this.generation++; if (this.timer) clearInterval(this.timer); this.timer = null; }
  private async request(binding: Binding, suffix: string, body: unknown): Promise<any> {
    const response = await fetch(`${binding.origin}/api/exchange/v1${suffix}`, {
      method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(8000),
      headers: { authorization: `Bearer ${binding.token}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) { await response.body?.cancel(); throw new HttpError(response.status, 'exchange_unavailable', '任务交换请求未成功。'); }
    return response.json();
  }
  async tickOnce() {
    if (this.busy || this.stopped || process.env.AITEST_ACCOUNT_CENTER === '1') return;
    this.busy = true;
    try {
      for (const binding of this.bindings) {
        if (!binding.enabled || this.stopped) continue;
        try { await this.advance(binding); }
        catch (error) {
          if (binding.active) { binding.active.reason = 'connection_or_authorization_unavailable'; this.persist(); }
          if (error instanceof HttpError && [401, 403].includes(error.status)) {
            if (binding.active?.sessionId) await this.canceller.cancel(binding.active.sessionId).catch(() => false);
          }
        }
      }
    } finally { this.busy = false; }
  }
  private async advance(binding: Binding) {
    const generation = this.generation;
    const live = () => !this.stopped && this.generation === generation && binding.enabled;
    const bridge = this.authState.accountClient;
    if (!bridge) return;
    await bridge.validateUser(binding.userId);
    this.access.requireProjectOwner(binding.userId, binding.projectId);
    let receipt = binding.active;
    if (!receipt) {
      const claim = await this.request(binding, '/claim', {});
      if (!claim.task) return;
      receipt = { task: claim.task, epoch: claim.lease.epoch, createdAt: new Date().toISOString(),
        state: claim.previousOutcomeUnknown ? 'unknown' : 'preparing' };
      binding.active = receipt; this.persist();
      if (receipt.task.deviceId !== binding.deviceId || receipt.task.userId !== binding.userId || receipt.task.projectRef !== binding.projectRef) {
        receipt.state = 'unknown'; receipt.reason = 'binding_mismatch'; this.persist(); return;
      }
      if (receipt.state === 'preparing' && live()) {
        try {
          await bridge.authorizeUserPath(binding.userId, `/api/projects/${encodeURIComponent(binding.projectId)}/agents/${encodeURIComponent(binding.agentId)}/sessions`, 'POST');
          const session = await this.creator.createSession({ projectId: binding.projectId, agentId: binding.agentId, userId: binding.userId, source: 'schedule', approvalMode: 'read-only' });
          receipt.sessionId = session.sessionId; this.persist();
          await bridge.authorizeSessionInvocation(binding.projectId, binding.agentId, session.sessionId);
          const fresh = await this.request(binding, `/tasks/${encodeURIComponent(receipt.task.taskId)}/heartbeat`, { leaseEpoch: receipt.epoch });
          receipt.task = fresh.task;
          if (!live() || receipt.task.cancelRequested || receipt.task.status === 'expired') return;
          await this.request(binding, `/tasks/${encodeURIComponent(receipt.task.taskId)}/status`, { leaseEpoch: receipt.epoch, status: 'running' });
          // Durable intent precedes the side effect; a restart will monitor, never resend.
          receipt.state = 'dispatching'; this.persist();
          if (!live()) return;
          await this.runner.startTask(session.sessionId, [userText(receipt.task.objective)], { queueIfBusy: false });
          receipt.state = 'running'; this.persist();
        } catch (error) {
          if (receipt.state === 'preparing') { receipt.result = 'failed'; receipt.reason = 'local_dispatch_refused'; }
          else { receipt.state = 'unknown'; receipt.reason = 'dispatch_outcome_unknown'; }
          this.persist();
          throw error;
        }
      }
    }
    const suffix = `/tasks/${encodeURIComponent(receipt.task.taskId)}`;
    const reply = await this.request(binding, `${suffix}/heartbeat`, { leaseEpoch: receipt.epoch });
    receipt.task = reply.task; this.persist();
    if (receipt.task.cancelRequested || receipt.task.status === 'expired') {
      const delivered = receipt.sessionId ? await this.canceller.cancel(receipt.sessionId) : receipt.state === 'preparing';
      if (receipt.task.status !== 'expired' && delivered) await this.request(binding, `${suffix}/status`, { leaseEpoch: receipt.epoch, ackCancelVersion: receipt.task.cancelVersion });
      if (receipt.task.status === 'expired' || delivered) this.finish(binding, receipt);
      return;
    }
    if (['succeeded', 'failed', 'cancelled'].includes(receipt.task.status)) { this.finish(binding, receipt); return; }
    if (!receipt.result && receipt.sessionId) receipt.result = (await this.outcomes.observe(receipt.sessionId, receipt.createdAt)) ?? undefined;
    if (receipt.result) {
      this.persist();
      await this.request(binding, `${suffix}/result`, { leaseEpoch: receipt.epoch, outcome: receipt.result,
        summary: { outcome: receipt.result, reason: receipt.reason ?? 'workflow_evidence_verified' }, evidenceIndex: {}, synthetic: false });
      this.finish(binding, receipt);
    }
  }
  private finish(binding: Binding, receipt: Receipt) {
    receipt.state = 'settled'; binding.history.push(receipt); binding.active = undefined; this.persist();
  }
}
