// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { createElement as h } from "react";
import { mount, unmountAll, click, pressEscape } from "./helpers/dom";
import { AdminSkillsPage } from "../src/features/admin/admin-skills-page";
import { AdminSkillVersionsPage } from "../src/features/admin/admin-skill-versions-page";
import { skillPresentation } from "../src/features/skills/skill-presentation";

const calls=vi.hoisted(()=>({request:vi.fn()}));
vi.mock("../src/api/control",()=>({controlRequest:calls.request}));
vi.mock("../src/api/endpoints",()=>({getAgentConfig:vi.fn(),putAgentConfig:vi.fn()}));
vi.mock("../src/state/project",()=>({useProject:()=>{throw new Error("useProject must be used within a ProjectProvider");}}));
afterEach(async()=>{await unmountAll();calls.request.mockReset();});

it("shows the skill's Chinese title and actual introduction instead of import placeholders", () => {
  expect(skillPresentation({name:"test-point-design",description:"AITestHarness 内置测试技能 · test-point-design",content:"---\r\nname: test-point-design\r\ndescription: 基于需求设计正常、异常和边界测试点。\r\n---\r\n# 测试点设计 Skill"})).toEqual({displayName:"测试点设计",summary:"基于需求设计正常、异常和边界测试点。"});
  expect(skillPresentation({name:"browser-automation",description:"Read browser pages",content:"---\nshort_description_zh: >-\n  读取页面并执行操作，\n  提取页面数据。\n---\n# Browser automation"})).toEqual({displayName:"浏览器自动化",summary:"读取页面并执行操作， 提取页面数据。"});
  expect(skillPresentation({name:"browser-automation",description:"管理员更新后的简介",content:"---\nshort_description_zh: 旧简介\n---"}).summary).toBe("管理员更新后的简介");
});

it("renders without a local ProjectProvider and opens version management from the original card",async()=>{
  const skill={id:"11111111-1111-1111-1111-111111111111",name:"sample-skill",description:"中央说明",content:"---\nname: sample-skill\ndescription: 中央说明\n---\n\n# 中央正文",files:{"SKILL.md":"# 中央正文"},categoryId:"common",revision:2,archive:false};
  calls.request.mockImplementation(async(path:string,method="GET")=>{
    if(path==="/api/control/skills/admin"&&method==="GET")return {skills:[skill],categories:[{id:"common",name:"通用",builtin:1}]};
    if(path==="/api/control/skills/admin/"+skill.id+"/version-management"&&method==="GET")return {skill,versions:[{label:"V1.0.0",state:"current",revision:1,changeNote:"",createdAt:"2026-11-06T00:00:00Z",files:[{path:"SKILL.md",size:12,hash:"hash"}],size:12}],currentLabel:"V1.0.0",agentCount:1};
    throw Error("Unexpected request: "+method+" "+path);
  });
  await mount(h(AdminSkillsPage,{central:true}));
  expect(document.querySelector(".admin-skills-card")?.textContent).toContain("中央说明");
  await click(document.querySelector(".admin-skills-card") as HTMLElement);
  expect(document.querySelector("[role=dialog]")?.textContent).toContain("中央正文");
  await pressEscape();
  expect(document.querySelector('[aria-label="编辑 sample-skill"]')).toBeNull();
  await click(document.querySelector('[aria-label="版本管理 sample-skill"]') as HTMLButtonElement);
  expect(document.querySelector(".admin-skill-version-page")?.textContent).toContain("V1.0.0");
  expect(document.querySelector('[aria-label="删除 sample-skill"]')).toBeNull();
});

it("shows the Chinese skill presentation and compares every adjacent selected version",async()=>{
  const id="versioned-skill";
  const skill={name:"test-point-design",description:"AITestHarness 内置测试技能 · test-point-design",content:"---\nname: test-point-design\ndescription: 基于需求设计测试点。\n---\n\n# 测试点设计",categoryId:"design"};
  const versions=["V1.2.0","V1.1.0","V1.0.0"].map((label,index)=>({label,state:index===0?"current":"published",revision:1,changeNote:"",createdAt:`2026-11-0${3-index}T00:00:00Z`,files:[{path:"SKILL.md",size:12,hash:label}],size:12}));
  calls.request.mockImplementation(async(path:string)=>{
    if(path===`/api/control/skills/admin/${id}/version-management`)return {skill,versions,currentLabel:"V1.2.0",agentCount:1};
    if(path.startsWith(`/api/control/skills/admin/${id}/version-diff?`))return {files:[]};
    throw Error("Unexpected request: "+path);
  });
  await mount(h(AdminSkillVersionsPage,{id,back:()=>{}}));
  expect(document.querySelector(".admin-skill-version-page")?.textContent).toContain("测试点设计 · 版本管理");
  expect(document.querySelector(".sv-info-desc")?.textContent).toBe("基于需求设计测试点。");
  const compare=[...document.querySelectorAll("button")].find(button=>button.textContent?.includes("版本对比"))!;
  await click(compare);
  expect(calls.request).toHaveBeenCalledTimes(1);
  for(const checkbox of document.querySelectorAll<HTMLInputElement>('.sv-cmp-pick input[type="checkbox"]'))await click(checkbox);
  await click(compare);
  expect(calls.request).toHaveBeenCalledWith(expect.stringContaining("version-diff?a=V1.1.0&b=V1.2.0"));
  expect(calls.request).toHaveBeenCalledWith(expect.stringContaining("version-diff?a=V1.0.0&b=V1.1.0"));
  expect(document.querySelector("[role=dialog]")?.textContent).toContain("V1.2.0 ← V1.1.0");
});
