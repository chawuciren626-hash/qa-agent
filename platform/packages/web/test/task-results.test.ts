import { expect, it } from "vitest";
import { executionRows, executionSummary, safeEvidencePath } from "../src/features/qa/task-results";
import { localizeGeneratedMarkdown, localizedReason } from "../src/features/qa/stage-localization";

it("counts designed, executed, supplemental and pending cases from recorded results", () => {
  const view = executionRows([{case_id:"TC-1",title:"登录"},{case_id:"TC-2",title:"退出"},{case_id:"TC-3",title:"注册"}],
    [{case_id:"TC-1",status:"passed"},{case_id:"TC-2",status:"blocked"},{case_id:"EX-1",status:"failed"}]);
  expect(view.metrics).toEqual({total:3,executed:2,passed:1,failed:1,supplemental:1,pending:2});
  expect(view.rows).toHaveLength(4);
  expect(executionRows(null,[{case_id:"TC-1",status:"passed"}]).metrics.total).toBeNull();
});

it("groups assertion records by the referenced designed case without claiming full coverage", () => {
  const view=executionRows([{case_id:"TC-1",title:"登录"},{case_id:"TC-2",title:"退出"}], [
    {case_id:"TC-1-A",case_ref:{source_path:"design/test_cases.json",case_id:"TC-1"},status:"passed"},
    {case_id:"TC-1-B",case_ref:{source_path:"design/test_cases.json",case_id:"TC-1"},status:"failed"},
  ]);
  expect(view.rows).toHaveLength(2);
  expect(view.rows[0]!.results).toHaveLength(2);
  expect(view.metrics).toEqual({total:2,executed:1,passed:0,failed:1,supplemental:0,pending:1});
});

it("shows associated assertion outcomes without claiming that every design step passed", () => {
  const summary=executionSummary([{case_id:"TC-1-A",status:"passed",actual_result:"登录成功"},{case_id:"TC-1-B",status:"failed",actual_result:"未显示提示"}]);
  expect(summary.status).toContain("含失败断言");
  expect(summary.actual).toContain("TC-1-B：未显示提示");
  expect(executionSummary([]).status).toBe("待执行");
});

it("keeps evidence links inside this run", () => {
  expect(safeEvidencePath("execution/screenshot.png","run-a")).toBe("output/runs/run-a/execution/screenshot.png");
  expect(safeEvidencePath("E:\\old\\output\\runs\\run-a\\execution\\screenshot.png","run-a")).toBe("output/runs/run-a/execution/screenshot.png");
  expect(safeEvidencePath("C:\\old\\image.png","run-a")).toBeNull();
  expect(safeEvidencePath("../other/image.png","run-a")).toBeNull();
});

it("localizes controlled reasons and generated document codes", () => {
  expect(localizedReason("User supplied requirement clarification or scope changes; revise before approval")).toContain("需修订后再确认");
  expect(localizeGeneratedMarkdown("- 类型：requirement\n- 范围：in\\_scope\n- 状态：confirmed\n- 声明：requirement")).toBe("- 类型：需求\n- 范围：范围内\n- 状态：已确认\n- 声明：requirement");
});
