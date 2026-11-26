// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createElement as h } from "react";
import { ProjectProvider, useProject } from "../src/state/project";
import { mount, settle, unmountAll } from "./helpers/dom";
import { json, stubFetch } from "./helpers/fetch";

const business = "review_user-business";
const assistant = "review_user-aitest_system_assistant";
const summary = (projectId: string) => ({
  projectId, name: projectId, role: "owner", ownerUserId: "review_user",
  createdAt: "2026-11-24T00:00:00.000Z",
});

function CurrentProject() {
  const { projects, currentProject } = useProject();
  return h("output", null, `${currentProject?.projectId ?? "none"}|${projects.length}`);
}

beforeEach(() => localStorage.clear());
afterEach(async () => { await unmountAll(); });

describe("assistant runtime context", () => {
  it("returns to the selected business project after visiting the assistant", async () => {
    localStorage.setItem("penguin.lastProjectId", business);
    stubFetch(({ path }) => {
      if (path === "/api/projects") return json({ projects: [summary(business)], assistantProject: summary(assistant) });
      if (path.endsWith("/agents")) return json({ agents: [] });
      return json({});
    });
    const page = (assistantRoute: boolean) => h(ProjectProvider, { assistantRoute, children: h(CurrentProject) });
    const mounted = await mount(page(false));
    await settle();
    expect(mounted.container.textContent).toBe(`${business}|1`);

    await mounted.rerender(page(true));
    await settle();
    expect(mounted.container.textContent).toBe(`${assistant}|1`);
    expect(localStorage.getItem("penguin.lastProjectId")).toBe(business);

    await mounted.rerender(page(false));
    await settle();
    expect(mounted.container.textContent).toBe(`${business}|1`);
  });

  it("leaves business projects empty for a new user", async () => {
    stubFetch(({ path }) => {
      if (path === "/api/projects") return json({ projects: [], assistantProject: summary(assistant) });
      if (path.endsWith("/agents")) return json({ agents: [] });
      return json({});
    });
    const page = (assistantRoute: boolean) => h(ProjectProvider, { assistantRoute, children: h(CurrentProject) });
    const mounted = await mount(page(true));
    await settle();
    expect(mounted.container.textContent).toBe(`${assistant}|0`);

    await mounted.rerender(page(false));
    await settle();
    expect(mounted.container.textContent).toBe("none|0");
  });
});
