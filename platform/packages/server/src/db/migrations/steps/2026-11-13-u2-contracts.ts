import type { Migration } from "../migration.js";

/**
 * U2 contract preparation: TestMission, Oracle Ledger, Case Graph links and Execution
 * Envelopes. These tables make the future real-test pilot auditable without turning any
 * endpoint into an execution gate. Existing QA design batches, results, evidence and reports
 * remain the runtime source of truth.
 */
export const qaU2Contracts: Migration = {
  name: "2026-11-13-u2-contracts",
  swapSafe: true,
  up(db) {
    db.exec(`
CREATE TABLE IF NOT EXISTS qa_test_missions (
  mission_id          TEXT PRIMARY KEY,
  project_id          TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  title               TEXT NOT NULL,
  objective           TEXT NOT NULL,
  scope_json          TEXT NOT NULL,
  risks_json          TEXT NOT NULL,
  authorization_json  TEXT NOT NULL,
  deliverables_json   TEXT NOT NULL,
  status              TEXT NOT NULL,
  revision            INTEGER NOT NULL,
  content_hash        TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  created_by          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_qa_test_missions_project
  ON qa_test_missions(project_id, status, updated_at DESC);
CREATE TABLE IF NOT EXISTS qa_oracle_entries (
  oracle_id          TEXT PRIMARY KEY,
  mission_id         TEXT NOT NULL REFERENCES qa_test_missions(mission_id) ON DELETE CASCADE,
  project_id         TEXT NOT NULL,
  oracle_key         TEXT NOT NULL,
  capability         TEXT NOT NULL,
  statement          TEXT NOT NULL,
  source_type        TEXT NOT NULL,
  source_ref         TEXT NOT NULL,
  source_hash        TEXT,
  status             TEXT NOT NULL,
  confirmed_by       TEXT,
  confirmed_at       TEXT,
  confirmation_reason TEXT,
  evidence_refs_json TEXT NOT NULL,
  revision           INTEGER NOT NULL,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  UNIQUE(mission_id, oracle_key)
);
CREATE INDEX IF NOT EXISTS idx_qa_oracle_entries_mission
  ON qa_oracle_entries(mission_id, status);
CREATE TABLE IF NOT EXISTS qa_case_graph_links (
  link_id     TEXT PRIMARY KEY,
  mission_id  TEXT NOT NULL REFERENCES qa_test_missions(mission_id) ON DELETE CASCADE,
  project_id  TEXT NOT NULL,
  oracle_id   TEXT NOT NULL REFERENCES qa_oracle_entries(oracle_id) ON DELETE CASCADE,
  point_key   TEXT NOT NULL,
  case_key    TEXT NOT NULL,
  relation    TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  created_by  TEXT NOT NULL,
  UNIQUE(mission_id, point_key, case_key, oracle_id, relation)
);
CREATE INDEX IF NOT EXISTS idx_qa_case_graph_links_case
  ON qa_case_graph_links(project_id, case_key);
CREATE TABLE IF NOT EXISTS qa_execution_envelopes (
  envelope_id           TEXT PRIMARY KEY,
  mission_id            TEXT NOT NULL REFERENCES qa_test_missions(mission_id) ON DELETE CASCADE,
  project_id            TEXT NOT NULL,
  label                 TEXT NOT NULL,
  target_ref            TEXT NOT NULL,
  target_version        TEXT NOT NULL,
  actual_version        TEXT,
  carrier               TEXT NOT NULL,
  os_name               TEXT NOT NULL,
  account_role          TEXT NOT NULL,
  agent_id              TEXT NOT NULL,
  agent_bundle_hash     TEXT NOT NULL,
  skills_json           TEXT NOT NULL,
  plugins_json          TEXT NOT NULL,
  model_json            TEXT NOT NULL,
  connectors_json       TEXT NOT NULL,
  backend               TEXT NOT NULL,
  authorization_state   TEXT NOT NULL,
  resource_set_hash     TEXT NOT NULL,
  data_state_json       TEXT NOT NULL,
  cleanup_plan_json     TEXT NOT NULL,
  identity_hash         TEXT NOT NULL,
  status                TEXT NOT NULL,
  revision              INTEGER NOT NULL,
  created_at            TEXT NOT NULL,
  created_by            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  UNIQUE(mission_id, label)
);
CREATE INDEX IF NOT EXISTS idx_qa_execution_envelopes_mission
  ON qa_execution_envelopes(mission_id, status);
`);
  },
  down(db) {
    // U2 contracts may contain pilot planning records; destructive rollback is explicit only.
    db.exec(`
DROP TABLE IF EXISTS qa_execution_envelopes;
DROP TABLE IF EXISTS qa_case_graph_links;
DROP TABLE IF EXISTS qa_oracle_entries;
DROP TABLE IF EXISTS qa_test_missions;
`);
  },
};
