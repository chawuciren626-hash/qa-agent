import { resolve } from "node:path";

const root = resolve("E:/Codex/测试智能体");
const runId = "run-2026-09-29-test-management";
const runDir = resolve(root, "output/runs", runId, "execution");
console.log("root:", root);
console.log("runId:", runId);
console.log("runDir:", runDir);
