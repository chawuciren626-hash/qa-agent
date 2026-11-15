import type { Migration } from "../migration.js";

/**
 * Q2 project knowledge: documents and immutable revisions, evidence candidates, confirmed
 * rules, and append-only task context snapshots. The tables are additive, so a pushed
 * platform can boot on a database the migration has already changed. `down` is deliberately
 * a no-op: an older build ignores the tables, while dropping them would take project
 * knowledge with it. `up` is re-runnable, so moving forward again is safe.
 */
export const qaProjectKnowledge: Migration = {
  name: "2026-11-02-qa-project-knowledge",
  swapSafe: true,
  up(db) {
    db.exec(`
CREATE TABLE IF NOT EXISTS qa_documents (
  document_id         TEXT PRIMARY KEY,
  project_id          TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  title               TEXT NOT NULL,
  format              TEXT NOT NULL,
  status              TEXT NOT NULL,
  source_json         TEXT NOT NULL,
  revision            INTEGER NOT NULL,
  current_revision    INTEGER NOT NULL,
  current_revision_id TEXT NOT NULL,
  content_hash        TEXT NOT NULL,
  byte_size           INTEGER NOT NULL,
  created_at          TEXT NOT NULL,
  created_by          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  updated_by          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_qa_documents_project_updated ON qa_documents(project_id, status, updated_at DESC, document_id DESC);
CREATE TABLE IF NOT EXISTS qa_document_revisions (
  revision_id    TEXT PRIMARY KEY,
  document_id    TEXT NOT NULL REFERENCES qa_documents(document_id) ON DELETE CASCADE,
  project_id     TEXT NOT NULL,
  revision       INTEGER NOT NULL,
  title          TEXT NOT NULL,
  content        TEXT NOT NULL,
  encoding       TEXT NOT NULL,
  content_hash   TEXT NOT NULL,
  byte_size      INTEGER NOT NULL,
  change_note    TEXT NOT NULL DEFAULT '',
  source_json    TEXT NOT NULL,
  author_user_id TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  UNIQUE(document_id, revision)
);
CREATE INDEX IF NOT EXISTS idx_qa_document_revisions_doc ON qa_document_revisions(document_id, revision DESC);
CREATE TABLE IF NOT EXISTS qa_knowledge_candidates (
  candidate_id      TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  title             TEXT NOT NULL,
  statement         TEXT NOT NULL,
  rationale         TEXT NOT NULL DEFAULT '',
  scope_json        TEXT NOT NULL,
  source_refs_json  TEXT NOT NULL,
  status            TEXT NOT NULL,
  revision          INTEGER NOT NULL,
  created_by_json   TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  reviewed_by       TEXT,
  reviewed_at       TEXT,
  review_note       TEXT NOT NULL DEFAULT '',
  confirmed_rule_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_qa_candidates_project_status ON qa_knowledge_candidates(project_id, status, created_at DESC, candidate_id DESC);
CREATE TABLE IF NOT EXISTS qa_project_rules (
  rule_id             TEXT PRIMARY KEY,
  project_id          TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  status              TEXT NOT NULL,
  version             INTEGER NOT NULL,
  title               TEXT NOT NULL,
  statement           TEXT NOT NULL,
  scope_json          TEXT NOT NULL,
  source_refs_json    TEXT NOT NULL,
  source_candidate_id TEXT,
  confirmed_by        TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  content_hash        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_qa_rules_project_status ON qa_project_rules(project_id, status, updated_at DESC, rule_id DESC);
CREATE TABLE IF NOT EXISTS qa_rule_versions (
  rule_id             TEXT NOT NULL REFERENCES qa_project_rules(rule_id) ON DELETE CASCADE,
  version             INTEGER NOT NULL,
  project_id          TEXT NOT NULL,
  status              TEXT NOT NULL,
  title               TEXT NOT NULL,
  statement           TEXT NOT NULL,
  scope_json          TEXT NOT NULL,
  source_refs_json    TEXT NOT NULL,
  source_candidate_id TEXT,
  change_note         TEXT NOT NULL DEFAULT '',
  actor_user_id       TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  content_hash        TEXT NOT NULL,
  PRIMARY KEY (rule_id, version)
);
CREATE INDEX IF NOT EXISTS idx_qa_rule_versions_project ON qa_rule_versions(project_id, created_at DESC);
CREATE TABLE IF NOT EXISTS qa_task_context_snapshots (
  snapshot_id       TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  session_id        TEXT NOT NULL,
  agent_id          TEXT NOT NULL,
  version           INTEGER NOT NULL,
  documents_json    TEXT NOT NULL,
  rules_json        TEXT NOT NULL,
  capabilities_json TEXT NOT NULL,
  amendment_json    TEXT,
  created_at        TEXT NOT NULL,
  created_by        TEXT NOT NULL,
  UNIQUE(session_id, version)
);
CREATE INDEX IF NOT EXISTS idx_qa_task_snapshots_project ON qa_task_context_snapshots(project_id, session_id, version DESC);
`);
  },
  // Keeps tables and rows: a rollback must not erase a Project's sources, rules or snapshots.
  down() {},
};
