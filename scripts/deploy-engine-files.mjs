/**
 * 引擎文件同步（红线同款纪律，策略感知）：让安装副本的引擎文件与源码发布策略对齐。
 *
 * 为什么需要这个脚本：deploy-project-management-local.mjs 只管 web-dist / server.js /
 * migrate-db / main.js（构建产物），而探索/编排引擎文件在清单的 engine_files 段——直拷
 * 会触发 `Source runtime checksum mismatch` 拒启，绕过清单又会留下两套真源。
 *
 * v2（策略感知）：期望状态不再来自旧清单本身，而来自源码的发布策略
 * `config/release-resources.json`（与 stageSourceRuntime 的 engine_files 公式同一真源：
 * policy.files + 暂存期三个引导脚本 + 策略文件自身）。由此：
 *   - 清单里已有但内容变化 → 换件重签；
 *   - 策略里有、清单里没有（新增运行时文件，如 central-mcp.mjs、desktop 引擎）→ 自动入清单并同步；
 *   - 清单里有、策略里没有 → 保留不动并在结果里报告（下次整装 staging 才裁剪，运行中不删文件）。
 *
 * 纪律不变：前置断言（服务已暂停 + 现状清单自洽） → 备份 → 换件 → 重签 → 自校验 → 失败回滚。
 *
 * 用法：node scripts/deploy-engine-files.mjs <installedDir>
 * 前置：local-service 已暂停（与 deploy-project-management-local.mjs 同一前置）。
 */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { releaseResources, assertReleaseImportClosure } from "./check-release-resources.mjs";
import { assertPlainPath } from "./application-data.mjs";
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

// 期望状态：发布策略 + 暂存期引导脚本（与 stageSourceRuntime 的 engine_files 公式同源）。
// 这样新增的运行时文件（如 central-mcp.mjs、desktop 引擎）随策略自动进部署，不再依赖
// 手工补拷——手工补拷的文件不受清单完整性校验，是漂移的来源。
const policyPath = resolve(source, "config/release-resources.json");
if (!existsSync(policyPath)) die("源码缺少 config/release-resources.json");
const policy = JSON.parse(readFileSync(policyPath, "utf8"));
releaseResources(source, policy);
const desired = new Set([
  ...policy.files,
  "scripts/qa-project-bootstrap.mjs",
  "scripts/trace-outcome.mjs",
  "scripts/source-runtime.mjs",
  "config/release-resources.json",
]);

assertReleaseImportClosure(source, [...desired]);

// 变更/新增探测：
//   - 期望集合内：源码哈希 ≠ 清单哈希 → 换件（含清单里没有的新文件）；
//   - 源码缺失或依赖不完整：部署前拒绝，不修改安装副本。
const changed = [];
const knownBefore = new Set(Object.keys(engineFiles));
for (const key of desired) {
  const sourceFile = resolve(source, key);
  assertPlainPath(resolve(engine, key));
  if (!existsSync(sourceFile)) die(`Missing release source: ${key}`);
  const actual = sha(sourceFile);
  if (actual !== engineFiles[key]) changed.push({ key, sha256: actual });
}
const legacyOnly = Object.keys(engineFiles).filter(key => !desired.has(key));
if (!changed.length) {
  console.log(JSON.stringify({
    status: "in-sync",
    managed: Object.keys(engineFiles).length,
    desired: desired.size,
    legacyUnmanaged: legacyOnly.length,
  }));
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
    mkdirSync(dirname(engineFile), { recursive: true });
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
      else if (existsSync(item.engineFile)) unlinkSync(item.engineFile);
    } catch { /* 回滚失败时保留现场供人工排查，不掩盖原始错误 */ }
  }
  try { checkSourceRuntime(app, engine); } catch { /* 已尽力恢复 */ }
  die(`同步失败，已回滚：${error.message}`);
}
console.log(JSON.stringify({
  status: "deployed",
  changed: changed.length,
  added: changed.filter(item => !knownBefore.has(item.key)).length,
  files: changed.map(item => item.key),
  legacyUnmanaged: legacyOnly.length,
  backup: relative(installed, backup),
}, null, 2));
