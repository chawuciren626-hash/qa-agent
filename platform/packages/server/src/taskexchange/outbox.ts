/**
 * OutboxDispatcher: DELIVERY of terminal statuses/callbacks — the only thing that ever
 * leaves through the exchange, retried independently of execution.
 *
 * - Retries re-SEND a row (its own idempotency key: `callback:<taskId>:terminal`); they
 *   never re-run a task.
 * - Every attempt re-validates the target (the guard runs at set-time AND per attempt);
 *   redirects are followed MANUALLY, one hop at a time, each hop re-validated, so a public
 *   URL cannot bounce into the intranet.
 * - Backoff: 30s doubling, capped at 1h; abandoned after max attempts with the last error
 *   recorded. Nothing is deleted: the outbox is the delivery audit.
 * - The same tick sweeps exchange tasks past their deadline to `expired` (the service owns
 *   the semantics; this is just the heartbeat).
 *
 * The HTTP client is injectable (`fetchImpl`) so tests drive delivery without a port; the
 * fetch returns manual redirects as hops. The scheduler is started by Startup in
 * production; the test tree leaves it stopped unless a scenario starts it.
 */
import { Component, Use } from "@prismshadow/penguin-core/kernel";
import type {
  ExchangeOutboxScheduler,
  ExchangeTasks,
  TaskExchangeStore,
} from "../mechanisms/taskexchange.js";
import { OUTBOX_BASE_BACKOFF_MS, OUTBOX_MAX_ATTEMPTS, OUTBOX_MAX_BACKOFF_MS } from "./service.js";
import { checkCallbackUrl, guardedCallbackFetch } from "./ssrf.js";

/** One fetch hop: POST the payload, follow nothing (the dispatcher drives hops). */
export type OutboxFetch = (
  url: string,
  init: { method: "POST"; headers: Record<string, string>; body: string; redirect: "manual"; signal: AbortSignal },
) => Promise<{ status: number; location?: string | null }>;

@Component()
export class OutboxDispatcher implements ExchangeOutboxScheduler {
  @Use() private readonly store!: TaskExchangeStore;
  @Use() private readonly service!: ExchangeTasks;
  /** Injectable for tests; production uses global fetch with manual redirects. */
  fetchImpl: OutboxFetch | null = null;
  /** The admin allowlist is read per tick (cheap) so a new approval applies without a restart. */
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  private controller = new AbortController();
  intervalMs = 15_000;
  /** Injectable test clock (the house pattern: wire({ nowMs: () => controlled })). */
  nowMs(): number {
    return Date.now();
  }

  setup({ effect }: { effect(hook: () => void): void }): void {
    // Same lifetime as the App: the heartbeat dies with the tree that owns it.
    effect(() => this.stop());
  }

  start(): void {
    if (this.timer !== null) return;
    this.controller = new AbortController();
    this.timer = setInterval(() => {
      void this.tickOnce();
    }, this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.controller.abort();
  }

  async tickOnce(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const nowMs = this.nowMs();
      const nowIso = new Date(nowMs).toISOString();
      this.service.sweepExpired(nowMs);
      const allowed = new Set(this.store.listAllowedHosts().map((h) => h.host));
      for (const row of this.store.listDueOutbox(nowIso)) {
        if (this.controller.signal.aborted) break;
        await this.deliver(row, allowed, nowMs);
      }
    } finally {
      this.ticking = false;
    }
  }

  private async deliver(row: { outboxId: string }, allowed: ReadonlySet<string>, nowMs: number): Promise<void> {
    const full = this.store.listDueOutbox(new Date(nowMs).toISOString()).find((r) => r.outboxId === row.outboxId);
    if (!full) return;
    // Re-validate the target on every attempt (an allowlist revocation applies to pending rows).
    const verdict = checkCallbackUrl(full.targetUrl, { allowedHosts: allowed });
    if (!verdict.ok) {
      this.store.markOutboxAttempt(
        full.outboxId,
        full.attempts + 1,
        new Date(nowMs).toISOString(),
        `${verdict.reason}${verdict.detail ? `: ${verdict.detail}` : ""}`,
        "abandoned",
        new Date(nowMs).toISOString(),
      );
      return;
    }
    const fetchImpl: OutboxFetch = this.fetchImpl ?? ((url, init) => guardedCallbackFetch(url, init, allowed));
    const signal = AbortSignal.any([this.controller.signal, AbortSignal.timeout(15_000)]);
    let hopUrl: URL = verdict.url;
    try {
      // One POST; a 3xx is a manual hop, re-validated before the next POST.
      for (let hop = 0; hop < 3; hop += 1) {
        const res = await fetchImpl(hopUrl.toString(), {
          method: "POST",
          headers: { "content-type": "application/json", "x-exchange-delivery": full.idempotencyKey },
          body: JSON.stringify(full.payload),
          redirect: "manual",
          signal,
        });
        if (res.status >= 200 && res.status < 300) {
          this.store.markOutboxDelivered(full.outboxId, full.attempts + 1, new Date(nowMs).toISOString());
          return;
        }
        if (res.status >= 300 && res.status < 400 && res.location) {
          const next = checkCallbackUrl(new URL(res.location, hopUrl).toString(), { allowedHosts: allowed });
          if (!next.ok || next.url.origin !== verdict.url.origin) {
            this.store.markOutboxAttempt(
              full.outboxId,
              full.attempts + 1,
              new Date(nowMs).toISOString(),
              `redirect_refused: ${next.ok ? 'origin_changed' : next.reason}`,
              "abandoned",
              new Date(nowMs).toISOString(),
            );
            return;
          }
          hopUrl = next.url;
          continue;
        }
        throw new Error(`HTTP ${res.status}`);
      }
      throw new Error("too many redirects");
    } catch (err) {
      const message = signal.aborted ? 'delivery_cancelled_or_timed_out' : 'callback_delivery_failed';
      const attempts = full.attempts + 1;
      const backoff = Math.min(OUTBOX_BASE_BACKOFF_MS * 2 ** (attempts - 1), OUTBOX_MAX_BACKOFF_MS);
      this.store.markOutboxAttempt(
        full.outboxId,
        attempts,
        new Date(nowMs + backoff).toISOString(),
        message,
        attempts >= OUTBOX_MAX_ATTEMPTS ? "abandoned" : "pending",
        new Date(nowMs).toISOString(),
      );
    }
  }

}
