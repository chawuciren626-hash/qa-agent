import type { Migration } from "../migration.js";

/**
 * Q3 quality traceability: immutable test design batches, per-run case results, project-level
 * defects with append-only lifecycle events and retests, and report evidence indexes. The
 * tables are additive, so a pushed platform can boot on a database this migration changed.
 * `down` is deliberately a no-op: an older build ignores the tables, while dropping them
 * would take a Project's traceability records with it. `up` is re-runnable.
 */
export const qaQualityTraceability: Migration = {
  name: "2026-11-02-qa-quality-traceability",
  swapSafe: true,
  up(db) {
    db.exec(`
CREATE TABLE IF NOT EXISTS qa_design_batches (
  batch_id          TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  session_id        TEXT NOT NULL,
  run_id            TEXT NOT NULL,
  revision          INTEGER NOT NULL,
  status            TEXT NOT NULL,
  source_json       TEXT NOT NULL,
  test_point_count  INTEGER NOT NULL,
  test_case_count   INTEGER NOT NULL,
  content_hash      TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  created_by        TEXT NOT NULL,
  UNIQUE(session_id, run_id, revision)
);
CREATE INDEX IF NOT EXISTS idx_qa_design_batches_run ON qa_design_batches(project_id, session_id, run_id, revision DESC);
CREATE TABLE IF NOT EXISTS qa_test_points (
  row_id             TEXT PRIMARY KEY,
  batch_id           TEXT NOT NULL REFERENCES qa_design_batches(batch_id) ON DELETE CASCADE,
  project_id         TEXT NOT NULL,
  point_key          TEXT NOT NULL,
  module             TEXT NOT NULL,
  feature            TEXT NOT NULL,
  description        TEXT NOT NULL,
  risk               TEXT NOT NULL,
  coverage_type_json TEXT NOT NULL,
  evidence_refs_json TEXT NOT NULL,
  source             TEXT NOT NULL DEFAULT '',
  source_locator     TEXT NOT NULL DEFAULT '',
  execution_layer    TEXT,
  created_at         TEXT NOT NULL,
  UNIQUE(batch_id, point_key)
);
CREATE TABLE IF NOT EXISTS qa_test_cases (
  row_id               TEXT PRIMARY KEY,
  batch_id             TEXT NOT NULL REFERENCES qa_design_batches(batch_id) ON DELETE CASCADE,
  project_id           TEXT NOT NULL,
  case_key             TEXT NOT NULL,
  title                TEXT NOT NULL,
  priority             TEXT NOT NULL,
  type                 TEXT NOT NULL DEFAULT '',
  preconditions_json   TEXT NOT NULL,
  test_data_json       TEXT NOT NULL,
  steps_json           TEXT NOT NULL,
  expected             TEXT NOT NULL,
  automation_feasible  INTEGER NOT NULL,
  related_point_key    TEXT NOT NULL,
  evidence_refs_json   TEXT NOT NULL,
  design_contract_json TEXT NOT NULL,
  created_at           TEXT NOT NULL,
  UNIQUE(batch_id, case_key)
);
CREATE TABLE IF NOT EXISTS qa_case_results (
  result_id          TEXT PRIMARY KEY,
  project_id         TEXT NOT NULL,
  session_id         TEXT NOT NULL,
  run_id             TEXT NOT NULL,
  batch_id           TEXT NOT NULL,
  case_key           TEXT NOT NULL,
  status             TEXT NOT NULL,
  reason             TEXT NOT NULL DEFAULT '',
  invocation_id      TEXT NOT NULL,
  evidence_refs_json TEXT NOT NULL,
  started_at         TEXT,
  finished_at        TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  UNIQUE(project_id, run_id, case_key)
);
CREATE INDEX IF NOT EXISTS idx_qa_case_results_run ON qa_case_results(project_id, run_id);
CREATE TABLE IF NOT EXISTS qa_defects (
  defect_id          TEXT PRIMARY KEY,
  project_id         TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  fingerprint        TEXT NOT NULL,
  title              TEXT NOT NULL,
  category           TEXT NOT NULL,
  status             TEXT NOT NULL,
  confidence         TEXT NOT NULL,
  severity           TEXT NOT NULL,
  priority           TEXT NOT NULL,
  expected_result    TEXT NOT NULL DEFAULT '',
  actual_result      TEXT NOT NULL DEFAULT '',
  analysis           TEXT NOT NULL DEFAULT '',
  duplicate_of       TEXT,
  related_cases_json TEXT NOT NULL,
  evidence_refs_json TEXT NOT NULL,
  origin_session_id  TEXT NOT NULL,
  origin_run_id      TEXT NOT NULL,
  first_seen_at      TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  revision           INTEGER NOT NULL,
  event_count        INTEGER NOT NULL,
  last_event_hash    TEXT NOT NULL,
  created_at         TEXT NOT NULL,
  created_by         TEXT NOT NULL,
  UNIQUE(project_id, fingerprint)
);
CREATE INDEX IF NOT EXISTS idx_qa_defects_project_status ON qa_defects(project_id, status, updated_at DESC, defect_id DESC);
CREATE TABLE IF NOT EXISTS qa_defect_occurrences (
  occurrence_id      TEXT PRIMARY KEY,
  defect_id          TEXT NOT NULL REFERENCES qa_defects(defect_id) ON DELETE CASCADE,
  project_id         TEXT NOT NULL,
  session_id         TEXT NOT NULL,
  run_id             TEXT NOT NULL,
  case_key           TEXT NOT NULL DEFAULT '',
  evidence_refs_json TEXT NOT NULL,
  observed_at        TEXT NOT NULL,
  created_at         TEXT NOT NULL,
  UNIQUE(defect_id, run_id, case_key)
);
CREATE TABLE IF NOT EXISTS qa_defect_events (
  event_id           TEXT PRIMARY KEY,
  defect_id          TEXT NOT NULL REFERENCES qa_defects(defect_id) ON DELETE CASCADE,
  project_id         TEXT NOT NULL,
  sequence           INTEGER NOT NULL,
  action             TEXT NOT NULL,
  from_status        TEXT NOT NULL,
  to_status          TEXT NOT NULL,
  actor_user_id      TEXT NOT NULL,
  reason             TEXT NOT NULL DEFAULT '',
  evidence_refs_json TEXT NOT NULL,
  retest_run_id      TEXT,
  prev_event_hash    TEXT NOT NULL,
  event_hash         TEXT NOT NULL,
  created_at         TEXT NOT NULL,
  UNIQUE(defect_id, sequence)
);
CREATE TABLE IF NOT EXISTS qa_retests (
  retest_id          TEXT PRIMARY KEY,
  defect_id          TEXT NOT NULL REFERENCES qa_defects(defect_id) ON DELETE CASCADE,
  project_id         TEXT NOT NULL,
  session_id         TEXT NOT NULL,
  run_id             TEXT NOT NULL,
  batch_id           TEXT NOT NULL,
  result             TEXT NOT NULL,
  case_results_json  TEXT NOT NULL,
  evidence_refs_json TEXT NOT NULL,
  created_at         TEXT NOT NULL,
  created_by         TEXT NOT NULL,
  UNIQUE(defect_id, run_id)
);
CREATE TABLE IF NOT EXISTS qa_report_indexes (
  report_id           TEXT PRIMARY KEY,
  project_id          TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  session_id          TEXT NOT NULL,
  run_id              TEXT NOT NULL,
  batch_id            TEXT NOT NULL,
  revision            INTEGER NOT NULL,
  status              TEXT NOT NULL,
  html_path           TEXT NOT NULL,
  html_sha256         TEXT NOT NULL,
  conclusion          TEXT NOT NULL,
  quality_gate        TEXT NOT NULL,
  counts_json         TEXT NOT NULL,
  coverage_json       TEXT NOT NULL,
  untested_json       TEXT NOT NULL,
  evidence_json       TEXT NOT NULL,
  limitations_json    TEXT NOT NULL,
  open_defects_json   TEXT NOT NULL,
  results_fingerprint TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  created_by          TEXT NOT NULL,
  content_hash        TEXT NOT NULL,
  UNIQUE(session_id, run_id, revision)
);
CREATE INDEX IF NOT EXISTS idx_qa_report_indexes_run ON qa_report_indexes(project_id, session_id, run_id, revision DESC);
`);
  },
  // Keeps tables and rows: a rollback must not erase a Project's design, defects or reports.
  down() {},
};
