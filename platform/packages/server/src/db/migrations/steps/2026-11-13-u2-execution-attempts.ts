import type { Migration } from "../migration.js";

/**
 * U2 execution ledger: appendable attempts against a frozen Envelope, per-case outcomes,
 * curated evidence, cleanup state and deterministic pass gates. This records what happened;
 * it is not a playback script and never upgrades an unknown business write to success.
 */
export const qaU2ExecutionAttempts: Migration = {
  name: "2026-11-13-u2-execution-attempts",
  swapSafe: true,
  up(db) {
    db.exec(`
CREATE TABLE IF NOT EXISTS qa_u2_execution_attempts (
  attempt_id               TEXT PRIMARY KEY,
  mission_id               TEXT NOT NULL REFERENCES qa_test_missions(mission_id) ON DELETE CASCADE,
  envelope_id              TEXT NOT NULL REFERENCES qa_execution_envelopes(envelope_id) ON DELETE CASCADE,
  project_id               TEXT NOT NULL,
  attempt_status           TEXT NOT NULL,
  result                   TEXT NOT NULL,
  cleanup_state            TEXT NOT NULL,
  observed_summary         TEXT NOT NULL DEFAULT '',
  metrics_json             TEXT NOT NULL,
  evidence_json            TEXT NOT NULL,
  defect_refs_json         TEXT NOT NULL,
  envelope_identity_claim  TEXT NOT NULL,
  revision                 INTEGER NOT NULL,
  started_at               TEXT NOT NULL,
  finished_at              TEXT,
  created_at               TEXT NOT NULL,
  created_by               TEXT NOT NULL,
  updated_at               TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_qa_u2_attempts_mission
  ON qa_u2_execution_attempts(mission_id, attempt_status, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_qa_u2_attempts_envelope
  ON qa_u2_execution_attempts(envelope_id, started_at DESC);
CREATE TABLE IF NOT EXISTS qa_u2_case_attempts (
  attempt_case_id  TEXT PRIMARY KEY,
  attempt_id       TEXT NOT NULL REFERENCES qa_u2_execution_attempts(attempt_id) ON DELETE CASCADE,
  mission_id       TEXT NOT NULL,
  envelope_id      TEXT NOT NULL,
  project_id       TEXT NOT NULL,
  case_key         TEXT NOT NULL,
  oracle_id        TEXT NOT NULL,
  point_key        TEXT NOT NULL,
  relation         TEXT NOT NULL,
  status           TEXT NOT NULL,
  observed         TEXT NOT NULL DEFAULT '',
  failure_class    TEXT,
  defect_refs_json TEXT NOT NULL,
  evidence_json    TEXT NOT NULL,
  started_at       TEXT,
  finished_at      TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  UNIQUE(attempt_id, case_key)
);
CREATE INDEX IF NOT EXISTS idx_qa_u2_case_attempts_project_case
  ON qa_u2_case_attempts(project_id, case_key, updated_at DESC);
CREATE TABLE IF NOT EXISTS qa_u2_attempt_events (
  event_id    TEXT PRIMARY KEY,
  attempt_id  TEXT NOT NULL REFERENCES qa_u2_execution_attempts(attempt_id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,
  detail_json TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  created_by  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_qa_u2_attempt_events_attempt
  ON qa_u2_attempt_events(attempt_id, created_at);
`);
  },
  down(db) {
    // Execution results are audit records; destructive rollback is explicit only.
    db.exec(`
DROP TABLE IF EXISTS qa_u2_attempt_events;
DROP TABLE IF EXISTS qa_u2_case_attempts;
DROP TABLE IF EXISTS qa_u2_execution_attempts;
`);
  },
};
