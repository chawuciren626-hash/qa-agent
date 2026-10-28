import { afterEach, beforeEach, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readTaskRuns } from "../src/services/qa-project-overview.js";
let root: string;
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), "qa-overview-")); });
afterEach(async () => { await fs.rm(root, {recursive: true, force: true}); });
it("projects recorded stages and existing artifacts without mixing tasks sharing a workspace", async () => {
  const dir = path.join(root, "output/runs/run-test");
  await fs.mkdir(path.join(dir, "report"), {recursive: true});
  await fs.writeFile(path.join(dir,"report/test.html"), "report");
  await fs.writeFile(path.join(dir,"manifest.json"), JSON.stringify({
    directory_context: {session_id:"session-a"}, status:"blocked",
    stages:{analysis:{status:"confirmed"},execution:{status:"blocked"}},
    artifacts:["report/test.html","report/missing.html","report/../../../outside.html"],
  }));
  const result = await readTaskRuns(root,"session-a");
  expect(result.runs[0]?.status).toBe("blocked");
  expect(result.runs[0]?.stages).toContainEqual({id:"execution",status:"blocked"});
  expect(result.runs[0]?.artifacts).toEqual([{path:"output/runs/run-test/report/test.html",category:"reports"}]);
  expect(result.unavailable).toBe(2);
  expect((await readTaskRuns(root,"session-b")).runs).toEqual([]);
});
it("does not attribute legacy unowned runs or infer success from empty data", async () => {
  expect((await readTaskRuns(root,"session-a")).runs).toEqual([]);
  const dir=path.join(root,"output/runs/run-legacy");
  await fs.mkdir(dir,{recursive:true});
  await fs.writeFile(path.join(dir,"manifest.json"),JSON.stringify({status:"completed",stages:{}}));
  expect((await readTaskRuns(root,"session-a")).runs).toEqual([]);
  await fs.writeFile(path.join(dir,"manifest.json"),"broken");
  expect((await readTaskRuns(root,"session-a")).unavailable).toBe(1);
});
