// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { createElement as h } from "react";
import { mount, unmountAll, click, run } from "./helpers/dom";
import { ExecutionResults } from "../src/features/qa/execution-results";
import { DefectResults } from "../src/features/qa/defect-results";

afterEach(async () => { await unmountAll(); vi.unstubAllGlobals(); });

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
