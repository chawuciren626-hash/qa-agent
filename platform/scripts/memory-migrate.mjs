#!/usr/bin/env node
/**
 * Memory layout migration: classify the existing store, write one layout manifest, and leave
 * every memory file where it is.
 *
 * The rule the plan enforces: the legacy `memory/user/` scope is **project/Agent memory**
 * (`project_agent`), never the cross-project `local_user_preference` store. The two are
 * reported side by side and are never merged. `local_user_preference` lives under
 * `<root>/.local-users/` and is populated only by explicit saves or imports.
 *
 * Commands:
 *   plan      Read-only. Prints the actions, counts, missing paths and a fingerprint.
 *   apply     Re-plans, refuses a changed plan, backs up the touched manifest, writes it.
 *   verify    Compares the written manifest with the current store.
 *   rollback  Restores the manifest from a backup recorded by `apply`.
 *
 * Usage:
 *   node scripts/memory-migrate.mjs plan --root <root> --out plan.json
 *   node scripts/memory-migrate.mjs apply --root <root> --plan plan.json --confirm
 *   node scripts/memory-migrate.mjs verify --root <root> [--pretty]
 *   node scripts/memory-migrate.mjs rollback --root <root> --backup <dir> --confirm
 */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { buildMemoryInventory } from "./memory-inventory.mjs";

const SCHEMA_VERSION = 1;
const MANIFEST_FILENAME = ".memory-layout.json";
const BACKUP_DIRNAME = ".memory-backups";
const LEGACY_USER_SCOPE = "user";

function usage(exitCode = 0) {
  const text = [
    "Usage:",
    "  node scripts/memory-migrate.mjs plan --root <root> [--out <file>] [--pretty]",
    "  node scripts/memory-migrate.mjs apply --root <root> --plan <file> --confirm",
    "  node scripts/memory-migrate.mjs verify --root <root> [--pretty]",
    "  node scripts/memory-migrate.mjs rollback --root <root> --backup <dir> --confirm",
    "",
    "Migration writes only .memory-layout.json; memory files and the legacy user scope stay in place.",
  ].join("\n");
  (exitCode === 0 ? process.stdout : process.stderr).write(`${text}\n`);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const args = {
    command: argv[0] ?? null,
    root: null,
    out: null,
    plan: null,
    backup: null,
    confirm: false,
    pretty: false,
  };
  for (let i = 1; i < argv.length; i += 1) {
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
      case "--plan":
        args.plan = next();
        break;
      case "--backup":
        args.backup = next();
        break;
      case "--confirm":
        args.confirm = true;
        break;
      case "--pretty":
        args.pretty = true;
        break;
      case "-h":
      case "--help":
        usage(0);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!["plan", "apply", "verify", "rollback"].includes(args.command)) {
    throw new Error("The first argument must be plan, apply, verify or rollback.");
  }
  if (!args.root) throw new Error("--root is required");
  return args;
}

function sha256Text(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

async function sha256File(file) {
  return createHash("sha256").update(await fs.readFile(file)).digest("hex");
}

async function lstatOrNull(target) {
  try {
    return await fs.lstat(target);
  } catch {
    return null;
  }
}

async function atomicWrite(file, text) {
  const tmp = `${file}.tmp-${process.pid}`;
  await fs.writeFile(tmp, text);
  await fs.rename(tmp, file);
}

async function copyFile(from, to) {
  await fs.mkdir(path.dirname(to), { recursive: true });
  await fs.copyFile(from, to);
}

/**
 * The inventory minus its timestamp. Everything a migration verifies is derived from this
 * digest, so two runs over the same bytes produce the same plan.
 */
function inventoryDigest(report) {
  return sha256Text(
    JSON.stringify({
      projects: report.projects,
      localUsers: report.localUsers,
      missing: report.missing,
      summary: report.summary,
    }),
  );
}

function classify(report) {
  const scopes = [];
  for (const project of report.projects) {
    for (const agent of project.agents) {
      for (const scope of agent.scopes) {
        const legacy = scope.kind === "project_agent" && scope.scopeKey === LEGACY_USER_SCOPE;
        scopes.push({
          projectId: project.projectId,
          agentId: agent.agentId,
          scopeKey: scope.scopeKey,
          kind: scope.kind,
          status: scope.status,
          fileCount: scope.files?.length ?? 0,
          bytes: (scope.files ?? []).reduce((total, file) => total + (file.size ?? 0), 0),
          fileHashes: (scope.files ?? [])
            .filter((file) => file.sha256 !== undefined)
            .map((file) => ({ name: file.name, sha256: file.sha256 })),
          action: legacy
            ? "keep_legacy_user_scope"
            : scope.kind === "project_agent"
              ? "keep_project_agent_scope"
              : scope.kind === "workspace"
                ? "keep_workspace_scope"
                : "keep_scope",
          note: legacy
            ? "Legacy memory/user is project/Agent memory (project_agent); it is NOT merged into local_user_preference."
            : undefined,
        });
      }
    }
  }
  for (const user of report.localUsers.users) {
    scopes.push({
      userKey: user.key,
      ownerUserId: user.ownerUserId,
      kind: "local_user_preference",
      status: user.status,
      fileCount: user.files.length,
      bytes: user.files.reduce((total, file) => total + (file.size ?? 0), 0),
      fileHashes: user.files
        .filter((file) => file.sha256 !== undefined)
        .map((file) => ({ name: file.name, sha256: file.sha256 })),
      action: "keep_local_user_preference_scope",
    });
  }
  return scopes;
}

async function buildPlan(root, report) {
  const digest = inventoryDigest(report);
  const manifestPath = path.join(root, MANIFEST_FILENAME);
  const existing = await lstatOrNull(manifestPath);
  const scopes = classify(report);
  const actions = [
    {
      type: existing === null ? "write_layout_manifest" : "update_layout_manifest",
      path: manifestPath,
      description:
        "Record the classified layout, counts and per-file hashes. No memory file is moved or edited.",
    },
    ...scopes
      .filter((scope) => scope.action === "keep_legacy_user_scope")
      .map((scope) => ({
        type: "keep_legacy_user_scope",
        projectId: scope.projectId,
        agentId: scope.agentId,
        path: scope.scopeKey,
        description:
          "Left in place as project_agent memory. It is not imported into local_user_preference.",
      })),
  ];
  const plan = {
    schemaVersion: SCHEMA_VERSION,
    kind: "penguin-memory-migration-plan",
    createdAt: new Date().toISOString(),
    root,
    inventoryDigest: digest,
    manifest: {
      path: manifestPath,
      present: existing !== null,
      sha256: existing !== null ? await sha256File(manifestPath) : null,
    },
    counts: report.summary,
    missing: report.missing,
    scopes,
    actions,
  };
  plan.fingerprint = planFingerprint(plan);
  return plan;
}

function planFingerprint(plan) {
  // The manifest's own presence and the actions' wording are deliberately excluded: re-running
  // plan after a successful apply must produce the same fingerprint so the migration is
  // idempotent. Only the store's bytes (inventoryDigest and what it covers) define a plan.
  return sha256Text(
    JSON.stringify({
      root: plan.root,
      inventoryDigest: plan.inventoryDigest,
      counts: plan.counts,
      missing: plan.missing,
      scopes: plan.scopes.map((scope) => ({
        projectId: scope.projectId,
        agentId: scope.agentId,
        scopeKey: scope.scopeKey,
        userKey: scope.userKey,
        kind: scope.kind,
        status: scope.status,
        fileCount: scope.fileCount,
        bytes: scope.bytes,
        fileHashes: scope.fileHashes,
      })),
    }),
  );
}

function manifestFromPlan(plan) {
  return {
    schemaVersion: SCHEMA_VERSION,
    kind: "penguin-memory-layout",
    layout: "projects/<project>/agents/<agent>/agent_state/memory/{user,<workspace-key>}",
    createdAt: new Date().toISOString(),
    inventoryDigest: plan.inventoryDigest,
    planFingerprint: plan.fingerprint,
    counts: plan.counts,
    missing: plan.missing,
    scopes: plan.scopes,
    rules: {
      legacyUserScope: "project_agent",
      localUserPreference: "local_user_preference",
      legacyUserScopeMergedIntoPreferences: false,
    },
  };
}

function stableManifestText(manifest) {
  // createdAt is metadata only; normalization keeps rollback/verify messages predictable.
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

async function planCommand(args) {
  const root = path.resolve(args.root);
  const stat = await lstatOrNull(root);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Data root is not a directory: ${root}`);
  }
  const report = await buildMemoryInventory(root);
  const plan = await buildPlan(root, report);
  if (args.out) {
    const out = path.resolve(args.out);
    await fs.writeFile(out, `${JSON.stringify(plan, null, 2)}\n`);
    process.stdout.write(
      `${JSON.stringify({ out, fingerprint: plan.fingerprint, counts: plan.counts, missing: plan.missing.length }, null, 2)}\n`,
    );
  } else {
    process.stdout.write(`${JSON.stringify(plan, null, args.pretty ? 2 : 0)}\n`);
  }
}

async function applyCommand(args) {
  if (!args.confirm) throw new Error("apply needs --confirm after reviewing the plan.");
  if (!args.plan) throw new Error("apply needs --plan <file> produced by `plan`.");
  const root = path.resolve(args.root);
  const stored = JSON.parse(await fs.readFile(path.resolve(args.plan), "utf8"));
  if (stored.kind !== "penguin-memory-migration-plan") {
    throw new Error("The plan file is not a memory migration plan.");
  }
  if (path.resolve(stored.root) !== root) {
    throw new Error(`The plan was made for ${stored.root}, not ${root}.`);
  }
  const report = await buildMemoryInventory(root);
  const fresh = await buildPlan(root, report);
  if (fresh.fingerprint !== stored.fingerprint) {
    throw new Error(
      `The store changed since the plan (${stored.fingerprint} -> ${fresh.fingerprint}); run plan again.`,
    );
  }

  const manifestPath = path.join(root, MANIFEST_FILENAME);
  const existing = await lstatOrNull(manifestPath);
  if (existing !== null) {
    const current = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    if (current?.kind === "penguin-memory-layout" && current.inventoryDigest === fresh.inventoryDigest) {
      process.stdout.write(
        `${JSON.stringify(
          {
            ok: true,
            alreadyCurrent: true,
            root,
            manifest: manifestPath,
            manifestSha256: await sha256File(manifestPath),
            inventoryDigest: fresh.inventoryDigest,
            counts: fresh.counts,
            missing: fresh.missing,
            note: "The manifest already describes this store; nothing was written.",
          },
          null,
          2,
        )}\n`,
      );
      return;
    }
  }
  const backupDir = path.join(
    root,
    BACKUP_DIRNAME,
    `${new Date().toISOString().replace(/[:.]/g, "-")}-${fresh.fingerprint.slice(0, 8)}`,
  );
  await fs.mkdir(backupDir, { recursive: true });
  const backup = {
    schemaVersion: SCHEMA_VERSION,
    kind: "penguin-memory-migration-backup",
    createdAt: new Date().toISOString(),
    planFingerprint: fresh.fingerprint,
    inventoryDigest: fresh.inventoryDigest,
    manifest: {
      path: manifestPath,
      existed: existing !== null,
      sha256: existing !== null ? await sha256File(manifestPath) : null,
      backupFile:
        existing !== null ? path.join(backupDir, MANIFEST_FILENAME) : null,
    },
    note: "Only the layout manifest is backed up; memory files are never edited by this migration.",
  };
  if (existing !== null) {
    await copyFile(manifestPath, path.join(backupDir, MANIFEST_FILENAME));
  }
  await fs.writeFile(path.join(backupDir, "backup.json"), `${JSON.stringify(backup, null, 2)}\n`);

  const manifest = manifestFromPlan(fresh);
  const text = stableManifestText(manifest);
  await atomicWrite(manifestPath, text);

  const writtenHash = await sha256File(manifestPath);
  const verifyReport = await buildMemoryInventory(root);
  const verifyDigest = inventoryDigest(verifyReport);
  if (verifyDigest !== fresh.inventoryDigest) {
    throw new Error(
      `Post-apply verification failed: inventory digest changed (${fresh.inventoryDigest} -> ${verifyDigest}). The backup is at ${backupDir}.`,
    );
  }
  const result = {
    ok: true,
    root,
    manifest: manifestPath,
    manifestSha256: writtenHash,
    backupDir,
    inventoryDigest: verifyDigest,
    counts: fresh.counts,
    missing: fresh.missing,
    actions: fresh.actions,
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

async function verifyCommand(args) {
  const root = path.resolve(args.root);
  const manifestPath = path.join(root, MANIFEST_FILENAME);
  const state = await lstatOrNull(manifestPath);
  if (state === null) {
    process.stdout.write(
      `${JSON.stringify({ ok: false, status: "missing_manifest", manifest: manifestPath, root }, null, 2)}\n`,
    );
    process.exitCode = 1;
    return;
  }
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  const report = await buildMemoryInventory(root);
  const digest = inventoryDigest(report);
  const ok = manifest.inventoryDigest === digest;
  const result = {
    ok,
    status: ok ? "match" : "drift",
    root,
    manifest: manifestPath,
    manifestSha256: await sha256File(manifestPath),
    recordedDigest: manifest.inventoryDigest,
    currentDigest: digest,
    counts: report.summary,
    missing: report.missing,
    note: ok
      ? "The store matches the manifest. Re-running apply is a no-op."
      : "The store changed since apply. Review the new inventory; apply a fresh plan when the change is intended.",
  };
  process.stdout.write(`${JSON.stringify(result, null, args.pretty ? 2 : 0)}\n`);
  if (!ok) process.exitCode = 1;
}

async function rollbackCommand(args) {
  if (!args.confirm) throw new Error("rollback needs --confirm.");
  if (!args.backup) throw new Error("rollback needs --backup <dir> from apply.");
  const root = path.resolve(args.root);
  const backupDir = path.resolve(args.backup);
  const backup = JSON.parse(await fs.readFile(path.join(backupDir, "backup.json"), "utf8"));
  if (backup.kind !== "penguin-memory-migration-backup") {
    throw new Error("The backup directory was not written by this tool.");
  }
  const manifestPath = path.join(root, MANIFEST_FILENAME);
  const current = await lstatOrNull(manifestPath);
  if (current !== null && backup.manifest.existed) {
    const currentHash = await sha256File(manifestPath);
    if (currentHash !== backup.manifest.sha256) {
      throw new Error(
        `The current manifest is not the one this backup replaced (${currentHash} != ${backup.manifest.sha256}). Refusing to overwrite it.`,
      );
    }
    await copyFile(backup.manifest.backupFile, manifestPath);
  } else if (current !== null && !backup.manifest.existed) {
    await fs.rm(manifestPath, { force: true });
  }
  const restored = await lstatOrNull(manifestPath);
  const result = {
    ok: true,
    root,
    manifest: manifestPath,
    restored: backup.manifest.existed,
    present: restored !== null,
    backupDir,
    note: "Only the layout manifest was restored. Memory files were never changed by apply, so nothing else was rolled back.",
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    usage(2);
  }
  if (args.command === "plan") return planCommand(args);
  if (args.command === "apply") return applyCommand(args);
  if (args.command === "verify") return verifyCommand(args);
  return rollbackCommand(args);
}

main().catch((error) => {
  process.stderr.write(`${error?.stack ?? error}\n`);
  process.exit(1);
});
