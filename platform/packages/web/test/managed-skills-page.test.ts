// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { createElement as h } from "react";
import { mount, unmountAll, click } from "./helpers/dom";
import { PersonalSkillsPage } from "../src/features/qa/personal-skills-page";
const calls = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("../src/api/control", () => ({ controlRequest: calls.request }));
vi.mock("../src/features/skills/central-skill-files", () => ({ CentralSkillFiles: () => h("div", null, "技能正文") }));
afterEach(async () => { await unmountAll(); calls.request.mockReset(); });
it("only reads the managed catalog, previews skills and refreshes without personal upload or selection", async () => {
  calls.request.mockResolvedValue({ skills: [{id:"s",name:"测试技能",description:"测试简介",files:{"SKILL.md":"内容"},categoryId:"test"}],categories:[{id:"test",name:"测试"}] });
  await mount(h(PersonalSkillsPage));
  expect(document.body.textContent).toContain("测试技能");
  expect(document.body.textContent).not.toMatch(/上传技能|我的技能与插件|本轮技能/);
  expect(document.querySelector('input[type="file"]')).toBeNull();
  await click(document.querySelector(".qm-skill-card") as HTMLElement);
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain("技能正文");
  expect(calls.request.mock.calls.every(args => args[0] === "/api/control/skills/catalog" && args.length === 1)).toBe(true);
});
