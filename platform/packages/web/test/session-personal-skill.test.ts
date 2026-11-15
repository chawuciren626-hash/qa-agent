// @vitest-environment jsdom
/**
 * The composer's round-scoped personal Skill chooser: it reads Q1's resource list and the
 * Session's current selection, creates a round, and shows the pinned version/hash. The chooser
 * is the only UI on this path; consumption itself is the server's (qa-task-context tests).
 */
import { afterEach, expect, it, vi } from "vitest";
import { createElement as h } from "react";
import { click, mount, settle, unmountAll, waitFor } from "./helpers/dom";

const state = vi.hoisted(() => ({
  calls: [] as { url: string; init?: { method?: string; body?: unknown; query?: unknown } }[],
  resources: [] as unknown[],
  selection: null as unknown,
  listError: null as Error | null,
}));

vi.mock("../src/state/project", () => ({
  useProject: () => ({ currentProject: { projectId: "demo" } }),
}));

vi.mock("../src/api/client", async () => {
  const actual = await vi.importActual<typeof import("../src/api/client")>("../src/api/client");
  return {
    ...actual,
    apiFetch: async (url: string, init?: { method?: string; body?: unknown; query?: unknown }) => {
      state.calls.push({ url, ...(init ? { init } : {}) });
      if (url.endsWith("/personal-resources")) {
        if (state.listError) throw state.listError;
        return { resources: state.resources, canApply: true };
      }
      if (url.endsWith("/selection") && !init?.method) return { selection: state.selection };
      if (url.endsWith("/selection") && init?.method === "POST") {
        return {
          idempotent: false,
          selection: {
            selectionId: "selection-1",
            scope: "round",
            status: "active",
            round: 1,
            projectId: "demo",
            sessionId: "session-1",
            agentId: "test_agent",
            createdAt: "2026-11-03T00:00:00Z",
            expiresAt: "2099-11-03T00:00:00Z",
            resources: [
              {
                resourceId: "r1",
                name: "需求技能",
                version: 3,
                contentHash: "sha256:abcdef1234567890",
                skills: ["requirement-skill"],
              },
            ],
            skills: [
              {
                name: "requirement-skill",
                resourceId: "r1",
                resourceVersion: 3,
                contentHash: "sha256:abcdef1234567890",
              },
            ],
          },
        };
      }
      return {};
    },
  };
});

import { SessionPersonalSkill } from "../src/features/chat/session-personal-skill";
import { ApiError } from "../src/api/client";

afterEach(async () => {
  await unmountAll();
  state.calls = [];
  state.resources = [];
  state.selection = null;
  state.listError = null;
});

function chooser(open = true) {
  return h(SessionPersonalSkill, {
    sessionId: "session-1",
    agentId: "test_agent",
    open,
    onClose: () => {},
  });
}

const byText = (text: string) =>
  [...document.querySelectorAll("button")].find((el) => el.textContent?.trim() === text);

it("creates a round selection and shows the pinned version and content hash", async () => {
  state.resources = [
    {
      id: "r1",
      name: "需求技能",
      kind: "skill",
      version: 3,
      contentHash: "sha256:abcdef1234567890",
      createdAt: "2026-11-03T00:00:00Z",
      skills: ["requirement-skill"],
      appliedAgents: [],
    },
  ];
  await mount(chooser());
  await waitFor(() => byText("创建本轮选择") !== undefined);
  const box = document.querySelector<HTMLInputElement>("input[type=checkbox]")!;
  await click(box);
  await click(byText("创建本轮选择")!);
  await settle();
  expect(state.calls.some((call) => call.init?.method === "POST")).toBe(true);
  const text = document.body.textContent ?? "";
  expect(text).toContain("仅本轮生效");
  expect(text).toContain("需求技能 v3");
  expect(text).toContain("abcdef12");
  expect(text).toContain("第 1 轮");
});

it("shows a consumed round as used and offers no cancel", async () => {
  state.selection = {
    selectionId: "selection-old",
    scope: "round",
    status: "consumed",
    round: 2,
    projectId: "demo",
    sessionId: "session-1",
    agentId: "test_agent",
    createdAt: "2026-11-02T00:00:00Z",
    expiresAt: "2099-11-03T00:00:00Z",
    consumedAt: "2026-11-02T01:00:00Z",
    resources: [
      {
        resourceId: "r1",
        name: "需求技能",
        version: 3,
        contentHash: "sha256:abcdef1234567890",
        skills: ["requirement-skill"],
      },
    ],
    skills: [
      {
        name: "requirement-skill",
        resourceId: "r1",
        resourceVersion: 3,
        contentHash: "sha256:abcdef1234567890",
      },
    ],
  };
  await mount(chooser());
  await waitFor(() => (document.body.textContent ?? "").includes("本轮已使用"));
  expect(document.body.textContent).toContain("本轮已随任务发送被使用");
  expect(byText("取消本轮选择")).toBeUndefined();
});

it("does not fetch while closed, and explains a refused project instead of guessing", async () => {
  await mount(chooser(false));
  await settle();
  expect(state.calls).toHaveLength(0);
  await unmountAll();

  state.listError = new ApiError(403, "project_forbidden", "forbidden");
  await mount(chooser());
  await waitFor(() => (document.body.textContent ?? "").includes("没有该项目的访问权限"));
});
