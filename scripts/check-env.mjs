import { spawnSync } from "node:child_process";

const result = spawnSync("node", ["-e", "console.log('QA_RUN_DIR=' + process.env.QA_RUN_DIR)"], {
  env: { ...process.env, QA_RUN_DIR: "/test/path" },
  stdio: "pipe",
});

console.log(result.stdout.toString());
console.log(result.stderr.toString());
