/**
 * 引擎文件同步（红线同款纪律）：把源码树里与清单不一致的 engine_files 换进安装目录。
 *
 * 为什么需要这个脚本：deploy-project-management-local.mjs 只管 web-dist / server.js /
 * migrate-db（构建产物），而探索/编排引擎文件（scripts/、aitestharness-tools/ 等）在
 * 清单的 engine_files 段——直拷会触发 `Source runtime checksum mismatch` 拒启，绕过
 * 清单又会留下两套真源。本脚本复用同一条纪律：
 *
 *   前置断言（服务已暂停 + 现状清单自洽） → 备份 → 换件 → 重签 → 自校验 → 失败回滚
 *
 * 变更文件自动探测：逐条比对 engine_files 哈希与源码树实际哈希，不一致才换件——
 * 脚本不硬编码文件名，改了什么就同步什么，没改就不动。
 *
 * 用法：node scripts/deploy-engine-files.mjs <installedDir>
 * 前置：local-service 已暂停（与 deploy-project-management-local.mjs 同一前置）。
 */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkSourceRuntime } from "./source-runtime.mjs";

const source = resolve(fileURLToPath(new URL("..", import.meta.url)));
const installed = resolve(process.argv[2] ?? "");
if (!process.argv[2] || !existsSync(installed)) {
  console.error("Usage: node scripts/deploy-engine-files.mjs <installedDir>");
  process.exit(1);
}
const app = join(installed, "runtime/penguin/resources/app");
const engine = join(installed, "app/engine");
const manifestPath = join(app, "aitest-source-runtime.json");
const backup = join(resolve(installed, "../backups"), `engine-files-${new Date().toISOString().replace(/[:.]/g, "-")}`);
const sha = file => createHash("sha256").update(readFileSync(file)).digest("hex");
const die = message => { console.error(`deploy-engine-files: ${message}`); process.exit(1); };

if (!existsSync(join(installed, ".local-service-paused.json"))) {
  die("Local service must be safely paused first（先 pause，再同步）");
}
if (!existsSync(manifestPath)) die(`安装目录缺少清单：${relative(installed, manifestPath)}`);
checkSourceRuntime(app, engine);          // 现状必须自洽：在脏基线上同步会把脏当新真源

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const engineFiles = manifest.engine_files ?? {};
if (!Object.keys(engineFiles).length) die("清单没有 engine_files 段（安装不完整或版本过旧）");

// 变更探测：清单哈希 ≠ 源码树哈希 → 需要换件。源里缺失的键不动（那是删除流程的事，
// 不能被一次同步悄悄扩大成"顺手删文件"）。
const changed = [];
for (const [key, expected] of Object.entries(engineFiles)) {
  const sourceFile = resolve(source, key);
  if (!existsSync(sourceFile)) continue;
  const actual = sha(sourceFile);
  if (actual !== expected) changed.push({ key, sha256: actual });
}
if (!changed.length) {
  console.log(JSON.stringify({ status: "in-sync", engineFiles: Object.keys(engineFiles).length }));
  process.exit(0);
}

mkdirSync(backup, { recursive: true });
const rollback = [];
try {
  for (const { key } of changed) {
    const engineFile = join(engine, key);
    if (existsSync(engineFile)) {
      mkdirSync(join(backup, relative(engine, resolve(engineFile, "..")), ), { recursive: true });
      copyFileSync(engineFile, join(backup, relative(engine, engineFile)));
      rollback.push({ engineFile, backupFile: join(backup, relative(engine, engineFile)) });
    } else {
      rollback.push({ engineFile, backupFile: null });
    }
    copyFileSync(resolve(source, key), engineFile);
    engineFiles[key] = sha(engineFile);
  }
  copyFileSync(manifestPath, join(backup, "aitest-source-runtime.json"));
  rollback.push({ engineFile: manifestPath, backupFile: join(backup, "aitest-source-runtime.json") });
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  checkSourceRuntime(app, engine);        // 换件后必须自洽：不过校验就不算部署成功
} catch (error) {
  for (const item of rollback.reverse()) {
    try {
      if (item.backupFile) copyFileSync(item.backupFile, item.engineFile);
    } catch { /* 回滚失败时保留现场供人工排查，不掩盖原始错误 */ }
  }
  try { checkSourceRuntime(app, engine); } catch { /* 已尽力恢复 */ }
  die(`同步失败，已回滚：${error.message}`);
}
console.log(JSON.stringify({
  status: "deployed",
  changed: changed.length,
  files: changed.map(item => item.key),
  backup: relative(installed, backup),
}, null, 2));
