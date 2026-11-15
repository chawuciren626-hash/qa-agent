// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { createElement as h } from "react";
import { mount, unmountAll, click, run } from "./helpers/dom";
import { ExecutionResults } from "../src/features/qa/execution-results";
import { DefectResults } from "../src/features/qa/defect-results";
import { localizeActualResult } from "../src/features/qa/task-results";
import { splitResultEvidence } from "../src/features/qa/result-evidence";

afterEach(async () => { await unmountAll(); vi.unstubAllGlobals(); });

it("localizes structured actual result codes and separates screenshots from evidence", () => {
  expect(localizeActualResult("text: unavailable; condition_not_met")).toBe("文本：无法获取；条件未满足");
  expect(localizeActualResult("visible: true; condition_matched")).toBe("可见：是；条件已满足");
  expect(localizeActualResult("HTTP matched=true; business value matched=not_checked")).toBe("HTTP 状态符合预期：是；业务值符合预期：未检查");
  expect(localizeActualResult("登录成功")).toBe("登录成功");
  expect(splitResultEvidence(["execution/submit.json", "execution/submit.png", "execution/submit.observation.json"]))
    .toEqual({screenshots:["execution/submit.png"],evidence:["execution/submit.json", "execution/submit.observation.json"]});
});

it("previews JSON evidence in the result dialog", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(url.includes("submit.json") ? '{"condition":"not_met"}' : JSON.stringify({cases:[{case_id:"TC-1",title:"登录",status:"failed",actual_result:"text: unavailable; condition_not_met",evidence_paths:["execution/submit.json","execution/submit.png"]}]}), {status:200})));
  await mount(h(ExecutionResults,{projectId:"test",sessionId:"session-a",runId:"run-one",stageId:"execution",artifacts:[{path:"output/runs/run-one/execution/test_results.json",name:"test_results.json",stage:"execution",size:200,available:true,verified:true}],refresh:0}));
  await run(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  await click(document.querySelector(".qtd-table-wrap button") as HTMLButtonElement);
  const dialog = document.querySelector('[aria-label="用例执行详情"]')!;
  expect(dialog.textContent).toContain("文本：无法获取；条件未满足");
  expect(dialog.textContent).toContain("结果截图");
  expect(dialog.textContent).toContain("结果取证");
  await click([...dialog.querySelectorAll("button")].find(button => button.textContent === "submit.json") as HTMLButtonElement);
  await run(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  expect(document.querySelector('[aria-label="预览 submit.json"]')?.textContent).toContain('"condition": "not_met"');
  expect(document.querySelector('[aria-label="预览 submit.json"] .qtd-json-formatted')).not.toBeNull();
});

it("shows execution metrics, all cases and the selected result", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(JSON.stringify(url.includes("test_cases.json") ? {cases:[{case_id:"TC-1",title:"登录"},{case_id:"TC-2",title:"退出"}]} : {cases:[{case_id:"TC-1",title:"登录",status:"passed",actual_result:"登录成功"},{case_id:"EX-1",title:"补充",status:"failed",actual_result:"页面报错"}]}), { status: 200 })));
  const artifacts = [{path:"output/runs/run-one/execution/test_results.json",name:"test_results.json",stage:"execution",size:200,available:true,verified:true},{path:"output/runs/run-one/design/test_cases.json",name:"test_cases.json",stage:"test_cases",size:200,available:true,verified:true}];
  await mount(h(ExecutionResults,{projectId:"test",sessionId:"session-a",runId:"run-one",stageId:"execution",artifacts,refresh:0}));
  await run(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  expect(document.querySelector(".qtd-metrics")?.textContent).toContain("待执行用例数量1");
  expect(document.querySelector(".qtd-metrics")?.textContent).toContain("补充用例数量1");
  expect(document.querySelectorAll(".qtd-table-wrap tbody tr")).toHaveLength(3);
  await click([...document.querySelectorAll(".qtd-table-wrap button")].find(button => button.closest("tr")?.textContent?.includes("EX-1")) as HTMLButtonElement);
  expect(document.querySelector('[aria-label="用例执行详情"]')?.textContent).toContain("页面报错");
});

it("shows defect details with reproduction steps and a screenshot reference", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({records:[{defect_id:"BUG-1",title:"登录失败",category:"product",actual_result:"提示错误",steps_to_reproduce:["输入账号","点击登录"],related_cases:["TC-1"],evidence_refs:["execution/login.png"]}]}), {status:200})));
  await mount(h(DefectResults,{projectId:"test",sessionId:"session-a",runId:"run-one",artifacts:[{path:"output/runs/run-one/defects/defect-records.json",name:"defect-records.json",stage:"defects",size:200,available:true,verified:true}],refresh:0}));
  await run(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  expect(document.querySelector(".qtd-table-wrap")?.textContent).toContain("产品问题");
  await click(document.querySelector(".qtd-table-wrap button") as HTMLButtonElement);
  expect(document.querySelector('[aria-label="缺陷详情"]')?.textContent).toContain("输入账号");
  expect(document.querySelector('[aria-label="缺陷详情"] img')?.getAttribute("src")).toContain("execution%2Flogin.png");
});

it("keeps execution and defect table columns visible without results", async () => {
  await mount(h(ExecutionResults,{projectId:"test",sessionId:"session-a",runId:"run-one",stageId:"execution",artifacts:[],refresh:0}));
  await mount(h(DefectResults,{projectId:"test",sessionId:"session-a",runId:"run-one",artifacts:[],refresh:0}));
  await run(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  const tables = [...document.querySelectorAll(".qtd-structured-results table")];
  expect(tables).toHaveLength(2);
  expect(tables[0]?.querySelector("thead")?.textContent).toContain("用例编号");
  expect(tables[1]?.querySelector("thead")?.textContent).toContain("缺陷编号");
  expect(tables[0]?.querySelector("tbody")?.textContent).toBe("暂无数据");
  expect(tables[1]?.querySelector("tbody")?.textContent).toBe("暂无数据");
});

it("separates unknown and unrecorded severity from low-risk defects and filters the table", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({records:[
    {defect_id:"BUG-BLOCKER",title:"阻断缺陷",category:"product_defect",severity:"Blocker"},
    {defect_id:"BUG-UNKNOWN",title:"未评估缺陷",category:"product_defect",severity:"unknown",severity_reason:"缺少生产账号无法确认影响"},
    {defect_id:"BUG-NONE",title:"未记录缺陷",category:"product_defect"},
  ]}), {status:200})));
  await mount(h(DefectResults,{projectId:"test",sessionId:"session-a",runId:"run-one",artifacts:[{path:"output/runs/run-one/defects/defect-records.json",name:"defect-records.json",stage:"defects",size:200,available:true,verified:true}],refresh:0}));
  await run(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  expect(document.querySelector(".qtd-list-heading")?.textContent).toContain("3 / 3 条");
  expect(document.querySelector('[role="note"]')?.textContent).toContain("2 条严重度未评估或未记录");
  expect(document.querySelector(".qtd-table-wrap")?.textContent).toContain("阻断");
  expect(document.querySelector(".qtd-table-wrap")?.textContent).toContain("未评估");
  expect(document.querySelector(".qtd-table-wrap")?.textContent).toContain("未记录");
  const filter = document.querySelector('[aria-label="缺陷严重程度筛选"]') as HTMLSelectElement;
  await run(() => { filter.value = "unknown"; filter.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(document.querySelectorAll(".qtd-table-wrap tbody tr")).toHaveLength(1);
  expect(document.querySelector(".qtd-table-wrap")?.textContent).toContain("BUG-UNKNOWN");
  await run(() => { filter.value = "unrecorded"; filter.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(document.querySelector(".qtd-table-wrap")?.textContent).toContain("BUG-NONE");
  await run(() => { filter.value = "all"; filter.dispatchEvent(new Event("change", { bubbles: true })); });
  await click([...document.querySelectorAll(".qtd-table-wrap button")].find(button => button.closest("tr")?.textContent?.includes("BUG-UNKNOWN")) as HTMLButtonElement);
  expect(document.querySelector('[aria-label="缺陷详情"]')?.textContent).toContain("缺少生产账号无法确认影响");
  expect(document.querySelector('[aria-label="缺陷详情"] [role="note"]')?.textContent).toContain("不能按低风险处理");
});
