import type { Migration } from "../migration.js";

/**
 * Batch 6 knowledge library: a hash-verified local retrieval index, upload previews that bind
 * a confirmation to one content version, and the service-copy ledger (upload/delete status,
 * attempts, receipts). Additive only; `down` keeps rows so a rollback cannot lose sources or
 * an operator's record of a remote copy.
 */
export const qaKnowledgeLibrary: Migration = {
  name: "2026-11-06-qa-knowledge-library",
  swapSafe: true,
  up(db) {
    db.exec(`
CREATE TABLE IF NOT EXISTS qa_document_index (
  document_id  TEXT PRIMARY KEY REFERENCES qa_documents(document_id) ON DELETE CASCADE,
  project_id   TEXT NOT NULL,
  revision_id  TEXT NOT NULL,
  revision     INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  title        TEXT NOT NULL,
  content      TEXT NOT NULL,
  indexed_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_qa_document_index_project ON qa_document_index(project_id, indexed_at DESC, document_id DESC);
CREATE TABLE IF NOT EXISTS qa_upload_previews (
  preview_id         TEXT PRIMARY KEY,
  project_id         TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  created_by         TEXT NOT NULL,
  filename           TEXT NOT NULL,
  format             TEXT NOT NULL,
  title              TEXT NOT NULL,
  byte_size          INTEGER NOT NULL,
  content_hash       TEXT NOT NULL,
  content            TEXT NOT NULL,
  recipient          TEXT NOT NULL,
  purpose            TEXT NOT NULL,
  data_scope         TEXT NOT NULL,
  sensitive_hints_json TEXT NOT NULL,
  status             TEXT NOT NULL,
  document_id        TEXT,
  upload_id          TEXT,
  idempotency_key    TEXT,
  created_at         TEXT NOT NULL,
  expires_at         TEXT NOT NULL,
  confirmed_at       TEXT
);
CREATE INDEX IF NOT EXISTS idx_qa_upload_previews_project ON qa_upload_previews(project_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_qa_upload_previews_idempotency
  ON qa_upload_previews(project_id, created_by, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE TABLE IF NOT EXISTS qa_server_copies (
  copy_id             TEXT PRIMARY KEY,
  project_id          TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  document_id         TEXT NOT NULL,
  upload_id           TEXT NOT NULL,
  revision            INTEGER NOT NULL,
  content_hash        TEXT NOT NULL,
  byte_size           INTEGER NOT NULL,
  recipient           TEXT NOT NULL,
  purpose             TEXT NOT NULL,
  data_scope          TEXT NOT NULL,
  attribution_user_id TEXT NOT NULL,
  status              TEXT NOT NULL,
  attempts            INTEGER NOT NULL DEFAULT 0,
  last_error          TEXT NOT NULL DEFAULT '',
  remote_ref          TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_qa_server_copies_project ON qa_server_copies(project_id, document_id, created_at DESC);
`);
  },
  down() {},
};
