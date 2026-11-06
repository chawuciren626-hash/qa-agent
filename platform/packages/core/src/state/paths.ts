/**
 * Local directory layout for Agent State and Project config.
 *
 * Strictly follows the `~/.penguin/data/<project>/agents/<agent>/...` structure.
 * This module only provides constants and pure path functions; it never creates directories or reads/writes files.
 * Docs: /docs/sessions-and-traces § "Data layout".
 */
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

/** Default Project id used when none is specified. */
export const DEFAULT_PROJECT_ID = "default_project";

/** Default Agent id used when none is specified. */
export const DEFAULT_AGENT_ID = "default_agent";

/**
 * Resolves the local data root directory.
 * Prefers the `PENGUIN_HOME` environment variable, otherwise falls back to `~/.penguin/data`
 * (under the hidden `~/.penguin` home so it never collides with unrelated folders, and in a
 * `data/` subdir kept separate from the installer's binaries under `~/.penguin`).
 */
export function resolveRoot(): string {
  return process.env.PENGUIN_HOME ?? path.join(os.homedir(), ".penguin", "data");
}

/** `<root>/<projectId>`. */
export function projectDir(root: string, projectId: string): string {
  return path.join(root, projectId);
}

/**
 * `<projectDir>/agents` from an already-resolved Project directory path — the single
 * definition point of the agents-container layout.
 */
export function agentsDirFrom(projectDirPath: string): string {
  return path.join(projectDirPath, "agents");
}

/** `<projectDir>/agents`, the container directory holding every Agent in the Project. */
export function agentsDir(root: string, projectId: string): string {
  return agentsDirFrom(projectDir(root, projectId));
}

/** `<projectDir>/agents/<agentId>`. */
export function agentDir(root: string, projectId: string, agentId: string): string {
  return path.join(agentsDir(root, projectId), agentId);
}

/** `<agentDir>/agent_state`. */
export function agentStateDir(root: string, projectId: string, agentId: string): string {
  return path.join(agentDir(root, projectId, agentId), "agent_state");
}

/** `<agentDir>/traces`. */
export function tracesDir(root: string, projectId: string, agentId: string): string {
  return path.join(agentDir(root, projectId, agentId), "traces");
}

/** `<agentDir>/scratchpad`, the Agent's temporary/draft file directory (the model creates a subdirectory per Session id). */
export function scratchpadDir(root: string, projectId: string, agentId: string): string {
  return path.join(agentDir(root, projectId, agentId), "scratchpad");
}

/** `<agentDir>/workspaces`. */
export function workspacesDir(root: string, projectId: string, agentId: string): string {
  return path.join(agentDir(root, projectId, agentId), "workspaces");
}

/**
 * `<agentDir>/scratchpad/<sessionId>`, one Session's private scratchpad directory. The single
 * Session-scoped storage root shared by every by-product bound to that Session: input images
 * saved as path lines, the goal-mode control file, and Environment's truncated-tool-output
 * recovery files. Deleted together with the Session by the existing scratchpad cleanup path.
 */
export function sessionScratchpadDir(
  root: string,
  projectId: string,
  agentId: string,
  sessionId: string,
): string {
  return path.join(scratchpadDir(root, projectId, agentId), sessionId);
}

/**
 * `<projectDir>/.project_config.toml`, the Project's single config file (a hidden file, not
 * shown by default `ls`, written with mode 0600; model entries are inlined with their credential,
 * see state/project-config.ts).
 */
export function projectConfigPath(root: string, projectId: string): string {
  return path.join(projectDir(root, projectId), ".project_config.toml");
}

/** `<agentStateDir>/system_config.yaml`. */
export function systemConfigPath(root: string, projectId: string, agentId: string): string {
  return path.join(agentStateDir(root, projectId, agentId), "system_config.yaml");
}

/** `<agentStateDir>/AGENTS.md`. */
export function agentsMdPath(root: string, projectId: string, agentId: string): string {
  return path.join(agentStateDir(root, projectId, agentId), "AGENTS.md");
}

/** `<agentStateDir>/.vault.toml`, the Agent-level environment-variable vault (see state/agent-vault.ts). */
export function agentVaultPath(root: string, projectId: string, agentId: string): string {
  return path.join(agentStateDir(root, projectId, agentId), ".vault.toml");
}

/** `<agentStateDir>/tools`, reserved for user-defined Tool config. */
export function toolsDir(root: string, projectId: string, agentId: string): string {
  return path.join(agentStateDir(root, projectId, agentId), "tools");
}

/** `<agentStateDir>/memory`, the Memory root (one subdirectory per scope, see state/memory.ts). */
export function memoryDir(root: string, projectId: string, agentId: string): string {
  return path.join(agentStateDir(root, projectId, agentId), "memory");
}

/**
 * `<agentStateDir>/memory/<scopeKey>`, one Memory scope's topic-file directory — the `user`
 * scope or one Workspace's key. Each scope carries its own `MEMORY.md` index inside.
 */
export function memoryScopeDir(
  root: string,
  projectId: string,
  agentId: string,
  scopeKey: string,
): string {
  return path.join(memoryDir(root, projectId, agentId), scopeKey);
}

/**
 * `<agentStateDir>/memory-snapshots`, the task-start memory snapshots. One directory per
 * Session, one JSON file per context; metadata only (see state/user-preferences.ts).
 */
export function memorySnapshotsDir(root: string, projectId: string, agentId: string): string {
  return path.join(agentStateDir(root, projectId, agentId), "memory-snapshots");
}

/**
 * The data root's local-user container (`<root>/.local-users`). The leading dot is outside the
 * Project id rule, so no Project directory can collide with it.
 */
export function userPreferencesRoot(root: string): string {
  return path.join(root, ".local-users");
}

/**
 * `<root>/.local-users/<u-…>/preferences`, one authenticated user's cross-project preference
 * store. The segment is a hash; ownership is recorded in the directory's own marker.
 */
export function userPreferencesDir(root: string, userId: string): string {
  const key = createHash("sha256").update(userId, "utf8").digest("hex").slice(0, 16);
  return path.join(userPreferencesRoot(root), `u-${key}`, "preferences");
}

/** `<agentStateDir>/skills`. */
export function skillsDir(root: string, projectId: string, agentId: string): string {
  return path.join(agentStateDir(root, projectId, agentId), "skills");
}

/** `<agentStateDir>/hooks`: the installed hook packages, one directory per plugin (see agent-state.ts installHook). */
export function hooksDir(root: string, projectId: string, agentId: string): string {
  return path.join(agentStateDir(root, projectId, agentId), "hooks");
}

/** `<agentStateDir>/schedule`, the scheduled-task directory (doesn't exist when unconfigured). */
export function scheduleDir(root: string, projectId: string, agentId: string): string {
  return path.join(agentStateDir(root, projectId, agentId), "schedule");
}

/**
 * `<projectDir>/benchmarks`, the Project's capability-evaluation question banks and scores, a
 * sibling of `agents/` (doesn't exist when unconfigured). A Benchmark is a peer of an Agent, not
 * something an Agent owns: one Benchmark can evaluate several Agents, and the Agent under test is
 * recorded on each scoreboard evaluation. Benchmarks written under an Agent directory by an
 * earlier version are not read from here.
 */
export function benchmarksDir(root: string, projectId: string): string {
  return path.join(projectDir(root, projectId), "benchmarks");
}

/** `<agentDir>/snapshots`, Agent State version snapshots (doesn't exist when unconfigured). */
export function snapshotsDir(root: string, projectId: string, agentId: string): string {
  return path.join(agentDir(root, projectId, agentId), "snapshots");
}
