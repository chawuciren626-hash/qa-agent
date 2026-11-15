import { afterEach, beforeEach, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { readTaskRuns, readTaskRunDetail } from "../src/services/qa-project-overview.js";
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
  expect(result.runs[0]?.executionPlatform).toBe("web");
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
it("summarizes only owned, sealed case and defect rows", async () => {
  const dir = path.join(root, "output/runs/run-counts");
  await fs.mkdir(path.join(dir, "design"), {recursive: true});
  await fs.mkdir(path.join(dir, "defects"), {recursive: true});
  await fs.mkdir(path.join(dir, "execution"), {recursive: true});
  const cases = JSON.stringify({cases:[{case_id:"C-1",title:"登录",type:"Web"},{case_id:"C-2",title:"退出",type:"Web"}]});
  const defects = JSON.stringify({records:[{defect_id:"D-1",title:"无法登录",severity:"严重",source_stage:"execution"}]});
  const results = JSON.stringify({cases:[{case_id:"C-1-assertion",case_ref:{source_path:"design/test_cases.json",case_id:"C-1"},status:"failed",actual_result:"登录失败",evidence_paths:["execution/evidence.png"]}]});
  await fs.writeFile(path.join(dir,"design/test_cases.json"),cases);
  await fs.writeFile(path.join(dir,"defects/defect-records.json"),defects);
  await fs.writeFile(path.join(dir,"execution/test_results.json"),results);
  const seal = (file: string, bytes: string) => ({path:file,sha256:createHash("sha256").update(bytes).digest("hex")});
  await fs.writeFile(path.join(dir,"manifest.json"),JSON.stringify({directory_context:{session_id:"session-a"},stages:{test_cases:{status:"completed"},execution:{status:"completed"},defects:{status:"completed"}},artifacts:["design/test_cases.json","execution/test_results.json","defects/defect-records.json"],orchestration:{events:[{type:"completed",stage:"test_cases",evidence:{artifact_contract:{status:"passed",files:[seal("design/test_cases.json",cases)]}}},{type:"completed",stage:"execution",evidence:{artifact_contract:{status:"passed",files:[seal("execution/test_results.json",results)]}}},{type:"completed",stage:"defects",evidence:{artifact_contract:{status:"passed",files:[seal("defects/defect-records.json",defects)]}}}]}}));
  const run = (await readTaskRuns(root,"session-a")).runs[0]!;
  expect(run.caseCount).toBe(2);
  expect(run.cases.map(row => row.id)).toEqual(["C-1","C-2"]);
  expect(run.cases.map(row => row.status)).toEqual(["不通过","未执行"]);
  expect(run.cases[0]?.results[0]?.case_id).toBe("C-1-assertion");
  expect(run.defectCount).toBe(1);
  expect(run.defects[0]?.id).toBe("D-1");
  await fs.writeFile(path.join(dir,"defects/defect-records.json"),"{\"records\":[]}");
  expect((await readTaskRuns(root,"session-a")).runs[0]?.defectCount).toBe(0);
  expect((await readTaskRuns(root,"session-b")).runs).toEqual([]);
});
it("shows only selected stages and registered files, and trusts a summary only with matching delivery hash", async () => {
  const dir = path.join(root, "output/runs/run-detail");
  await fs.mkdir(path.join(dir, "analysis"), { recursive: true });
  await fs.mkdir(path.join(dir, "report"), { recursive: true });
  const task = JSON.stringify({ run_id: "run-detail", stage: "analysis", summary: "已分析当前资料", questions: ["规则是否适用？"], limitations: [] });
  const hash = createHash("sha256").update(task).digest("hex");
  await fs.writeFile(path.join(dir, "analysis/analysis-task.json"), task);
  await fs.writeFile(path.join(dir, "report/test_report.html"), "old report");
  await fs.writeFile(path.join(dir, "manifest.json"), JSON.stringify({
    run_id: "run-detail", directory_context: { session_id: "session-a" }, status: "awaiting_confirmation",
    orchestration: { plan: { workflow_mode: "lifecycle", review_mode: "staged", stages: [
      { id: "analysis", selected: true, confirmation: "after", agent: "requirement_analysis_agent" },
      { id: "report", selected: false, agent: "test_report_agent" },
    ] }, events: [{ type: "completed", stage: "analysis", evidence: { artifact_contract: { status: "passed", files: [{ path: "analysis/analysis-task.json", sha256: hash }] } } }] },
    stages: { analysis: { status: "awaiting_confirmation" }, report: { status: "skipped" } },
    confirmations: [{ id: "confirm-analysis-1", stage: "analysis", status: "pending", requested_at: "2026-11-02T00:00:00Z" }],
    artifacts: ["analysis/analysis-task.json", "report/test_report.html", "analysis/missing.md"],
  }));
  const detail = await readTaskRunDetail(root, "session-a", "run-detail");
  expect(detail?.stages.map(stage => stage.id)).toEqual(["analysis"]);
  expect(detail?.stages[0]?.summary).toBe("已分析当前资料");
  expect(detail?.stages[0]?.questions).toEqual(["规则是否适用？"]);
  expect(detail?.stages[0]?.history[0]?.status).toBe("pending");
  expect(detail?.stages[0]?.pendingConfirmationId).toBe("confirm-analysis-1");
  expect(detail?.artifacts.map(item => [item.name, item.available])).toEqual([["analysis-task.json", true], ["missing.md", false]]);
  await fs.writeFile(path.join(dir, "analysis/analysis-task.json"), "changed");
  const changed = await readTaskRunDetail(root, "session-a", "run-detail");
  expect(changed?.stages[0]?.summary).toBe("");
  expect(changed?.artifacts[0]?.verified).toBe(false);
  expect(await readTaskRunDetail(root, "session-b", "run-detail")).toBeNull();
});
it.skipIf(!process.env.AITEST_ENGINE_ROOT)("renders legacy test-point JSON for review without mutating the delivery or trusting changed bytes",async()=>{
  const dir=path.join(root,"output/runs/run-legacy-review");await fs.mkdir(path.join(dir,"design"),{recursive:true});
  const bytes=JSON.stringify([{id:"TP-1",module:"登录",feature:"必填",description:"空值提示"}]);
  const manifest={run_id:"run-legacy-review",directory_context:{session_id:"session-a"},artifacts:["design/test_points.json"],stages:{test_points:{status:"awaiting_confirmation"}},confirmations:[{id:"confirm-test_points-123",stage:"test_points",status:"pending",kind:"result"}],orchestration:{plan:{workflow_mode:"lifecycle",review_mode:"staged",stages:[{id:"test_points",selected:true,confirmation:"after"}]},events:[{type:"completed",stage:"test_points",evidence:{artifact_contract:{status:"passed",files:[{path:"design/test_points.json",sha256:createHash("sha256").update(bytes).digest("hex")}]}}}]}};
  await fs.writeFile(path.join(dir,"design/test_points.json"),bytes);await fs.writeFile(path.join(dir,"manifest.json"),JSON.stringify(manifest));
  const result=await readTaskRunDetail(root,"session-a","run-legacy-review");
  expect(result?.stages[0]?.reviewMarkdown).toContain("空值提示");
  expect(result?.stages[0]?.pendingConfirmationId).toBe("confirm-test_points-123");
  expect(await fs.readFile(path.join(dir,"manifest.json"),"utf8")).toBe(JSON.stringify(manifest));
  await expect(fs.access(path.join(dir,"design/test_points.md"))).rejects.toThrow();
  await fs.writeFile(path.join(dir,"design/test_points.json"),'[]');
  expect((await readTaskRunDetail(root,"session-a","run-legacy-review"))?.stages[0]?.reviewMarkdown).toBe("");
});
