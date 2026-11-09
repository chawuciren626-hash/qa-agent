import type { Migration } from "../migration.js";

/**
 * External task exchange (batch 5): platform credentials, bound-device registrations, the
 * task table with lease fencing and cancel versioning, the append-only event ledger, the
 * at-least-once result rows, and the delivery outbox. All additive (swapSafe); `down`
 * keeps tables and rows — a rollback must not erase the exchange audit trail. Re-runnable.
 */
export const taskExchange: Migration = {
  name: "2026-11-06-task-exchange",
  swapSafe: true,
  up(db) {
    db.exec(`
CREATE TABLE IF NOT EXISTS exchange_platforms ( -- external platform credentials (bearer, sha256 at rest)
  tenant_id    TEXT NOT NULL DEFAULT 'local', -- v1: the single implicit tenant of this installation
  platform_id  TEXT NOT NULL,                 -- the external platform's identifier (isolated per tenant+platform)
  token_hash   TEXT NOT NULL UNIQUE,          -- sha256 hex of the bearer token (raw shown ONCE at registration)
  registered_at TEXT NOT NULL,
  revoked_at   TEXT,
  PRIMARY KEY (tenant_id, platform_id)
);
CREATE TABLE IF NOT EXISTS exchange_devices ( -- a user's local executor registered to pull from one platform
  device_id     TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL DEFAULT 'local',
  user_id       TEXT NOT NULL,               -- the owning user (device tokens act for this user)
  platform_id   TEXT NOT NULL,               -- the ONE platform this device pulls from
  token_hash    TEXT NOT NULL UNIQUE,        -- sha256 hex; raw token shown ONCE at registration
  label         TEXT NOT NULL DEFAULT '',
  registered_at TEXT NOT NULL,
  revoked_at    TEXT,
  last_seen_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_exchange_devices_platform ON exchange_devices(tenant_id, platform_id, user_id);
CREATE TABLE IF NOT EXISTS exchange_tasks ( -- the exchange task: identity, binding, fencing state
  task_id            TEXT PRIMARY KEY,
  tenant_id          TEXT NOT NULL DEFAULT 'local',
  platform_id        TEXT NOT NULL,
  external_id        TEXT NOT NULL,          -- the platform's own task id (dedup per tenant+platform)
  idempotency_key    TEXT NOT NULL,          -- creation idempotency (dedup per tenant+platform)
  user_id            TEXT NOT NULL,          -- the tenant user the task runs for
  device_id          TEXT NOT NULL,          -- the ONE device that may claim it (never re-bound automatically)
  project_ref        TEXT NOT NULL,          -- project reference, verified server-side at creation
  objective          TEXT NOT NULL,          -- the test target/goal statement
  allowed_data_fields_json TEXT NOT NULL,    -- the explicit return-authorization: fields the result may carry
  deadline_ms        INTEGER,                -- absolute epoch ms; past it the task expires
  publish_snapshot_json TEXT NOT NULL,       -- the publish snapshot reference the run must use
  callback_url       TEXT,                   -- result callback URL (SSRF-checked at set and per delivery)
  status             TEXT NOT NULL,          -- queued|claimed|running|succeeded|failed|cancelled|expired
  status_version     INTEGER NOT NULL DEFAULT 1,  -- fencing: every transition CASes on it
  cancel_requested   INTEGER NOT NULL DEFAULT 0,
  cancel_version     INTEGER NOT NULL DEFAULT 0,  -- bumps on each cancel request (executor acknowledges it)
  queued_reason      TEXT,                   -- why a task is still queued (device_offline / bound_device_revoked / ...)
  claimed_by         TEXT,                   -- the device holding the lease
  lease_epoch        INTEGER NOT NULL DEFAULT 0,  -- fencing token: bumped per claim; stale epochs are refused
  lease_expires_at   TEXT,                   -- ISO instant the lease lapses
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  UNIQUE (tenant_id, platform_id, external_id),
  UNIQUE (tenant_id, platform_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_exchange_tasks_device ON exchange_tasks(device_id, status, created_at);
CREATE TABLE IF NOT EXISTS exchange_task_events ( -- append-only audit: transitions, deliveries, refusals
  event_id    TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL,
  at          TEXT NOT NULL,
  actor       TEXT NOT NULL,                 -- platform:<id> | device:<id> | server
  action      TEXT NOT NULL,
  detail_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_exchange_events_task ON exchange_task_events(task_id, at);
CREATE TABLE IF NOT EXISTS exchange_results ( -- one row per RECEIVED attempt (at-least-once, latest wins)
  result_id          TEXT PRIMARY KEY,
  task_id            TEXT NOT NULL,
  outcome            TEXT NOT NULL,          -- succeeded | failed
  summary_json       TEXT NOT NULL,          -- limited result summary (default-authorized)
  evidence_index_json TEXT NOT NULL,         -- non-sensitive evidence index (default-authorized)
  synthetic          INTEGER NOT NULL DEFAULT 1,  -- TRUE until a real executor reports (synthetic fixtures)
  received_at        TEXT NOT NULL,
  attempt            INTEGER NOT NULL,
  UNIQUE (task_id, attempt)
);
CREATE TABLE IF NOT EXISTS exchange_outbox ( -- delivery ledger: statuses/callbacks are SENT from here, retried without re-execution
  outbox_id       TEXT PRIMARY KEY,
  task_id         TEXT NOT NULL,
  kind            TEXT NOT NULL,             -- status | callback
  target_url      TEXT NOT NULL,
  payload_json    TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,      -- the delivery's own idempotency (never the execution's)
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  last_error      TEXT,
  status          TEXT NOT NULL DEFAULT 'pending', -- pending | delivered | abandoned
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_exchange_outbox_due ON exchange_outbox(status, next_attempt_at);
CREATE TABLE IF NOT EXISTS exchange_allowed_hosts ( -- the EXPLICIT intranet exception for callback targets (admin-registered)
  host      TEXT PRIMARY KEY,
  added_by  TEXT NOT NULL,
  added_at  TEXT NOT NULL
);
`);
  },
  // Keeps tables and rows: a rollback must not erase the exchange audit trail.
  down() {},
};
