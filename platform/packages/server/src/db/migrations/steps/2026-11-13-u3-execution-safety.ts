import type { Migration } from "../migration.js";

/**
 * U3 execution safety ledger: per-case checkpoints, unknown side effects, cleanup actions
 * and nine-layer interface coverage. These tables make recovery and cleanup auditable; they
 * do not execute, cancel or clean anything by themselves.
 */
export const qaU3ExecutionSafety: Migration = {
  name: "2026-11-13-u3-execution-safety",
  swapSafe: true,
  up(db) {
    db.exec(`
CREATE TABLE IF NOT EXISTS qa_u3_case_checkpoints (
  checkpoint_id  TEXT PRIMARY KEY,
  attempt_id     TEXT NOT NULL REFERENCES qa_u2_execution_attempts(attempt_id) ON DELETE CASCADE,
  case_attempt_id TEXT NOT NULL REFERENCES qa_u2_case_attempts(attempt_case_id) ON DELETE CASCADE,
  project_id     TEXT NOT NULL,
  ordinal        INTEGER NOT NULL,
  kind           TEXT NOT NULL,
  label          TEXT NOT NULL,
  status         TEXT NOT NULL,
  payload_json   TEXT NOT NULL,
  evidence_json  TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  created_by     TEXT NOT NULL,
  UNIQUE(case_attempt_id, ordinal)
);
CREATE INDEX IF NOT EXISTS idx_qa_u3_checkpoints_attempt
  ON qa_u3_case_checkpoints(attempt_id, ordinal);
CREATE TABLE IF NOT EXISTS qa_u3_side_effects (
  effect_id        TEXT PRIMARY KEY,
  attempt_id       TEXT NOT NULL REFERENCES qa_u2_execution_attempts(attempt_id) ON DELETE CASCADE,
  case_attempt_id  TEXT REFERENCES qa_u2_case_attempts(attempt_case_id) ON DELETE CASCADE,
  project_id       TEXT NOT NULL,
  kind             TEXT NOT NULL,
  target           TEXT NOT NULL,
  idempotency_key  TEXT NOT NULL DEFAULT '',
  state            TEXT NOT NULL,
  cleanup_state    TEXT NOT NULL,
  request_digest   TEXT,
  result_digest    TEXT,
  cleanup_plan_json TEXT NOT NULL,
  evidence_json    TEXT NOT NULL,
  discovered_at    TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_qa_u3_side_effects_attempt
  ON qa_u3_side_effects(attempt_id, cleanup_state, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_qa_u3_side_effects_idempotency
  ON qa_u3_side_effects(attempt_id, idempotency_key);
CREATE TABLE IF NOT EXISTS qa_u3_cleanup_actions (
  action_id       TEXT PRIMARY KEY,
  attempt_id      TEXT NOT NULL REFERENCES qa_u2_execution_attempts(attempt_id) ON DELETE CASCADE,
  effect_id       TEXT REFERENCES qa_u3_side_effects(effect_id) ON DELETE CASCADE,
  case_attempt_id TEXT REFERENCES qa_u2_case_attempts(attempt_case_id) ON DELETE CASCADE,
  project_id      TEXT NOT NULL,
  action          TEXT NOT NULL,
  state           TEXT NOT NULL,
  verification_json TEXT NOT NULL,
  failure_class   TEXT,
  defect_refs_json TEXT NOT NULL,
  evidence_json   TEXT NOT NULL,
  started_at      TEXT,
  finished_at     TEXT,
  created_at      TEXT NOT NULL,
  created_by      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_qa_u3_cleanup_actions_attempt
  ON qa_u3_cleanup_actions(attempt_id, state, updated_at DESC);
CREATE TABLE IF NOT EXISTS qa_u3_interface_coverage (
  coverage_id       TEXT PRIMARY KEY,
  attempt_id        TEXT NOT NULL REFERENCES qa_u2_execution_attempts(attempt_id) ON DELETE CASCADE,
  case_attempt_id   TEXT REFERENCES qa_u2_case_attempts(attempt_case_id) ON DELETE CASCADE,
  project_id        TEXT NOT NULL,
  route_key         TEXT NOT NULL,
  method            TEXT NOT NULL,
  path              TEXT NOT NULL,
  route_documented  INTEGER NOT NULL,
  contract_version  TEXT,
  source_ref        TEXT,
  executed          INTEGER NOT NULL,
  request_valid     INTEGER NOT NULL,
  structure_asserted INTEGER NOT NULL,
  business_asserted INTEGER NOT NULL,
  risk_branch       INTEGER NOT NULL,
  cleanup_verified  INTEGER NOT NULL,
  result            TEXT NOT NULL,
  evidence_json     TEXT NOT NULL,
  notes             TEXT NOT NULL DEFAULT '',
  created_at        TEXT NOT NULL,
  created_by        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  UNIQUE(attempt_id, route_key)
);
CREATE INDEX IF NOT EXISTS idx_qa_u3_interface_coverage_attempt
  ON qa_u3_interface_coverage(attempt_id, result);
`);
  },
  down(db) {
    // Safety records support recovery audits; destructive rollback is explicit only.
    db.exec(`
DROP TABLE IF EXISTS qa_u3_interface_coverage;
DROP TABLE IF EXISTS qa_u3_cleanup_actions;
DROP TABLE IF EXISTS qa_u3_side_effects;
DROP TABLE IF EXISTS qa_u3_case_checkpoints;
`);
  },
};
