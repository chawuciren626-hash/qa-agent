import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const args = Object.fromEntries(process.argv.slice(2).filter((arg) => arg.startsWith("--") && arg.includes("=")).map((arg) => {
  const [key, value] = arg.slice(2).split(/=(.*)/s);
  return [key, value];
}));
const apply = process.argv.includes("--apply");
const targetRoot = resolve(args["target-root"] ?? process.env.PENGUIN_AGENT_ROOT ?? resolve(homedir(), ".penguin/data/default_project/agents"));
const manifest = JSON.parse(readFileSync(resolve(root, "penguin/agents.json"), "utf8"));
const normalize = (value) => value.replace(/\r\n/g, "\n");
const sameFile = (source, target) => existsSync(target) && normalize(readFileSync(source, "utf8")) === normalize(readFileSync(target, "utf8"));
const changes = [];

for (const agent of manifest.agents ?? []) {
  const stateDir = resolve(targetRoot, agent.id, "agent_state");
  if (!existsSync(stateDir)) {
    throw new Error(`目标 Agent 不存在: ${stateDir}。请先在 PenguinHarness 创建 ${agent.id}。`);
  }
  const sources = [
    { source: resolve(root, agent.prompt), target: resolve(stateDir, "AGENTS.md") },
    ...(agent.skills ?? []).map((skill) => ({
      source: resolve(root, "skills", skill, "SKILL.md"),
      target: resolve(stateDir, "skills", skill, "SKILL.md")
    }))
  ];
  for (const item of sources) {
    if (!existsSync(item.source)) throw new Error(`缺少仓库源文件: ${item.source}`);
    if (sameFile(item.source, item.target)) continue;
    changes.push({ agent: agent.id, source: item.source, target: item.target });
    if (apply) {
      mkdirSync(resolve(item.target, ".."), { recursive: true });
      copyFileSync(item.source, item.target);
    }
  }
}

if (!apply && changes.length) {
  console.error(JSON.stringify({ status: "drift_detected", target_root: targetRoot, changes }, null, 2));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({ status: apply ? "synchronized" : "in_sync", target_root: targetRoot, changes: changes.length }, null, 2));
}
