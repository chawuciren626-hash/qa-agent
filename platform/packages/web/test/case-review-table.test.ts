// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { createElement as h } from "react";
import { mount, unmountAll, click, run, type } from "./helpers/dom";
import { CaseReviewTable } from "../src/features/qa/case-review-table";
const state=vi.hoisted(()=>({posts:[] as any[],unavailable:false,multiple:false}));
vi.mock("../src/api/client",()=>({apiFetch:async (_path:string,options?:any)=>{
  if(options?.method==="POST"){state.posts.push(options.body);return {status:"saved"};}
  if(state.unavailable)throw Object.assign(new Error("当前阶段尚无已校验的用例列表。"),{code:"cases_unavailable"});
  return {version:"a".repeat(64),confirmationId:"confirm-one",columns:[{key:"case_id",label:"模板编号",editable:false},{key:"title",label:"模板测试项",editable:true},...(state.multiple?[{key:"steps",label:"操作步骤",editable:true},{key:"preconditions",label:"前置条件",editable:true}]:[])],rows:Array.from({length:23},(_,i)=>({id:`TC-${i+1}`,values:{case_id:`TC-${i+1}`,title:`用例 ${i+1}`,steps:["输入账号密码","点击登录"],preconditions:["页面可用","账号已创建"],test_data:{}}}))};
}}));
afterEach(async()=>{await unmountAll();state.posts=[];state.unavailable=false;state.multiple=false;});
it("keeps the case columns and an empty row before the delivery is available",async()=>{
  state.unavailable=true;
  await mount(h(CaseReviewTable,{endpoint:"/cases",canEdit:false,refresh:0,onSaved:vi.fn(),onBusyChange:vi.fn()}));await run(()=>{});
  expect(document.querySelector("thead")?.textContent).toContain("测试项");
  expect(document.querySelector("tbody")?.textContent).toBe("暂无数据");
  expect(document.querySelector('[role="alert"]')).toBeNull();
});
it("uses template labels, defaults to ten rows and changes pages and page size",async()=>{
  await mount(h(CaseReviewTable,{endpoint:"/cases",canEdit:true,refresh:0,onSaved:vi.fn(),onBusyChange:vi.fn()}));await run(()=>{});
  expect(document.querySelectorAll("tbody tr")).toHaveLength(10);
  expect(document.querySelector("thead")?.textContent).toContain("模板测试项");
  await click([...document.querySelectorAll("button")].find(el=>el.textContent==="下一页")!);
  expect(document.querySelector("tbody")?.textContent).toContain("TC-11");
  const select=document.querySelector('[aria-label="每页用例数量"]') as HTMLSelectElement;
  await run(()=>{select.value="20";select.dispatchEvent(new Event("change",{bubbles:true}));});
  expect(document.querySelectorAll("tbody tr")).toHaveLength(20);
});
it("view is read-only and deletion binds the current review and source version",async()=>{
  const saved=vi.fn(),busy=vi.fn();
  await mount(h(CaseReviewTable,{endpoint:"/cases",canEdit:true,refresh:0,onSaved:saved,onBusyChange:busy}));await run(()=>{});
  await click([...document.querySelectorAll("button")].find(el=>el.textContent==="查看")!);
  expect(document.querySelector('[role="dialog"] textarea')).toBeNull();
  await click(document.querySelector('[aria-label="关闭用例窗口"]')!);
  await click([...document.querySelectorAll("button")].find(el=>el.textContent==="删除")!);
  expect(busy).toHaveBeenLastCalledWith(true);
  await click([...document.querySelectorAll("button")].find(el=>el.textContent==="确认删除")!);
  expect(state.posts[0]).toMatchObject({caseId:"TC-1",operation:"delete",confirmationId:"confirm-one",version:"a".repeat(64)});
  expect(saved).toHaveBeenCalledOnce();expect(busy).toHaveBeenLastCalledWith(false);
});
it("saves edited template fields without approving the stage",async()=>{
  const saved=vi.fn();
  await mount(h(CaseReviewTable,{endpoint:"/cases",canEdit:true,refresh:0,onSaved:saved,onBusyChange:vi.fn()}));await run(()=>{});
  await click([...document.querySelectorAll("button")].find(el=>el.textContent==="编辑")!);
  await type(document.querySelector('[aria-label="模板测试项"]') as HTMLTextAreaElement,"修改后的测试项");
  await click([...document.querySelectorAll("button")].find(el=>el.textContent==="保存")!);
  expect(state.posts[0]).toMatchObject({operation:"edit",values:{title:"修改后的测试项"}});
  expect(saved).toHaveBeenCalledOnce();
});
it("numbers multi-value fields while editing and viewing, then saves clean array entries",async()=>{
  state.multiple=true;
  await mount(h(CaseReviewTable,{endpoint:"/cases",canEdit:true,refresh:0,onSaved:vi.fn(),onBusyChange:vi.fn()}));await run(()=>{});
  expect(document.querySelector("tbody")?.textContent).toContain("1. 输入账号密码");
  await click([...document.querySelectorAll("button")].find(el=>el.textContent==="编辑")!);
  const steps=document.querySelector('[aria-label="操作步骤"]') as HTMLTextAreaElement;
  expect(steps.value).toContain("2. 点击登录");
  await type(steps,"输入手机号\n点击登录");
  await run(()=>steps.dispatchEvent(new FocusEvent("focusout",{bubbles:true})));
  expect(steps.value).toContain("1. 输入手机号\n2. 点击登录");
  await click([...document.querySelectorAll("button")].find(el=>el.textContent==="保存")!);
  expect(state.posts[0].values.steps).toEqual(["输入手机号","点击登录"]);
  expect(state.posts[0].values.preconditions).toEqual(["页面可用","账号已创建"]);
});
