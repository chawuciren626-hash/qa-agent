import type { Migration } from "../migration.js";

/**
 * Unattended scheduling (batch 4): per-task authorization bindings, a durable per-fire run
 * ledger with fencing versions, and lifecycle records. All tables are additive, so a pushed
 * platform can boot on a database the migration has already changed. `down` is deliberately
 * a no-op: an older build ignores the tables, while dropping them would take the run audit
 * trail with it. `up` is re-runnable, so moving forward again is safe.
 */
export const unattendedScheduling: Migration = {
  name: "2026-11-06-unattended-scheduling",
  swapSafe: true,
  up(db) {
    db.exec(`
CREATE TABLE IF NOT EXISTS unattended_bindings ( -- per-task unattended authorization binding (who/where may this task ever run)
  project_id              TEXT NOT NULL,
  agent_id                TEXT NOT NULL,
  name                    TEXT NOT NULL,               -- schedule task name (file name without .toml)
  owner_user_id           TEXT NOT NULL,               -- confirmed owner; fires act for this user
  device_id               TEXT NOT NULL,               -- executing device identity
  grant_id                TEXT NOT NULL,               -- authorization grant reference (expiry/revocation key)
  grant_expires_at        TEXT,                        -- ISO instant the grant ceases; NULL = no claimed expiry
  permission_ceiling_json TEXT NOT NULL,               -- PermissionCeiling: allowed operations, approval escalation, run deadline
  publish_snapshot_json   TEXT NOT NULL,               -- content snapshot reference at bind time (agent release / skill / plugin hashes)
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL,
  PRIMARY KEY (project_id, agent_id, name)
);
CREATE TABLE IF NOT EXISTS unattended_runs ( -- durable per-fire run ledger (one row per scheduled slot; UNIQUE = idempotency)
  run_id                  TEXT PRIMARY KEY,
  project_id              TEXT NOT NULL,
  agent_id                TEXT NOT NULL,
  name                    TEXT NOT NULL,
  slot_ms                 INTEGER NOT NULL,            -- the scheduled slot this run belongs to
  owner_user_id           TEXT NOT NULL,
  device_id               TEXT NOT NULL,
  grant_id                TEXT,
  status                  TEXT NOT NULL,               -- queued|claimed|running|needs_approval|blocked|succeeded|failed|cancelled|expired|unknown
  status_version          INTEGER NOT NULL DEFAULT 1,  -- fencing counter: every transition CASes on it
  session_id              TEXT,                        -- Session the fire was sent to (NULL until dispatched)
  reason_code             TEXT,                        -- stable reason for blocked / needs_approval / unknown
  decision_id             TEXT,                        -- authorization decision reference
  policy_revision         TEXT,                        -- policy revision the decision came from
  decision_expires_at     TEXT,                        -- when a needs_approval decision lapses
  deadline_ms             INTEGER,                     -- run deadline (epoch ms); past it the run is expired
  cancel_requested        INTEGER NOT NULL DEFAULT 0,
  cancel_signal_delivered INTEGER NOT NULL DEFAULT 0,  -- executor confirmed receiving the cancellation signal
  dispatched_at           TEXT,                        -- ISO instant the send was attempted; NULL = never sent (no side effect possible)
  settled_at              TEXT,                        -- ISO instant a terminal status was applied
  evidence_json           TEXT,                        -- terminal evidence references (synthetic until a real executor reports)
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL,
  UNIQUE (project_id, agent_id, name, slot_ms)
);
CREATE INDEX IF NOT EXISTS idx_unattended_runs_open ON unattended_runs(status, deadline_ms);
CREATE TABLE IF NOT EXISTS unattended_lifecycle ( -- service lifecycle / blocked-fire audit records
  event_id    TEXT PRIMARY KEY,
  at          TEXT NOT NULL,
  kind        TEXT NOT NULL,             -- startup_reconcile | shutdown | tick_gap_suspected | fire_blocked | fire_needs_approval | fire_executed_after_cancel | fire_settled_after_cancel | cancel_signal_failed
  detail_json TEXT NOT NULL
);
`);
  },
  // Keeps tables and rows: a rollback must not erase the run audit trail or lifecycle records.
  down() {},
};
