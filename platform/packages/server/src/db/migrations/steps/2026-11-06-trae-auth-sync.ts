import type { Migration } from "../migration.js";

/**
 * Batch 2 local authorization and publication state: append-only invocation decisions, the
 * last verified publication pointer, and per-task content evidence. Additive only; an older
 * build ignores the tables, so `down` keeps rows and is a no-op.
 */
export const traeAuthSync: Migration = {
  name: "2026-11-06-trae-auth-sync",
  swapSafe: true,
  up(db) {
    db.exec(`
CREATE TABLE IF NOT EXISTS invocation_authorization_decisions (
  decision_id      TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL,
  project_id       TEXT,
  session_id       TEXT,
  resource_kind    TEXT NOT NULL,
  resource_id      TEXT NOT NULL,
  operation        TEXT NOT NULL,
  allowed          INTEGER NOT NULL,
  reason_code      TEXT NOT NULL,
  policy_revision  TEXT NOT NULL,
  checked_at       TEXT NOT NULL,
  expires_at       TEXT NOT NULL,
  detail_json      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS invocation_authorization_decisions_user ON invocation_authorization_decisions(user_id, checked_at);
CREATE TABLE IF NOT EXISTS published_resource_state (
  user_id          TEXT PRIMARY KEY,
  connection_state TEXT NOT NULL,
  update_state     TEXT NOT NULL,
  set_hash         TEXT,
  bundles_json     TEXT NOT NULL,
  last_verified_at TEXT,
  error_code       TEXT,
  error_message    TEXT,
  checked_at       TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS task_content_snapshots (
  snapshot_id      TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL,
  project_id       TEXT NOT NULL,
  session_id       TEXT,
  task_id          TEXT,
  agent_id         TEXT NOT NULL,
  bundle_hash      TEXT NOT NULL,
  model_revision   TEXT NOT NULL,
  snapshot_json    TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  UNIQUE(session_id, bundle_hash)
);
`);
  },
  down() {},
};
