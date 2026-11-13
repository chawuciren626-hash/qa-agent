import type { Migration } from "../migration.js";

/**
 * U3 cancellation and fault-injection ledger: propagation acknowledgements, process-tree
 * verification and drill outcomes. The ledger proves what was requested and verified; it
 * does not itself kill browsers, WSL processes or model streams.
 */
export const qaU3CancellationDrills: Migration = {
  name: "2026-11-13-u3-cancellation-drills",
  swapSafe: true,
  up(db) {
    db.exec(`
CREATE TABLE IF NOT EXISTS qa_u3_cancellations (
  cancellation_id  TEXT PRIMARY KEY,
  attempt_id       TEXT NOT NULL REFERENCES qa_u2_execution_attempts(attempt_id) ON DELETE CASCADE,
  project_id       TEXT NOT NULL,
  session_id       TEXT,
  kind             TEXT NOT NULL,
  status           TEXT NOT NULL,
  model_ack        TEXT NOT NULL,
  tool_ack         TEXT NOT NULL,
  browser_ack      TEXT NOT NULL,
  wsl_ack          TEXT NOT NULL,
  callback_ack     TEXT NOT NULL,
  residual_state   TEXT NOT NULL,
  notes            TEXT NOT NULL DEFAULT '',
  evidence_json    TEXT NOT NULL,
  requested_at     TEXT NOT NULL,
  requested_by     TEXT NOT NULL,
  acknowledged_at  TEXT,
  acknowledged_by  TEXT,
  updated_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_qa_u3_cancellations_attempt
  ON qa_u3_cancellations(attempt_id, status, requested_at DESC);
CREATE TABLE IF NOT EXISTS qa_u3_process_verifications (
  verification_id TEXT PRIMARY KEY,
  cancellation_id TEXT NOT NULL REFERENCES qa_u3_cancellations(cancellation_id) ON DELETE CASCADE,
  attempt_id      TEXT NOT NULL,
  project_id      TEXT NOT NULL,
  target_kind     TEXT NOT NULL,
  target          TEXT NOT NULL,
  pid             INTEGER,
  process_group   TEXT,
  verification_method TEXT NOT NULL,
  before_alive    INTEGER,
  after_alive     INTEGER,
  exit_code       INTEGER,
  state           TEXT NOT NULL,
  evidence_json   TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  created_by      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_qa_u3_process_verifications_cancellation
  ON qa_u3_process_verifications(cancellation_id, target_kind);
CREATE TABLE IF NOT EXISTS qa_u3_fault_injections (
  injection_id   TEXT PRIMARY KEY,
  attempt_id     TEXT NOT NULL REFERENCES qa_u2_execution_attempts(attempt_id) ON DELETE CASCADE,
  project_id     TEXT NOT NULL,
  case_attempt_id TEXT REFERENCES qa_u2_case_attempts(attempt_case_id) ON DELETE CASCADE,
  kind           TEXT NOT NULL,
  state          TEXT NOT NULL,
  expected_effect TEXT NOT NULL,
  observed_effect TEXT NOT NULL,
  cleanup_state  TEXT NOT NULL,
  evidence_json  TEXT NOT NULL,
  injected_at    TEXT NOT NULL,
  injected_by    TEXT NOT NULL,
  recovered_at   TEXT,
  updated_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_qa_u3_fault_injections_attempt
  ON qa_u3_fault_injections(attempt_id, kind, state);
`);
  },
  down(db) {
    // Drill records are recovery audit evidence; destructive rollback is explicit only.
    db.exec(`
DROP TABLE IF EXISTS qa_u3_fault_injections;
DROP TABLE IF EXISTS qa_u3_process_verifications;
DROP TABLE IF EXISTS qa_u3_cancellations;
`);
  },
};
