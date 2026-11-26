import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { AmspRecord } from "@prismshadow/penguin-core";
import { HttpError } from "../http/errors.js";

export const LOCAL_EXECUTION_PROTOCOL = 1;
const LEASE_MS = 20_000;
const MAX_PENDING = 32;
const MAX_EVENTS = 256;
const MAX_EVENT_BYTES = 4 * 1024 * 1024;
export interface ExecutionClient {
  clientId: string;
  platform: string;
  node: string;
  python: string;
  engine: string;
  workspaces: string;
}
interface Client extends ExecutionClient { userId: string; proof: Buffer; seenAt: number }
export interface ExecutionJob {
  id: string;
  sessionId: string;
  payload: unknown;
}
interface Pending {
  clientId: string;
  userId: string;
  job: ExecutionJob;
  state: "queued" | "delivered";
  deliveredAt?: number;
  acknowledged?: boolean;
  events: AmspRecord[];
  bytes: number;
  sequence: number;
  done: boolean;
  error?: string;
  wake?: () => void;
  controls: unknown[];
}
interface Binding { clientId: string; userId: string }
export interface BindingStore {
  get(sessionId: string): Binding | null;
  set(sessionId: string, binding: Binding): void;
  getClient?(clientId: string): { userId: string; proofHash: string } | null;
  setClient?(clientId: string, identity: { userId: string; proofHash: string }): void;
}

/** Reverse, account-scoped transport. Delivered jobs are never replayed after a lost connection. */
export class LocalExecutionBroker {
  private clients = new Map<string, Client>();
  private jobs = new Map<string, Pending>();
  constructor(private readonly bindings: BindingStore, private readonly now: () => number = Date.now) {}

  register(userId: string, proof: string, info: ExecutionClient): void {
    if (!/^[a-f0-9-]{36}$/.test(info.clientId) || !/^[a-f0-9]{64}$/.test(proof))
      throw new HttpError(400, "invalid_execution_client", "执行端身份无效");
    for (const value of [info.platform, info.node, info.python, info.engine, info.workspaces])
      if (typeof value !== "string" || !value || value.length > 4096) throw new HttpError(400, "invalid_execution_client", "执行端环境信息无效");
    const existing = this.clients.get(info.clientId);
    const digest = createHash("sha256").update(proof).digest();
    const saved = this.bindings.getClient?.(info.clientId);
    if (saved && (saved.userId !== userId || saved.proofHash !== digest.toString("hex")))
      throw new HttpError(403, "execution_client_denied", "执行端持久身份不匹配");
    if (existing && (existing.userId !== userId || !timingSafeEqual(existing.proof, digest)))
      throw new HttpError(409, "execution_client_conflict", "执行端已绑定其他登录会话，请重新打开客户端");
    this.clients.set(info.clientId, { ...info, userId, proof: digest, seenAt: this.now() });
    this.bindings.setClient?.(info.clientId, { userId, proofHash: digest.toString("hex") });
  }

  authenticate(userId: string, clientId: string, proof: string): ExecutionClient {
    const client = this.clients.get(clientId);
    const digest = createHash("sha256").update(proof).digest();
    if (!client || client.userId !== userId || !timingSafeEqual(client.proof, digest))
      throw new HttpError(403, "execution_client_denied", "本机执行端鉴权失败");
    return this.info(client);
  }

  private info(client: Client): ExecutionClient {
    const { clientId, platform, node, python, engine, workspaces } = client;
    return { clientId, platform, node, python, engine, workspaces };
  }

  bind(sessionId: string, userId: string, clientId: string, proof: string): ExecutionClient {
    const info = this.authenticate(userId, clientId, proof);
    const old = this.bindings.get(sessionId);
    if (old && (old.userId !== userId || old.clientId !== clientId))
      throw new HttpError(409, "execution_session_bound", "该会话已绑定其他客户端，请在原客户端继续或新建会话");
    this.bindings.set(sessionId, { userId, clientId });
    return info;
  }

  binding(sessionId: string): Binding | null { return this.bindings.get(sessionId); }

  inherit(parent: string, child: string): void {
    const binding = this.binding(parent);
    if (!binding) return;
    const old = this.binding(child);
    if (old && (old.userId !== binding.userId || old.clientId !== binding.clientId))
      throw new HttpError(409, "execution_session_bound", "子会话执行端与父会话不一致");
    this.bindings.set(child, binding);
  }

  environment(sessionId: string): ExecutionClient | null {
    const binding = this.binding(sessionId);
    if (!binding) return null;
    const client = this.clients.get(binding.clientId);
    if (!client || client.userId !== binding.userId || this.now() - client.seenAt > LEASE_MS)
      throw new HttpError(409, "local_executor_offline", "本机执行端已离线，请保持原客户端运行；不会改到服务端执行");
    return this.info(client);
  }

  poll(userId: string, clientId: string, proof: string, active: string[] = []): { jobs: ExecutionJob[]; cancelled: string[]; controls: { jobId: string; value: unknown }[] } {
    this.authenticate(userId, clientId, proof);
    this.clients.get(clientId)!.seenAt = this.now();
    const jobs: ExecutionJob[] = [];
    const controls: { jobId: string; value: unknown }[] = [];
    for (const pending of this.jobs.values()) {
      if (pending.clientId !== clientId || pending.userId !== userId || pending.done) continue;
      if (pending.state === "queued") { pending.state = "delivered"; pending.deliveredAt = this.now(); jobs.push(pending.job); }
      else if (active.includes(pending.job.id)) pending.acknowledged = true;
      else if (this.now() - pending.deliveredAt! > 10_000) {
        pending.done = true;
        pending.error = pending.acknowledged ? "本机执行请求意外结束，请检查产物后再继续" : "执行请求未收到本机确认，已停止；不会自动重放操作";
        pending.wake?.();
      }
      for (const value of pending.controls.splice(0)) controls.push({ jobId: pending.job.id, value });
    }
    return { jobs, cancelled: active.filter(id => !this.jobs.has(id)), controls };
  }

  control(jobId: string, value: unknown): void {
    const job = this.jobs.get(jobId);
    if (job && !job.done) job.controls.push(value);
  }

  /** Deliver a control value to the currently queued detached job for a session. */
  controlSession(sessionId: string, value: unknown): void {
    for (const pending of this.jobs.values()) {
      if (pending.job.sessionId === sessionId && !pending.done) pending.controls.push(value);
    }
  }

  accept(userId: string, clientId: string, proof: string, jobId: string,
    response: { sequence: number; events: AmspRecord[]; done: boolean; error?: string }): void {
    this.authenticate(userId, clientId, proof);
    const pending = this.jobs.get(jobId);
    if (!pending || pending.userId !== userId || pending.clientId !== clientId || pending.state !== "delivered" || pending.done)
      throw new HttpError(409, "execution_job_expired", "执行请求已结束或不属于当前执行端");
    pending.acknowledged = true;
    if (!Number.isSafeInteger(response.sequence) || response.sequence < 0) throw new HttpError(400, "execution_event_order", "执行回执顺序无效");
    if (response.sequence < pending.sequence) return; // acknowledged batch retried after a lost HTTP response
    if (response.sequence !== pending.sequence || !Array.isArray(response.events) || response.events.length > MAX_EVENTS)
      throw new HttpError(400, "execution_event_order", "执行回执顺序无效");
    const bytes = Buffer.byteLength(JSON.stringify(response.events));
    if (bytes + pending.bytes > MAX_EVENT_BYTES || pending.events.length + response.events.length > MAX_EVENTS)
      throw new HttpError(413, "execution_output_limit", "执行输出超过传输窗口");
    pending.events.push(...response.events);
    pending.bytes += response.events.reduce((sum, event) => sum + Buffer.byteLength(JSON.stringify(event)), 0);
    pending.sequence++;
    pending.done = response.done === true;
    if (response.error) pending.error = String(response.error).slice(0, 2000);
    pending.wake?.();
  }

  async *execute(sessionId: string, payload: unknown, signal?: AbortSignal): AsyncGenerator<AmspRecord> {
    const info = this.environment(sessionId);
    const binding = this.binding(sessionId);
    if (!info || !binding) throw new Error("No local executor binding");
    if (this.jobs.size >= MAX_PENDING) throw new Error("本机执行请求队列已满");
    const job: ExecutionJob = { id: randomUUID(), sessionId, payload };
    const pending: Pending = { clientId: info.clientId, userId: binding.userId, job,
      state: "queued", events: [], bytes: 0, sequence: 0, done: false, controls: [] };
    this.jobs.set(job.id, pending);
    try {
      for (;;) {
        signal?.throwIfAborted();
        this.environment(sessionId);
        while (pending.events.length) {
          const event = pending.events.shift()!;
          pending.bytes -= Buffer.byteLength(JSON.stringify(event));
          yield event;
        }
        if (pending.error) throw new Error(pending.error);
        if (pending.done) return;
        await new Promise<void>(resolve => {
          const timer = setTimeout(done, 500);
          function done() { clearTimeout(timer); signal?.removeEventListener("abort", done); resolve(); }
          pending.wake = done;
          signal?.addEventListener("abort", done, { once: true });
        });
      }
    } finally { this.jobs.delete(job.id); }
  }
}
