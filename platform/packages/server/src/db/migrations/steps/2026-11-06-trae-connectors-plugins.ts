import type { Migration } from "../migration.js";

/**
 * Batch 6 additive schema: connector registry/audit, sealed connector credentials, and the
 * trusted plugin store with per-session version pins. An older build ignores these tables;
 * `down` keeps rows rather than deleting operator data.
 */
export const traeConnectorsPlugins: Migration = {
  name: "2026-11-06-trae-connectors-plugins",
  swapSafe: true,
  up(db) {
    db.exec(`
CREATE TABLE IF NOT EXISTS connectors (
  connector_id        TEXT PRIMARY KEY,
  owner_user_id       TEXT NOT NULL,
  project_id          TEXT,
  name                TEXT NOT NULL,
  kind                TEXT NOT NULL,
  execution_location  TEXT NOT NULL,
  recipient           TEXT NOT NULL,
  transport_scope     TEXT NOT NULL,
  authorization       TEXT NOT NULL,
  enabled             INTEGER NOT NULL,
  credential_fingerprint TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS connectors_owner ON connectors(owner_user_id, project_id);
CREATE TABLE IF NOT EXISTS connector_credentials (
  connector_id  TEXT PRIMARY KEY,
  sealed_value  TEXT NOT NULL,
  fingerprint   TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS connector_audit (
  audit_id            TEXT PRIMARY KEY,
  connector_id        TEXT NOT NULL,
  user_id             TEXT NOT NULL,
  project_id          TEXT,
  tool_name           TEXT NOT NULL,
  execution_location  TEXT NOT NULL,
  recipient           TEXT NOT NULL,
  transport_scope     TEXT NOT NULL,
  decision_id         TEXT,
  outcome             TEXT NOT NULL,
  reason              TEXT,
  duration_ms         INTEGER NOT NULL,
  credential_fingerprint TEXT,
  fields_json         TEXT NOT NULL,
  created_at          TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS trusted_plugin_versions (
  plugin_id            TEXT NOT NULL,
  version              TEXT NOT NULL,
  package_sha256       TEXT NOT NULL,
  publisher            TEXT NOT NULL,
  trust_state          TEXT NOT NULL,
  status               TEXT NOT NULL,
  manifest_json        TEXT NOT NULL,
  executable_hashes_json TEXT NOT NULL,
  installed_at         TEXT NOT NULL,
  PRIMARY KEY (plugin_id, version)
);
CREATE TABLE IF NOT EXISTS trusted_plugin_state (
  plugin_id      TEXT PRIMARY KEY,
  active_version TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS plugin_session_pins (
  session_id TEXT NOT NULL,
  plugin_id  TEXT NOT NULL,
  version    TEXT NOT NULL,
  pinned_at  TEXT NOT NULL,
  PRIMARY KEY (session_id, plugin_id)
);
CREATE INDEX IF NOT EXISTS plugin_session_pins_version ON plugin_session_pins(plugin_id, version);
`);
  },
  down() {},
};
