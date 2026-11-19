/**
 * 发布链收敛（P0 / 文档 §6.4）。
 *
 * 为什么需要这个脚本：2026-11-19 一天内踩了两个坑——
 *   ① web-dist 与 server.js 不是同一次构建 → 派发探索 404（前端调了后端没有的路由）；
 *   ② 直接 robocopy 覆盖 web-dist → `Source runtime checksum mismatch` → 安装版拒绝启动。
 * 两个坑的共同根因不是代码，是**发布动作没有唯一入口**，谁都能用任意方式改安装目录。
 * 所以这里把「构建号一致 → 暂停服务 → 官方部署（备份/换件/重签清单/自校验）→ 恢复服务」
 * 收敛成一条命令，并在每一步做前置断言。
 *
 * 用法：
 *   node scripts/release.mjs --stamp                       # 构建后打戳（记录本次构建号）
 *   node scripts/release.mjs --check                       # CI：构建产物与戳是否一致
 *   node scripts/release.mjs <installedDir> [--skip-check] # 发布到安装目录（pause→deploy→resume）
 *
 * 设计约束（踩坑得来，不要改）：
 *   · 校验清单 `aitest-source-runtime.json` 覆盖 app 下**所有**文件，因此发布过程禁止向 app 写
 *     任何清单外的文件——构建号戳必须留在仓库侧（output/release/），不能落进安装目录；
 *   · pause 必须在 deploy 之前、resume 必须在 finally 里（失败也要恢复，否则服务一直停着）；
 *   · deploy 脚本自己会做「备份 → 换件 → 重签 → 自校验 → 失败回滚」，本脚本不重复实现，
 *     只负责编排与前置断言——两份实现必然漂移，这是 2026-11-19 的教训。
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const webDist = join(root, "platform/packages/web/dist");
const serverDist = join(root, "platform/packages/desktop/dist/server.js");
const stampPath = join(root, "output/release/release-stamp.json");
const deployScript = join(root, "scripts/deploy-project-management-local.mjs");
const serviceScript = join(root, "scripts/local-service.mjs");

const sha = file => createHash("sha256").update(readFileSync(file)).digest("hex");
const die = message => { console.error(`release: ${message}`); process.exit(1); };
const node = (args, options) => {
  const result = spawnSync(process.execPath, args, { stdio: "inherit", ...options });
  if (result.status !== 0) throw new Error(`命令失败（退出码 ${result.status}）：node ${args.join(" ")}`);
};

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(path));
    else out.push(path);
  }
  return out.sort();
}

/** 构建号 = server.js 哈希 + web 产物树哈希。两者任一变化都必须换号——这正是 404 那个坑的防线。 */
function buildStamp() {
  if (!existsSync(serverDist)) die(`缺少服务端构建产物：${relative(root, serverDist)}（先构建 desktop 包）`);
  if (!existsSync(join(webDist, "index.html"))) die(`缺少前端构建产物：${relative(root, webDist)}（先构建 web 包）`);
  const files = walk(webDist);
  const treeHash = createHash("sha256")
    .update(files.map(file => `${relative(webDist, file).replaceAll("\\", "/")}:${sha(file)}`).join("\n"))
    .digest("hex");
  const serverSha256 = sha(serverDist);
  return {
    buildId: createHash("sha256").update(`${serverSha256}\n${treeHash}`).digest("hex").slice(0, 16),
    serverSha256,
    webTreeHash: treeHash,
    webFileCount: files.length,
    newestArtifactAt: files.map(file => statSync(file).mtimeMs).concat([statSync(serverDist).mtimeMs])
      .reduce((a, b) => Math.max(a, b), 0),
  };
}

function readStamp() {
  if (!existsSync(stampPath)) return null;
  try { return JSON.parse(readFileSync(stampPath, "utf8")); } catch { return null; }
}

function assertConsistent(current, saved) {
  const problems = [];
  if (current.buildId !== saved.buildId) problems.push(`构建号不一致：产物 ${current.buildId} ≠ 戳 ${saved.buildId}`);
  if (current.serverSha256 !== saved.serverSha256) problems.push("server.js 在打戳后被改动");
  if (current.webTreeHash !== saved.webTreeHash) problems.push("web 产物在打戳后被改动");
  if (problems.length) die(`${problems.join("；")}\n  说明：构建产物与发布戳不同源，先重新构建再 --stamp，不要带着不一致的产物发布。`);
}

function stamp() {
  const current = buildStamp();
  mkdirSync(dirname(stampPath), { recursive: true });
  const payload = { ...current, stampedAt: new Date().toISOString(), gitHead: headCommit() };
  writeFileSync(stampPath, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(JSON.stringify({ status: "stamped", buildId: current.buildId, serverSha256: current.serverSha256.slice(0, 12), webFiles: current.webFileCount, stamp: relative(root, stampPath) }));
}

function check() {
  const current = buildStamp();
  const saved = readStamp();
  if (!saved) die("缺少发布戳：先运行 node scripts/release.mjs --stamp");
  assertConsistent(current, saved);
  console.log(JSON.stringify({ status: "consistent", buildId: current.buildId, webFiles: current.webFileCount }));
}

function headCommit() {
  const result = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}

function verifyInstalled(installed) {
  const app = join(installed, "runtime/penguin/resources/app");
  const engine = join(installed, "app/engine");
  const current = buildStamp();
  const deployedServer = join(app, "dist/server.js");
  if (!existsSync(deployedServer)) die("安装目录缺少 dist/server.js，安装不完整");
  if (sha(deployedServer) !== current.serverSha256) die("安装目录的 server.js 与当前构建不一致（部署未生效或被手动改动）");
  const deployedWeb = join(app, "web-dist");
  const files = walk(deployedWeb);
  if (files.length !== current.webFileCount) die(`安装目录 web-dist 文件数 ${files.length} ≠ 构建 ${current.webFileCount}`);
  return { app, engine, webFiles: files.length };
}

function release(installedArg, skipCheck) {
  const installed = resolve(installedArg);
  if (!existsSync(join(installed, "installation.json"))) die(`不是有效的安装目录（缺 installation.json）：${installed}`);
  if (!skipCheck) check();
  const installation = join(installed, "installation.json");

  let paused = false;
  try {
    console.log("[1/3] 暂停本机服务（避免运行中进程持有旧文件句柄）");
    node([serviceScript, "pause", installation], { cwd: installed });
    paused = true;

    console.log("[2/3] 官方部署（备份 → 换件 → 重签清单 → 自校验，失败自动回滚）");
    node([deployScript, installed], { cwd: root });

    console.log("[3/3] 恢复本机服务");
    node([serviceScript, "resume", installation], { cwd: installed });
    paused = false;

    const verified = verifyInstalled(installed);
    console.log(JSON.stringify({ status: "released", buildId: buildStamp().buildId, webFiles: verified.webFiles }));
  } catch (error) {
    if (paused) {
      // 部署失败也必须把服务恢复回来：停着的服务比旧版本更难排查。
      try { node([serviceScript, "resume", installation], { cwd: installed }); }
      catch { console.error("release: 服务恢复失败，请手动执行 local-service.mjs resume"); }
    }
    throw error;
  }
}

const argv = process.argv.slice(2);
const skipCheck = argv.includes("--skip-check");
const target = argv.find(item => !item.startsWith("--"));
if (argv.includes("--stamp")) stamp();
else if (argv.includes("--check")) check();
else if (target) release(target, skipCheck);
else die("用法：--stamp | --check | <installedDir> [--skip-check]");
