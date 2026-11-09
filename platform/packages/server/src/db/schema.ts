/**
 * SQLite table-creation SQL.
 *
 * SQLite stores only indexes and aggregates: users / login sessions / Project authorization /
 * Agent & Session indexes / usage summaries / error records / UI preferences. Agent State,
 * Trace, and Workspace still follow the local directory-based storage rules.
 * Product not yet released: no migration branches — everything is CREATE IF NOT EXISTS, formed
 * once. The one exception: columns added to an existing table after release of a web.db are
 * ALTERed in by the idempotent per-column guard in database.ts (ensureColumn), since CREATE
 * TABLE IF NOT EXISTS never touches an existing table. A *reshaped* index follows the same
 * rule under a new name, with the superseded one dropped on open (idx_usage_session →
 * idx_usage_session_ts): CREATE INDEX IF NOT EXISTS never rebuilds an existing index either.
 */

export const MODEL_PROMOTIONS_SQL = `
CREATE TABLE IF NOT EXISTS model_promotions ( -- NOT a cache rebuildable from files: the only record of a Project row's running promotion (.project_config.toml keeps the list price), written by preset seeding at Project creation, "sync presets" and Penguin Go authorization / sync, and read by cost; lost rows price usage at list until the next sync writes them back
  project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  provider   TEXT NOT NULL,
  model_id   TEXT NOT NULL,
  discount   REAL NOT NULL CHECK (discount > 0 AND discount < 1),  -- fraction off the row's list price: billed = list × (1 − discount)
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, provider, model_id)
);`;

export const MODEL_PROVIDER_AUTH_TOKENS_SQL = `
CREATE TABLE IF NOT EXISTS model_provider_auth_tokens ( -- Server-side OAuth refresh metadata for provider groups. The current request token remains in .project_config.toml as api_key; this table holds only the refresh material that must never be returned to the frontend or written into Project files.
  project_id              TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  provider                TEXT NOT NULL,
  refresh_token           TEXT NOT NULL,
  access_token_expires_at TEXT,
  updated_at              TEXT NOT NULL,
  PRIMARY KEY (project_id, provider)
);`;

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
  user_id             TEXT PRIMARY KEY,            -- semantic id doubles as login name: ^[a-z][a-z0-9_-]{1,31}$
  password_hash       TEXT NOT NULL,               -- scrypt$N$r$p$salt$hash(base64)
  is_admin            INTEGER NOT NULL DEFAULT 0,  -- 1 for the built-in admin (seeded at startup)
  password_is_initial INTEGER NOT NULL DEFAULT 0,  -- 1=initial password (seeded/admin-set); cleared once the user changes it
  display_name        TEXT,                        -- nickname shown in place of user_id (1-32 characters); NULL = never set, surfaces show the id
  avatar              TEXT,                        -- avatar as a data URL (image/png|jpeg|webp, <= 131072 characters); NULL = never set, surfaces draw the letter placeholder
  created_at          TEXT NOT NULL
);
-- Server-side sessions backing the HttpOnly cookie: the cookie carries a 32-byte random
-- token, the row stores only its sha256. A session outlives a restart (it is on disk), which
-- is why the model is a row and not a signed statement.
CREATE TABLE IF NOT EXISTS auth_sessions (
  token_hash TEXT PRIMARY KEY,               -- sha256(token) hex; the cookie stores only the raw token
  user_id    TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,                  -- 30-day sliding renewal, topped up in place when <29 days remain
  via        TEXT                            -- 'password'|'desktop'|'setup'|'cli'|'remote'; NULL = legacy (password)
);
-- deleteExpired runs on every login and mint, deleteByUser on every admin reset; without
-- these both scan the whole table.
CREATE INDEX IF NOT EXISTS idx_auth_sessions_expires ON auth_sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions(user_id);

CREATE TABLE IF NOT EXISTS projects (
  project_id    TEXT PRIMARY KEY,            -- directory name doubles as id; display name lives in project_config.toml
  owner_user_id TEXT NOT NULL REFERENCES users(user_id),
  created_at    TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS project_members (  -- member grants only; owners are not stored here
  project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, user_id)
);
${MODEL_PROMOTIONS_SQL}
${MODEL_PROVIDER_AUTH_TOKENS_SQL}
CREATE TABLE IF NOT EXISTS agents (           -- index only; name/description live in system_config.yaml
  project_id TEXT NOT NULL,
  agent_id   TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, agent_id)
);
CREATE TABLE IF NOT EXISTS sessions (
  session_id    TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL,
  agent_id      TEXT NOT NULL,
  provider      TEXT NOT NULL,                     -- provider group of the session's CURRENT model (paired with model_id as a model reference; moves with each in-session switch)
  model_id      TEXT NOT NULL,                     -- upstream model id of the current model (sent to MMSP as-is; never concatenate <provider>/<id>)
  workspace     TEXT NOT NULL,
  approval_mode TEXT NOT NULL DEFAULT 'allow-all',   -- allow-all|deny-all|read-only|always-ask
  thinking_level TEXT,                               -- level pinned for THIS session (none|low|medium|high|xhigh|max); NULL=not pinned, runs follow the Agent config
  title         TEXT,                                -- auto-generated by the model after the first exchange; NULL=not yet (frontend shows "New chat")
  archived_at   TEXT,                                -- the user archived it (ISO time); NULL = not archived by hand (the listing rule may still file it away)
  kept_at       TEXT,                                -- "keep in sidebar": set when the user unarchives, cleared when they archive; NULL = the listing rule decides (a background source is archived, a user Session is active). Never written by a run.
  client        TEXT,                                -- creating client: 'web' (created via the Web App) | 'cli' (adopted from a CLI Trace) | 'org' (company mode) | 'api' (an Agent API run); NULL = legacy row, treated as web
  has_trace     INTEGER NOT NULL DEFAULT 0,          -- cache: a Trace record exists (set at task start / adoption / subagent registration; lazily backfilled by list hydration)
  fork_count    INTEGER NOT NULL DEFAULT 0,          -- monotonically allocated child-fork number for this source Session; never decremented when a fork is deleted
  sandbox       TEXT,                                -- the Session's sandbox policy snapshot (JSON SandboxSettings); NULL = legacy row, snapshotted at its next command
  last_active_at TEXT,                               -- last activity this server drove for the session (ISO; stamped once when a run starts and once when it ends, initialized to created_at); monotonic, never moves backwards; NULL only before openDatabase's one-time backfill
  created_at    TEXT NOT NULL,
  owner_user_id TEXT                            -- authenticated person whose local user preferences this Session injects; NULL = scheduled/API/CLI or legacy row
);                                            -- the Session's SOURCE (user/api/schedule/subagent/cli/company) is NOT stored: session_meta in the Trace is the single source of truth (see runtime/session-sources.ts); "client" is a different, DB-only axis (who created the row), read for the source only where the Trace records none ('org' → company)
CREATE INDEX IF NOT EXISTS idx_sessions_agent_created ON sessions(project_id, agent_id, created_at DESC);
CREATE TABLE IF NOT EXISTS usage_records (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  ts                TEXT NOT NULL,
  date              TEXT NOT NULL,            -- local date yyyy-mm-dd (aggregation key; same convention as Trace date directories)
  project_id        TEXT NOT NULL,
  agent_id          TEXT NOT NULL,
  session_id        TEXT NOT NULL,            -- top-level Session (child-session usage counts toward its main Session)
  origin_session_id TEXT,                     -- immediate source child Session (last of the origin chain); NULL=main session
  provider          TEXT NOT NULL,            -- provider group: paired with model_id as the attribution key; always GROUP BY provider, model_id
  model_id          TEXT NOT NULL,            -- upstream model id (paired with provider; same model_id across providers aggregates separately)
  cache_read        INTEGER NOT NULL,
  cache_write       INTEGER NOT NULL,
  output            INTEGER NOT NULL,
  total             INTEGER NOT NULL,         -- from token_usage.request (one row per Request)
  status            TEXT NOT NULL DEFAULT 'completed'  -- request outcome: completed=success (with tokens); others=failure (0 tokens, for success rate)
);                                            -- cost is not stored: computed at query time from current pricing
CREATE INDEX IF NOT EXISTS idx_usage_project_date ON usage_records(project_id, date);
CREATE INDEX IF NOT EXISTS idx_usage_session_ts ON usage_records(session_id, ts);  -- (session_id) alone was idx_usage_session (dropped on open): ts makes the last_active_at backfill's MAX(ts) a covering index scan instead of a random row lookup per usage record
CREATE TABLE IF NOT EXISTS error_records (     -- server-side error capture (the Costs page's "Errors" tab)
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         TEXT NOT NULL,
  date       TEXT NOT NULL,            -- local date yyyy-mm-dd (same convention as usage_records)
  project_id TEXT,                     -- nullable: sign-in/registration and process-level errors have no Project context
  agent_id   TEXT,
  session_id TEXT,
  source     TEXT NOT NULL,            -- http | session | usage | title | subagent | process | llm | environment | compaction | schedule | messaging | organization | id_suggest | plugin
  kind       TEXT NOT NULL,            -- expected (HttpError, business 4xx) | unexpected (500/runtime)
  code       TEXT NOT NULL,            -- HttpError.code / internal / session_run_failed / ...
  status     INTEGER,                  -- HTTP status code; NULL for non-HTTP sources
  message    TEXT NOT NULL             -- truncated to 500 chars (no stack stored: stacks go to logs only)
);
CREATE INDEX IF NOT EXISTS idx_error_project_date ON error_records(project_id, date);
CREATE TABLE IF NOT EXISTS schedule_state (    -- schedule runtime state (files are declarative intent; the system never writes back)
  project_id      TEXT NOT NULL,
  agent_id        TEXT NOT NULL,
  name            TEXT NOT NULL,               -- file name (without .toml) doubles as the identifier
  creator_user_id TEXT,                        -- creator (recorded on API create; hand-edited file reconciliation falls back to the Project owner)
  start_at_ms     INTEGER NOT NULL,            -- defines identity: a start_at change counts as a new task instance, resetting fire state
  def_hash        TEXT NOT NULL,               -- file content fingerprint: any change clears the invalid flag (the file takes effect again after edits)
  last_slot_ms    INTEGER,                     -- latest due slot already consumed (advances on fire or skip; no re-fire across restarts)
  last_fired_at   TEXT,                        -- last actual fire time (for display)
  fired_once      INTEGER NOT NULL DEFAULT 0,  -- one-shot task has fired
  missed          INTEGER NOT NULL DEFAULT 0,  -- one-shot task was missed (flagged by startup/registration reconciliation; not backfilled)
  invalid_reason  TEXT,                        -- invalidation reason (e.g. the bound Session was deleted); NULL=healthy
  PRIMARY KEY (project_id, agent_id, name)
);
CREATE TABLE IF NOT EXISTS unattended_bindings ( -- per-task unattended authorization binding (who/where may this task ever run); shape = migrations/steps/2026-11-06-unattended-scheduling
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
CREATE TABLE IF NOT EXISTS unattended_runs ( -- durable per-fire run ledger (one row per scheduled slot; UNIQUE = idempotency); shape = migrations/steps/2026-11-06-unattended-scheduling
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
CREATE TABLE IF NOT EXISTS unattended_lifecycle ( -- service lifecycle / blocked-fire audit records; shape = migrations/steps/2026-11-06-unattended-scheduling
  event_id    TEXT PRIMARY KEY,
  at          TEXT NOT NULL,
  kind        TEXT NOT NULL,             -- startup_reconcile | shutdown | tick_gap_suspected | fire_blocked | fire_needs_approval | fire_executed_after_cancel | fire_settled_after_cancel | cancel_signal_failed
  detail_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS messaging_bindings ( -- Session ↔ messaging-channel bot bindings (runtime/messaging/ holds the long connections)
  session_id       TEXT NOT NULL,              -- a Session keeps at most one saved config PER channel (composite PK below); at most ONE of them is enabled at a time (route-enforced, 409 another_channel_enabled), and enabling is what binds the account to this Session
  channel          TEXT NOT NULL,              -- messaging channel discriminator ('feishu' | 'telegram' | 'qq' | 'wechat')
  account_id       TEXT NOT NULL,              -- channel-scoped bot/app identity (feishu: app_id; telegram: the bot token's numeric id; qq: the bot's App ID; wechat: the scanned bot id); NOT unique — any number of Sessions may keep the same account saved side by side, each with its own config and last-chat memory; only ENABLING is exclusive (route-enforced, 409 account_enabled_elsewhere: one account has one event stream, two live connections on it would race)
  config_json      TEXT NOT NULL,              -- channel-specific credentials/config JSON (feishu: appId/appSecret/baseDomain; telegram: botToken; qq: appId/appSecret; wechat: botId/botToken/baseUrl/userId); secrets plaintext at rest (same trade-off as the proxy address in server_settings), masked at every API surface; a cleared secret is stored as "" (the row and its account identity stay)
  enabled          INTEGER NOT NULL DEFAULT 0, -- INTENT state (the connection's runtime status stays in memory): new bindings start disabled — saving credentials never opens a connection, the explicit state toggle does
  line_per_message INTEGER NOT NULL DEFAULT 0, -- delivery preference: 1 = every non-blank line of a relayed assistant reply is sent as its own message (a reply written as spoken lines arrives as spoken lines), 0 = one message per reply. Channel-agnostic, so it lives here rather than in config_json, which each connector owns
  final_reply_only INTEGER NOT NULL DEFAULT 0, -- delivery preference: 1 = a run's intermediate assistant messages are held and only its LAST completed one is sent, at the run's end, 0 = every completed assistant message mirrors the moment it completes. Channel-agnostic like the column above and independent of it: with both set, that one final text is the one split per line
  render_markdown  INTEGER NOT NULL DEFAULT 1, -- delivery preference: 1 = a relayed reply's Markdown is rendered in the channel's own markup (Telegram HTML, a Feishu card, QQ markdown, the subset WeChat itself reads), 0 = the reply's characters are sent as written. DEFAULT 1 because the model writes Markdown and showing it raw was the defect; the per-channel subsets and the plain-text fallback live in the connectors
  last_chat_id     TEXT,                       -- most recent inbound chat (NULL until the bot is messaged once; replies and test messages target it); CONNECTOR-OPAQUE, not necessarily a bare chat id — telegram appends the forum topic (see telegram-connector.ts chatRefOf), so only that channel's connector may interpret it
  last_chat_is_direct INTEGER NOT NULL DEFAULT 1, -- 1 = direct chat (reply by chat id), 0 = group chat (prefer reply-to-message)
  last_inbound_message_id TEXT,                 -- channel id of the most recently PROCESSED inbound message (NULL until one arrives); the durable half of the bridge's redelivery guard, so a channel replaying an event this server already turned into a Task after a restart does not run it twice
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  PRIMARY KEY (session_id, channel)
);
CREATE INDEX IF NOT EXISTS idx_messaging_by_account ON messaging_bindings(channel, account_id);  -- serves the enable guard's by-account lookup; deliberately NOT unique, unlike its predecessor idx_messaging_account (dropped on open) which made an account exclusive to one Session forever
CREATE TABLE IF NOT EXISTS messaging_conversations ( -- per-(bot, chat) delivery state a connector must keep across reconnects and restarts (WeChat: the context token, its send count, held replies); deleted once no messaging_bindings row references (channel, account_id) — see MessagingBindingsRepo
  channel    TEXT NOT NULL,                     -- messaging channel discriminator (only 'wechat' writes rows today)
  account_id TEXT NOT NULL,                     -- the bot, as messaging_bindings.account_id names it
  chat_id    TEXT NOT NULL,                     -- the connector's own chat id (wechat: the user's ilink_user_id)
  state_json TEXT NOT NULL,                     -- connector-owned JSON (wechat: {contextToken, tokenAt, spent, held, heldSince}); the token is a conversation handle at rest, same trade-off as config_json's credentials
  updated_at TEXT NOT NULL,
  PRIMARY KEY (channel, account_id, chat_id)
);
CREATE TABLE IF NOT EXISTS ui_prefs (
  user_id    TEXT PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE,
  prefs_json TEXT NOT NULL                    -- {theme?, lastProjectId?, ...} free-form JSON
);
CREATE TABLE IF NOT EXISTS browser_extensions ( -- one row per Chrome paired to a user (builtin-browser/extension-pairing.ts): the PenguinHarness Browser extension's long-lived credential, stored only hashed; NOT rebuildable — a lost row means pairing that Chrome again
  extension_id TEXT PRIMARY KEY,              -- random id shown in the Web App's list
  user_id      TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  token_hash   TEXT NOT NULL UNIQUE,          -- sha256(token) hex; the extension alone holds the token
  name         TEXT NOT NULL,                 -- how the extension names this Chrome ("Chrome 130 on macOS")
  version      TEXT NOT NULL,                 -- the extension's version, as of its last hello
  created_at   TEXT NOT NULL,
  last_seen_at TEXT,                          -- last connect or disconnect; NULL = never connected
  revoked_at   TEXT                           -- set by Revoke; a revoked token's socket is closed 4003
);
CREATE INDEX IF NOT EXISTS idx_browser_extensions_user ON browser_extensions(user_id);
CREATE TABLE IF NOT EXISTS agent_api (          -- per-Agent public API settings (amsp/routes.ts); NOT rebuildable from files
  project_id    TEXT NOT NULL,
  agent_id      TEXT NOT NULL,
  enabled       INTEGER NOT NULL DEFAULT 0,     -- the API tab's switch; off = every /api/amsp request for it is 404 agent_not_found
  open          INTEGER NOT NULL DEFAULT 0,     -- keyless access: a request without Authorization is accepted; off = 401 unauthorized
  approval_mode TEXT NOT NULL DEFAULT 'allow-all', -- copied onto each new API Session
  provider      TEXT,                         -- NULL pair follows the Project default model
  model_id      TEXT,
  thinking_level TEXT,                        -- NULL follows Agent/Project configuration
  workspace     TEXT,                         -- NULL creates a temporary Workspace
  max_concurrent_runs INTEGER NOT NULL DEFAULT 4,
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (project_id, agent_id)
);
CREATE TABLE IF NOT EXISTS agent_api_keys (     -- one row per key the API tab or the CLI minted; the caller alone holds the key
  key_id       TEXT PRIMARY KEY,                -- 16 base64url chars, shown in the list
  project_id   TEXT NOT NULL,
  agent_id     TEXT NOT NULL,
  token_hash   TEXT NOT NULL UNIQUE,            -- sha256(key) hex
  prefix       TEXT NOT NULL,                   -- the key's first 16 characters ("penguin_" + 8), shown in the list
  name         TEXT NOT NULL,                   -- 1-64 characters
  created_by   TEXT NOT NULL REFERENCES users(user_id),
  created_at   TEXT NOT NULL,
  last_used_at TEXT                             -- stamped once per run request that authenticated with it; NULL = never
);
CREATE INDEX IF NOT EXISTS idx_agent_api_keys_agent ON agent_api_keys(project_id, agent_id);
CREATE TABLE IF NOT EXISTS server_settings (   -- admin-level server-global settings (GET/PUT /api/admin/settings)
  key   TEXT PRIMARY KEY,                     -- setting name, e.g. 'proxy_for_app'
  value TEXT NOT NULL                         -- JSON-encoded value; an absent row means the setting's built-in default
);
CREATE TABLE IF NOT EXISTS machine (           -- this server's OWN identity, minted here and never assigned from outside (what 'penguin server status' reports)
  singleton  INTEGER PRIMARY KEY CHECK (singleton = 1),  -- exactly one row, enforced by the schema rather than by convention
  machine_id TEXT NOT NULL                    -- 16 base64url characters; what every stored reference to this machine points at
);
CREATE TABLE IF NOT EXISTS machines (          -- one row per machine this server installed on or reached (machines/service.ts)
  address      TEXT PRIMARY KEY,               -- 'ssh:<alias>'
  machine_id   TEXT,                           -- that machine's own id, once heard
  version      TEXT,                           -- what this server last installed there; NULL = never
  installed_at TEXT,
  session_pid  INTEGER,                        -- the ssh session this server holds to it; what a successor App closes after a hot swap
  remote_port  INTEGER,                        -- its server's port over there, as of the last connect
  platform     TEXT,                           -- linux | darwin | win32, as the install found it: the shell dialect the status probe speaks to it in
  adopted_at   TEXT                            -- when this server first recorded this machine (reset when the address answers with another machine's id): Sessions it held before then read as CLI tasks through this server. NULL = recorded before the column existed; never filled in later, and the rule does not apply
);
CREATE TABLE IF NOT EXISTS machine_project (   -- which machines a Project uses; no row = none yet. Follows the Project out, like project_members
  project_id TEXT PRIMARY KEY REFERENCES projects(project_id) ON DELETE CASCADE,
  addresses  TEXT NOT NULL                     -- JSON array of 'ssh:<alias>'
);
CREATE TABLE IF NOT EXISTS trace_files (       -- DERIVED CACHE of the on-disk Trace tree (services/trace-index.ts): the directories stay the single source of truth, every row is rebuildable from disk, and a row is never authority for absence — consumers reconcile + retry on a miss, so a stale index costs one extra scan, never a false 404
  project_id TEXT NOT NULL,
  agent_id   TEXT NOT NULL,
  session_id TEXT NOT NULL,
  file_index INTEGER NOT NULL,               -- shard index NNN of <session_id>_NNN.jsonl (name/path are reconstructed from the row, never stored: the data root may move)
  date       TEXT NOT NULL,                  -- date directory name (local yyyy-mm-dd)
  size_bytes INTEGER NOT NULL,               -- last observed size (listings stat-refresh the returned page and write back; an actively-appended shard may lag in between)
  page_stats TEXT,                           -- cached message-window scan state at this shard's END (services/message-window.ts ShardPrefixRecord JSON); immutable shards only, NULL = not yet computed, nulled whenever size_bytes changes
  PRIMARY KEY (project_id, agent_id, session_id, file_index)
);
CREATE INDEX IF NOT EXISTS idx_trace_files_agent_date ON trace_files(project_id, agent_id, date);
CREATE INDEX IF NOT EXISTS idx_trace_files_session ON trace_files(session_id);
CREATE TABLE IF NOT EXISTS trace_sessions (    -- per-session facts read ONCE at registration from the earliest shard's head (same derived-cache rules as trace_files; listing needs zero head-reads)
  session_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  agent_id   TEXT NOT NULL,
  source     TEXT,                           -- session_meta source as the head carried it: 'user' | 'api' | 'schedule' | 'subagent' | 'cli' | 'company'; NULL = the head records none (written before the source was required: read as 'company' for an 'org' row, else 'user' — readRecordedSource); 'benchmark' from older rows reads as 'cli' (normalizeSessionSource; meaningless while meta_read = 0)
  workspace  TEXT NOT NULL DEFAULT '',
  title      TEXT,                           -- first-prompt fallback title (sessions.title always wins when present)
  provider   TEXT,                           -- model reference from session_meta: the model the Session was created on (CLI adoption reads it from here, and the runtime's own answer corrects the row at load; NULL = meta unreadable / legacy without provider)
  model_id   TEXT,
  first_ts   TEXT,                           -- first record's timestamp (adoption's createdAt fallback when the id embeds no time)
  meta_read  INTEGER NOT NULL DEFAULT 0      -- 1 once the head parsed; 0 = facts unknown, retried by the next reconcile that touches the session
);
CREATE INDEX IF NOT EXISTS idx_trace_sessions_agent ON trace_sessions(project_id, agent_id);
CREATE TABLE IF NOT EXISTS org_sessions (      -- DERIVED CACHE (company mode): desk sessions, rebuilt from each organization's desks.toml (current + previous); trigger_hop is mention-chain accounting and reads 0 after a rebuild
  session_id  TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL,
  org_id      TEXT NOT NULL,
  agent_id    TEXT NOT NULL,
  current     INTEGER NOT NULL DEFAULT 1,
  trigger_hop INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_org_sessions_org ON org_sessions(project_id, org_id);
CREATE TABLE IF NOT EXISTS org_ticket_sessions ( -- DERIVED CACHE (company mode): ticket <-> contributing session, rebuilt from each ticket's Sessions header
  project_id  TEXT NOT NULL,
  org_id      TEXT NOT NULL,
  ticket_id   TEXT NOT NULL,
  session_id  TEXT NOT NULL,
  agent_id    TEXT NOT NULL,
  trigger_hop INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (project_id, org_id, ticket_id, session_id)
);
CREATE INDEX IF NOT EXISTS idx_org_ticket_sessions_session ON org_ticket_sessions(session_id);
CREATE TABLE IF NOT EXISTS org_calendar_state ( -- calendar run state (company mode; the files are declarative intent), same rules as schedule_state
  project_id     TEXT NOT NULL,
  org_id         TEXT NOT NULL,
  agent_id       TEXT NOT NULL,
  name           TEXT NOT NULL,
  start_at_ms    INTEGER NOT NULL,
  def_hash       TEXT NOT NULL,
  last_slot_ms   INTEGER,
  last_fired_at  TEXT,
  fired_once     INTEGER NOT NULL DEFAULT 0,
  missed         INTEGER NOT NULL DEFAULT 0,
  invalid_reason TEXT,
  last_outcome   TEXT,
  PRIMARY KEY (project_id, org_id, agent_id, name)
);
CREATE TABLE IF NOT EXISTS org_ticket_state (   -- DERIVED CACHE (company mode): the last (status, owner, blocked) seen per ticket, so a change is notified once; rebuilt silently from the ticket files
  project_id  TEXT NOT NULL,
  org_id      TEXT NOT NULL,
  ticket_id   TEXT NOT NULL,
  status      TEXT NOT NULL,
  owner       TEXT NOT NULL DEFAULT '',
  blocked     TEXT NOT NULL DEFAULT '',
  blocked_by  TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (project_id, org_id, ticket_id)
);
CREATE TABLE IF NOT EXISTS org_channel_state ( -- DERIVED CACHE (company mode): tail-scan byte cursor per channel and day file
  project_id   TEXT NOT NULL,
  org_id       TEXT NOT NULL,
  channel_id   TEXT NOT NULL,
  date         TEXT NOT NULL,
  offset_bytes INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (project_id, org_id, channel_id, date)
);
CREATE TABLE IF NOT EXISTS org_channel_reads ( -- user data (company mode): each user's read cursor in one channel
  project_id   TEXT NOT NULL,
  org_id       TEXT NOT NULL,
  channel_id   TEXT NOT NULL,
  user_id      TEXT NOT NULL,
  last_read_id TEXT NOT NULL,
  PRIMARY KEY (project_id, org_id, channel_id, user_id)
);
CREATE TABLE IF NOT EXISTS org_budget_state (   -- DERIVED CACHE (company mode): warn / pause marks per employee and period, recomputed from usage and the chart's budgets
  project_id TEXT NOT NULL,
  org_id     TEXT NOT NULL,
  agent_id   TEXT NOT NULL,
  period     TEXT NOT NULL,
  warned_at  TEXT,
  paused_at  TEXT,
  PRIMARY KEY (project_id, org_id, agent_id, period)
);
CREATE TABLE IF NOT EXISTS org_desk_notices (   -- DERIVED CACHE (company mode): ticket changes waiting for an employee's next calendar sweep; dropping it loses only the digests not delivered yet
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  org_id     TEXT NOT NULL,
  agent_id   TEXT NOT NULL,
  ticket_id  TEXT NOT NULL,
  change     TEXT NOT NULL,
  at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_org_desk_notices_agent ON org_desk_notices(project_id, org_id, agent_id);
CREATE TABLE IF NOT EXISTS qa_documents (       -- project-scoped source documents; current content is the latest immutable revision
  document_id         TEXT PRIMARY KEY,
  project_id          TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  title               TEXT NOT NULL,
  format              TEXT NOT NULL,            -- markdown|text|json|csv|html
  status              TEXT NOT NULL,            -- active|archived
  source_json         TEXT NOT NULL,            -- {type,ref?,filename?,capturedAt?}
  revision            INTEGER NOT NULL,         -- optimistic concurrency + status changes
  current_revision    INTEGER NOT NULL,         -- latest content revision
  current_revision_id TEXT NOT NULL,
  content_hash        TEXT NOT NULL,            -- sha256:<hex>
  byte_size           INTEGER NOT NULL,
  created_at          TEXT NOT NULL,
  created_by          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  updated_by          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_qa_documents_project_updated ON qa_documents(project_id, status, updated_at DESC, document_id DESC);
CREATE TABLE IF NOT EXISTS qa_document_revisions ( -- immutable document revisions
  revision_id    TEXT PRIMARY KEY,
  document_id    TEXT NOT NULL REFERENCES qa_documents(document_id) ON DELETE CASCADE,
  project_id     TEXT NOT NULL,
  revision       INTEGER NOT NULL,
  title          TEXT NOT NULL,
  content        TEXT NOT NULL,
  encoding       TEXT NOT NULL,                 -- utf8
  content_hash   TEXT NOT NULL,
  byte_size      INTEGER NOT NULL,
  change_note    TEXT NOT NULL DEFAULT '',
  source_json    TEXT NOT NULL,
  author_user_id TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  UNIQUE(document_id, revision)
);
CREATE INDEX IF NOT EXISTS idx_qa_document_revisions_doc ON qa_document_revisions(document_id, revision DESC);
CREATE TABLE IF NOT EXISTS qa_knowledge_candidates ( -- agent/user evidence candidates; never a rule until the owner confirms
  candidate_id      TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  title             TEXT NOT NULL,
  statement         TEXT NOT NULL,
  rationale         TEXT NOT NULL DEFAULT '',
  scope_json        TEXT NOT NULL,              -- {"level":"project"}
  source_refs_json  TEXT NOT NULL,              -- EvidenceRef[]
  status            TEXT NOT NULL,              -- pending|accepted|rejected
  revision          INTEGER NOT NULL,
  created_by_json   TEXT NOT NULL,              -- {"type":"user"|"agent",...}
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  reviewed_by       TEXT,
  reviewed_at       TEXT,
  review_note       TEXT NOT NULL DEFAULT '',
  confirmed_rule_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_qa_candidates_project_status ON qa_knowledge_candidates(project_id, status, created_at DESC, candidate_id DESC);
CREATE TABLE IF NOT EXISTS qa_project_rules (   -- confirmed project knowledge; current version is the latest immutable qa_rule_versions row
  rule_id             TEXT PRIMARY KEY,
  project_id          TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  status              TEXT NOT NULL,            -- active|retired
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
CREATE TABLE IF NOT EXISTS qa_rule_versions (   -- immutable rule versions, including retire events
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
CREATE TABLE IF NOT EXISTS qa_task_context_snapshots ( -- append-only task-start pins; never rewritten
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
CREATE TABLE IF NOT EXISTS qa_design_batches (  -- immutable test design batch per run; revisions append
  batch_id          TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  session_id        TEXT NOT NULL,
  run_id            TEXT NOT NULL,
  revision          INTEGER NOT NULL,
  status            TEXT NOT NULL,             -- open|frozen
  source_json       TEXT NOT NULL,
  test_point_count  INTEGER NOT NULL,
  test_case_count   INTEGER NOT NULL,
  content_hash      TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  created_by        TEXT NOT NULL,
  UNIQUE(session_id, run_id, revision)
);
CREATE INDEX IF NOT EXISTS idx_qa_design_batches_run ON qa_design_batches(project_id, session_id, run_id, revision DESC);
CREATE TABLE IF NOT EXISTS qa_test_points (     -- test points with EvidenceRef basis
  row_id             TEXT PRIMARY KEY,
  batch_id           TEXT NOT NULL REFERENCES qa_design_batches(batch_id) ON DELETE CASCADE,
  project_id         TEXT NOT NULL,
  point_key          TEXT NOT NULL,
  module             TEXT NOT NULL,
  feature            TEXT NOT NULL,
  description        TEXT NOT NULL,
  risk               TEXT NOT NULL,             -- high|medium|low
  coverage_type_json TEXT NOT NULL,
  evidence_refs_json TEXT NOT NULL,
  source             TEXT NOT NULL DEFAULT '',
  source_locator     TEXT NOT NULL DEFAULT '',
  execution_layer    TEXT,
  created_at         TEXT NOT NULL,
  UNIQUE(batch_id, point_key)
);
CREATE TABLE IF NOT EXISTS qa_test_cases (      -- test cases with EvidenceRef basis and point traceability
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
CREATE TABLE IF NOT EXISTS qa_case_results (    -- latest result per run/case; absence means not run
  result_id          TEXT PRIMARY KEY,
  project_id         TEXT NOT NULL,
  session_id         TEXT NOT NULL,
  run_id             TEXT NOT NULL,
  batch_id           TEXT NOT NULL,
  case_key           TEXT NOT NULL,
  status             TEXT NOT NULL,             -- passed|failed|skipped|blocked
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
CREATE TABLE IF NOT EXISTS qa_defects (         -- project-level defect aggregated by fingerprint
  defect_id          TEXT PRIMARY KEY,
  project_id         TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  fingerprint        TEXT NOT NULL,
  title              TEXT NOT NULL,
  category           TEXT NOT NULL,
  status             TEXT NOT NULL,             -- draft|needs_review|confirmed|rejected|fixed|closed
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
CREATE TABLE IF NOT EXISTS qa_defect_occurrences ( -- every run/case where the same fingerprint appeared
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
CREATE TABLE IF NOT EXISTS qa_defect_events (   -- append-only lifecycle chain
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
CREATE TABLE IF NOT EXISTS qa_retests (         -- sealed retest batches; never rewrite origin results
  retest_id          TEXT PRIMARY KEY,
  defect_id          TEXT NOT NULL REFERENCES qa_defects(defect_id) ON DELETE CASCADE,
  project_id         TEXT NOT NULL,
  session_id         TEXT NOT NULL,
  run_id             TEXT NOT NULL,
  batch_id           TEXT NOT NULL,
  result             TEXT NOT NULL,             -- passed|failed
  case_results_json  TEXT NOT NULL,
  evidence_refs_json TEXT NOT NULL,
  created_at         TEXT NOT NULL,
  created_by         TEXT NOT NULL,
  UNIQUE(defect_id, run_id)
);
CREATE TABLE IF NOT EXISTS qa_report_indexes (  -- immutable report evidence index revisions
  report_id           TEXT PRIMARY KEY,
  project_id          TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  session_id          TEXT NOT NULL,
  run_id              TEXT NOT NULL,
  batch_id            TEXT NOT NULL,
  revision            INTEGER NOT NULL,
  status              TEXT NOT NULL,            -- published|superseded
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
CREATE TABLE IF NOT EXISTS invocation_authorization_decisions ( -- append-only per-invocation decisions
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
CREATE TABLE IF NOT EXISTS published_resource_state ( -- last verified publication pointer
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
CREATE TABLE IF NOT EXISTS task_content_snapshots ( -- actual skill/plugin/model evidence per session
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
`;
