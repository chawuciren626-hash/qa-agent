#!/usr/bin/env node
/**
 * Read-only inventory of a PenguinHarness data root's memory layout.
 *
 * It reports what exists, who owns it, how big it is and what each file hashes to. It never
 * prints a memory body, a credential or a vault value: only the memory scopes, the indexes,
 * snapshot metadata files and the local-user preference store are visited, and none of their
 * contents are echoed (hashes are computed from bytes, not decoded).
 *
 * Usage:
 *   node scripts/memory-inventory.mjs --root <data-root> [--out inventory.json] [--pretty]
 *   node scripts/memory-inventory.mjs --fixture <empty-dir>   # synthetic old layout for dev
 *
 * The data root is explicit and required. The scan is always read-only; `--dry-run` is
 * accepted so a caller can be explicit about it.
 */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SCHEMA_VERSION = 1;
const LEGACY_USER_SCOPE = "user";
const SNAPSHOT_PREFIX = "snap-";
const PREFERENCE_MARKER = ".owner.json";

function usage(exitCode = 0) {
  const text = [
    "Usage:",
    "  node scripts/memory-inventory.mjs --root <data-root> [--out <file>] [--pretty] [--dry-run]",
    "  node scripts/memory-inventory.mjs --fixture <empty-dir>",
    "",
    "The inventory is read-only and prints JSON. Memory bodies and credentials are never included.",
  ].join("\n");
  (exitCode === 0 ? process.stdout : process.stderr).write(`${text}\n`);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const args = { root: null, out: null, pretty: false, fixture: null, dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`${arg} needs a value`);
      i += 1;
      return argv[i];
    };
    switch (arg) {
      case "--root":
        args.root = next();
        break;
      case "--out":
        args.out = next();
        break;
      case "--fixture":
        args.fixture = next();
        break;
      case "--pretty":
        args.pretty = true;
        break;
      case "--dry-run":
        args.dryRun = true;
        break;
      case "-h":
      case "--help":
        usage(0);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

async function sha256File(file) {
  const hash = createHash("sha256");
  hash.update(await fs.readFile(file));
  return hash.digest("hex");
}

async function lstatOrNull(target) {
  try {
    return await fs.lstat(target);
  } catch {
    return null;
  }
}

/** Directory entries, sorted, with symlinks and non-directories left out of scope walks. */
async function listDirs(dir) {
  let names;
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  const dirs = [];
  for (const name of names.sort()) {
    if (name.startsWith(".")) continue;
    const full = path.join(dir, name);
    const stat = await lstatOrNull(full);
    if (stat?.isDirectory() && !stat.isSymbolicLink()) dirs.push({ name, full });
  }
  return dirs;
}

async function listFiles(dir) {
  let names;
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  const files = [];
  for (const name of names.sort()) {
    const full = path.join(dir, name);
    const stat = await lstatOrNull(full);
    if (!stat) continue;
    files.push({ name, full, stat });
  }
  return files;
}

/** Links named by a MEMORY.md index. The index is the only file whose text is read. */
async function indexReferences(indexFile) {
  let text;
  try {
    text = await fs.readFile(indexFile, "utf8");
  } catch {
    return { references: [], missingReferences: [] };
  }
  const names = new Set();
  for (const match of text.matchAll(/\]\(([^)\s]+\.md)\)/g)) names.add(path.basename(match[1]));
  // Older/hand-written indexes list a bare file name; accept only plain topics, never paths.
  for (const match of text.matchAll(/(?:^|[\s(`])([A-Za-z0-9._-]+\.md)(?:$|[\s)`])/gm)) {
    if (match[1] !== "MEMORY.md") names.add(match[1]);
  }
  const existing = new Set(
    (await listFiles(path.dirname(indexFile)))
      .filter((file) => file.stat.isFile() && !file.stat.isSymbolicLink())
      .map((file) => file.name),
  );
  const references = [...names].sort();
  return {
    references,
    missingReferences: references.filter((name) => !existing.has(name)),
  };
}

async function describeFile(entry, kind, extra = {}) {
  const stat = entry.stat;
  if (stat.isSymbolicLink()) {
    return {
      name: entry.name,
      kind,
      status: "skipped_symlink",
      size: 0,
      ...extra,
    };
  }
  if (!stat.isFile()) {
    return { name: entry.name, kind, status: "skipped_not_file", size: 0, ...extra };
  }
  return {
    name: entry.name,
    kind,
    status: "present",
    size: stat.size,
    sha256: await sha256File(entry.full),
    modifiedAt: stat.mtime.toISOString(),
    ...extra,
  };
}

async function scanScope(dir, scopeKey) {
  const stat = await lstatOrNull(dir);
  const kind = scopeKey === LEGACY_USER_SCOPE ? "project_agent" : "workspace";
  if (!stat) {
    return {
      scopeKey,
      kind,
      status: "missing",
      dir,
      files: [],
      references: [],
      missingReferences: [],
    };
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    return {
      scopeKey,
      kind,
      status: "skipped_symlink",
      dir,
      files: [],
      references: [],
      missingReferences: [],
    };
  }
  const files = await listFiles(dir);
  const described = [];
  let references = [];
  let missingReferences = [];
  let workspacePath = null;
  for (const file of files) {
    if (file.name === "MEMORY.md" && file.stat.isFile()) {
      const refs = await indexReferences(file.full);
      references = refs.references;
      missingReferences = refs.missingReferences;
      described.push(await describeFile(file, "index", { references: refs.references }));
    } else if (file.name === ".workspace") {
      try {
        workspacePath = (await fs.readFile(file.full, "utf8")).trim() || null;
      } catch {
        workspacePath = null;
      }
      described.push(await describeFile(file, "workspace_marker"));
    } else if (file.name.endsWith(".md")) {
      described.push(await describeFile(file, "topic"));
    } else {
      described.push(await describeFile(file, "other"));
    }
  }
  const hasIndex = described.some((file) => file.kind === "index");
  return {
    scopeKey,
    kind,
    status: "present",
    dir,
    workspacePath: kind === "workspace" ? workspacePath : null,
    files: described,
    references,
    missingReferences,
    ...(hasIndex ? {} : { missing: ["MEMORY.md"] }),
  };
}

async function scanSnapshots(dir) {
  const stat = await lstatOrNull(dir);
  if (!stat) {
    return { status: "missing", dir, sessions: [] };
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    return { status: "skipped_symlink", dir, sessions: [] };
  }
  const sessions = [];
  for (const sessionDir of await listDirs(dir)) {
    const files = [];
    for (const file of await listFiles(sessionDir.full)) {
      if (!file.name.endsWith(".json")) continue;
      files.push(
        await describeFile(file, "snapshot", { sessionId: sessionDir.name }),
      );
    }
    sessions.push({ sessionId: sessionDir.name, files });
  }
  return { status: "present", dir, sessions };
}

async function scanAgent(root, projectId, agentId, agentDir) {
  const memoryDir = path.join(agentDir, "agent_state", "memory");
  const memoryStat = await lstatOrNull(memoryDir);
  const scopes = [];
  if (memoryStat?.isDirectory() && !memoryStat.isSymbolicLink()) {
    for (const scopeDir of await listDirs(memoryDir)) {
      scopes.push(await scanScope(scopeDir.full, scopeDir.name));
    }
  } else {
    scopes.push({
      scopeKey: LEGACY_USER_SCOPE,
      kind: "project_agent",
      status: memoryStat === null ? "missing" : "skipped_symlink",
      dir: path.join(memoryDir, LEGACY_USER_SCOPE),
      files: [],
      references: [],
      missingReferences: [],
    });
  }
  const snapshots = await scanSnapshots(
    path.join(agentDir, "agent_state", "memory-snapshots"),
  );
  return {
    projectId,
    agentId,
    agentDir,
    memoryDir,
    memoryStatus: memoryStat === null ? "missing" : "present",
    scopes,
    snapshots,
  };
}

async function scanLocalUsers(root) {
  const base = path.join(root, ".local-users");
  const stat = await lstatOrNull(base);
  if (!stat) return { dir: base, status: "missing", users: [] };
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    return { dir: base, status: "skipped_symlink", users: [] };
  }
  const users = [];
  for (const userDir of await listDirs(base)) {
    const prefsDir = path.join(userDir.full, "preferences");
    const prefsStat = await lstatOrNull(prefsDir);
    let ownerUserId = null;
    if (prefsStat?.isDirectory() && !prefsStat.isSymbolicLink()) {
      try {
        const marker = JSON.parse(
          await fs.readFile(path.join(prefsDir, PREFERENCE_MARKER), "utf8"),
        );
        ownerUserId = typeof marker?.userId === "string" ? marker.userId : null;
      } catch {
        ownerUserId = null;
      }
    }
    const files = [];
    if (prefsStat?.isDirectory() && !prefsStat.isSymbolicLink()) {
      for (const file of await listFiles(prefsDir)) {
        if (file.name === PREFERENCE_MARKER) {
          files.push(await describeFile(file, "owner_marker"));
        } else if (file.name.endsWith(".json")) {
          files.push(await describeFile(file, "preference", { id: file.name.slice(0, -5) }));
        }
      }
    }
    users.push({
      key: userDir.name,
      ownerUserId,
      dir: prefsDir,
      status: prefsStat === null ? "missing" : prefsStat.isSymbolicLink() ? "skipped_symlink" : "present",
      ...(prefsStat === null ? { missing: [PREFERENCE_MARKER] } : {}),
      ...(prefsStat?.isDirectory() && !files.some((f) => f.kind === "owner_marker")
        ? { missing: [PREFERENCE_MARKER] }
        : {}),
      files,
    });
  }
  return { dir: base, status: "present", users };
}

async function inventory(root) {
  const projects = [];
  for (const projectDir of await listDirs(root)) {
    if (projectDir.name === ".local-users") continue;
    const agentsDir = path.join(projectDir.full, "agents");
    const agentsStat = await lstatOrNull(agentsDir);
    if (!agentsStat?.isDirectory() || agentsStat.isSymbolicLink()) continue;
    const agents = [];
    for (const agentDir of await listDirs(agentsDir)) {
      agents.push(await scanAgent(root, projectDir.name, agentDir.name, agentDir.full));
    }
    projects.push({ projectId: projectDir.name, dir: projectDir.full, agents });
  }
  const localUsers = await scanLocalUsers(root);

  let fileCount = 0;
  let bytes = 0;
  let missingCount = 0;
  const missing = [];
  for (const project of projects) {
    for (const agent of project.agents) {
      if (agent.memoryStatus === "missing") {
        missingCount += 1;
        missing.push({ path: agent.memoryDir, kind: "memory_dir", scope: "project_agent" });
      }
      for (const scope of agent.scopes) {
        if (scope.status === "missing") {
          missingCount += 1;
          missing.push({ path: scope.dir, kind: "scope_dir", scope: scope.kind });
          continue;
        }
        for (const name of scope.missingReferences ?? []) {
          missingCount += 1;
          missing.push({
            path: path.join(scope.dir, name),
            kind: "index_reference",
            scope: scope.kind,
          });
        }
        for (const file of scope.files ?? []) {
          fileCount += 1;
          bytes += file.size ?? 0;
        }
      }
      if (agent.snapshots.status === "missing") {
        missingCount += 1;
        missing.push({ path: agent.snapshots.dir, kind: "snapshots_dir", scope: "session_snapshot" });
      }
      for (const session of agent.snapshots.sessions) {
        fileCount += session.files.length;
        for (const file of session.files) bytes += file.size ?? 0;
      }
    }
  }
  for (const user of localUsers.users) {
    if (user.status === "missing") {
      missingCount += 1;
      missing.push({ path: user.dir, kind: "preferences_dir", scope: "local_user_preference" });
    }
    for (const name of user.missing ?? []) {
      missingCount += 1;
      missing.push({ path: path.join(user.dir, name), kind: "owner_marker", scope: "local_user_preference" });
    }
    for (const file of user.files) {
      fileCount += 1;
      bytes += file.size ?? 0;
    }
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    kind: "penguin-memory-inventory",
    generatedAt: new Date().toISOString(),
    dryRun: true,
    root,
    summary: {
      projects: projects.length,
      agents: projects.reduce((total, project) => total + project.agents.length, 0),
      scopes: {
        project_agent: projects.reduce(
          (total, project) =>
            total +
            project.agents.reduce(
              (n, agent) => n + agent.scopes.filter((scope) => scope.kind === "project_agent").length,
              0,
            ),
          0,
        ),
        workspace: projects.reduce(
          (total, project) =>
            total +
            project.agents.reduce(
              (n, agent) => n + agent.scopes.filter((scope) => scope.kind === "workspace").length,
              0,
            ),
          0,
        ),
        local_user_preference: localUsers.users.length,
        session_snapshot: projects.reduce(
          (total, project) =>
            total +
            project.agents.reduce((n, agent) => n + agent.snapshots.sessions.length, 0),
          0,
        ),
      },
      files: fileCount,
      bytes,
      missing: missingCount,
    },
    projects,
    localUsers,
    missing,
    note: "Read-only inventory. Memory bodies, credentials and vault values are never read or printed.",
  };
}

/**
 * Writes a small synthetic old-layout root so the inventory and migration tools can be
 * exercised without real data. It refuses a non-empty target.
 */
async function writeFixture(dir) {
  const target = path.resolve(dir);
  await fs.mkdir(target, { recursive: true });
  const entries = await fs.readdir(target);
  if (entries.length > 0) throw new Error("The fixture target must be empty.");
  const agentState = path.join(
    target,
    "legacy_project",
    "agents",
    "default_agent",
    "agent_state",
  );
  const legacyUser = path.join(agentState, "memory", "user");
  const workspace = path.join(agentState, "memory", "demo-app-1234abcd");
  const snapshots = path.join(agentState, "memory-snapshots", "session-2026-01-01-00-00-00-abcdef01");
  await fs.mkdir(legacyUser, { recursive: true });
  await fs.mkdir(workspace, { recursive: true });
  await fs.mkdir(snapshots, { recursive: true });
  await fs.writeFile(
    path.join(legacyUser, "MEMORY.md"),
    "# User Memory\n\n- [Tone](tone.md) — concise answers\n- [Gone](gone.md) — dangling reference\n",
  );
  await fs.writeFile(
    path.join(legacyUser, "tone.md"),
    "---\nname: tone\ndescription: concise answers\n---\n\nPrefer short answers.\n",
  );
  await fs.writeFile(
    path.join(workspace, "MEMORY.md"),
    "# Workspace Memory\n\n- [Build](build.md) — build command\n",
  );
  await fs.writeFile(path.join(workspace, ".workspace"), "/synthetic/demo-app\n");
  await fs.writeFile(
    path.join(workspace, "build.md"),
    "---\nname: build\ndescription: build command\n---\n\nRun pnpm build.\n",
  );
  await fs.writeFile(
    path.join(snapshots, "snap-0123456789abcdef01234567.json"),
    JSON.stringify(
      {
        schemaVersion: 1,
        snapshotId: "snap-0123456789abcdef01234567",
        createdAt: "2026-01-01T00:00:00.000Z",
        ownerUserId: "fixture-user",
      },
      null,
      2,
    ),
  );
  const prefs = path.join(target, ".local-users", "u-0000000000000000", "preferences");
  await fs.mkdir(prefs, { recursive: true });
  await fs.writeFile(
    path.join(prefs, PREFERENCE_MARKER),
    JSON.stringify({ schemaVersion: 1, userId: "fixture-user", createdAt: "2026-01-01T00:00:00.000Z" }),
  );
  await fs.writeFile(
    path.join(prefs, "p-0000000000000001.json"),
    JSON.stringify({
      schemaVersion: 1,
      id: "p-0000000000000001",
      title: "Fixture preference",
      content: "Synthetic content for development only.",
      contentHash: createHash("sha256").update("Synthetic content for development only.").digest("hex"),
      scope: "local_user_preference",
      ownerUserId: "fixture-user",
      source: "explicit_user_save",
      sourceTask: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      disabled: false,
      conflict: "none",
    }),
  );
  process.stdout.write(`${JSON.stringify({ fixture: target }, null, 2)}\n`);
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    usage(2);
  }
  if (args.fixture) {
    await writeFixture(args.fixture);
    return;
  }
  if (!args.root) {
    process.stderr.write("--root is required\n");
    usage(2);
  }
  const root = path.resolve(args.root);
  const stat = await lstatOrNull(root);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Data root is not a directory: ${root}`);
  }
  const report = await inventory(root);
  const text = JSON.stringify(report, null, args.pretty ? 2 : 0);
  if (args.out) {
    await fs.writeFile(path.resolve(args.out), `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify({ out: path.resolve(args.out), summary: report.summary }, null, 2)}\n`);
  } else {
    process.stdout.write(`${text}\n`);
  }
}

export { inventory as buildMemoryInventory, writeFixture as writeMemoryFixture };

const invokedDirectly =
  process.argv[1] !== undefined &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (invokedDirectly) {
  main().catch((error) => {
    process.stderr.write(`${error?.stack ?? error}\n`);
    process.exit(1);
  });
}
