import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { resolve, relative, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkSourceRuntime } from "./source-runtime.mjs";

const source = resolve(fileURLToPath(new URL("..", import.meta.url)));
const installed = resolve(process.argv[2] ?? "");
const app = join(installed, "runtime/penguin/resources/app");
const engine = join(installed, "app/engine");
const webSource = join(source, "platform/packages/web/dist");
const serverSource = join(source, "platform/packages/desktop/dist/server.js");
const migrationSource = join(source, "platform/packages/desktop/dist/migrate-db.js");
const mainSource = join(source, "platform/packages/desktop/dist/main.js");
const webTarget = join(app, "web-dist");
const serverTarget = join(app, "dist/server.js");
const migrationTarget = join(app, "dist/migrate-db.js");
const mainTarget = join(app, "dist/main.js");
const manifestPath = join(app, "aitest-source-runtime.json");
const backup = join(resolve(installed, "../backups"), `project-management-${new Date().toISOString().replace(/[:.]/g, "-")}`);
const hash = path => createHash("sha256").update(readFileSync(path)).digest("hex");

function files(root) {
  const result = [];
  function visit(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) result.push(path);
      else throw Error(`Unsupported file: ${path}`);
    }
  }
  visit(root);
  return result;
}

if (!process.argv[2] || !existsSync(join(installed, ".local-service-paused.json"))) throw Error("Local service must be safely paused first");
if (!existsSync(serverSource) || !existsSync(migrationSource) || !existsSync(mainSource) || !existsSync(join(webSource, "index.html")) || !existsSync(serverTarget) || !existsSync(mainTarget) || !existsSync(webTarget)) throw Error("Build or installation missing");
checkSourceRuntime(app, engine);
if (existsSync(backup)) throw Error("Backup already exists");
mkdirSync(backup, { recursive: true });
cpSync(serverTarget, join(backup, "server.js"));
if (existsSync(migrationTarget)) cpSync(migrationTarget, join(backup, "migrate-db.js"));
cpSync(mainTarget, join(backup, "main.js"));
cpSync(manifestPath, join(backup, "aitest-source-runtime.json"));
cpSync(webTarget, join(backup, "web-dist"), { recursive: true });
try {
  cpSync(serverSource, serverTarget);
  cpSync(migrationSource, migrationTarget);
  cpSync(mainSource, mainTarget);
  rmSync(webTarget, { recursive: true });
  cpSync(webSource, webTarget, { recursive: true });
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.files["dist/server.js"] = hash(serverTarget);
  manifest.files["dist/migrate-db.js"] = hash(migrationTarget);
  manifest.files["dist/main.js"] = hash(mainTarget);
  for (const key of Object.keys(manifest.files)) if (key.startsWith("web-dist/")) delete manifest.files[key];
  for (const path of files(webTarget)) manifest.files[`web-dist/${relative(webTarget, path).replaceAll("\\", "/")}`] = hash(path);
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  if (hash(serverSource) !== hash(serverTarget)) throw Error("Server copy mismatch");
  if (hash(migrationSource) !== hash(migrationTarget)) throw Error("Migration copy mismatch");
  if (hash(mainSource) !== hash(mainTarget)) throw Error("Desktop shell copy mismatch");
  for (const path of files(webSource)) {
    const target = join(webTarget, relative(webSource, path));
    if (hash(path) !== hash(target)) throw Error(`Web copy mismatch: ${path}`);
  }
  const verified = checkSourceRuntime(app, engine);
  console.log(JSON.stringify({ status: "deployed", backup, verified, serverSha256: hash(serverTarget), webFiles: files(webTarget).length }));
} catch (error) {
  cpSync(join(backup, "server.js"), serverTarget);
  if (existsSync(join(backup, "migrate-db.js"))) cpSync(join(backup, "migrate-db.js"), migrationTarget);
  else if (existsSync(migrationTarget)) rmSync(migrationTarget);
  cpSync(join(backup, "main.js"), mainTarget);
  cpSync(join(backup, "aitest-source-runtime.json"), manifestPath);
  if (existsSync(webTarget)) rmSync(webTarget, { recursive: true });
  renameSync(join(backup, "web-dist"), webTarget);
  throw error;
}
