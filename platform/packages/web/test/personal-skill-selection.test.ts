/**
 * The round personal-Skill model: how a selection reads and which failures the person sees in
 * their own language. It pins versions and states a round scope; it never claims an install.
 */
import { describe, expect, it } from "vitest";
import {
  canCancel,
  expiryLabel,
  resourceLine,
  selectionErrorHint,
  selectionHeadline,
  selectionLines,
  selectionStatusLabel,
  shortHash,
  type RoundSelectionView,
} from "../src/features/qa/personal-skill-selection";

const NOW = Date.parse("2026-11-02T09:10:00.000Z");

function view(patch: Partial<RoundSelectionView> = {}): RoundSelectionView {
  return {
    selectionId: "9a2f",
    scope: "round",
    status: "active",
    round: 3,
    projectId: "demo",
    sessionId: "session-1",
    agentId: "test_agent",
    createdAt: "2026-11-02T09:10:00.000Z",
    expiresAt: "2026-11-02T15:10:00.000Z",
    resources: [
      {
        resourceId: "0f5a",
        name: "api-extra",
        version: 1,
        contentHash: "sha256:abcdef0123456789",
        skills: ["api-extra"],
      },
    ],
    skills: [
      {
        name: "api-extra",
        resourceId: "0f5a",
        resourceVersion: 1,
        contentHash: "sha256:abcdef0123456789",
      },
    ],
    ...patch,
  };
}

describe("selection status wording", () => {
  it("says the scope, not the installation", () => {
    expect(selectionStatusLabel("active")).toBe("本轮生效");
    expect(selectionStatusLabel("consumed")).toBe("本轮已使用");
    expect(selectionStatusLabel("superseded")).toBe("已被新选择取代");
    expect(selectionStatusLabel("expired")).toBe("已过期");
  });

  it("only a selection already used stays (it is the audit record)", () => {
    expect(canCancel(view())).toBe(true);
    expect(canCancel(view({ status: "expired" }))).toBe(true);
    expect(canCancel(view({ status: "superseded" }))).toBe(true);
    expect(canCancel(view({ status: "consumed" }))).toBe(false);
  });
});

describe("version and hash display", () => {
  it("cuts a stored digest to the comparable part", () => {
    expect(shortHash("sha256:abcdef0123456789")).toBe("abcdef01");
    expect(shortHash("abcdef0123")).toBe("abcdef01");
  });

  it("has no hash to name", () => {
    expect(shortHash(undefined)).toBe("未知");
    expect(shortHash("")).toBe("未知");
  });

  it("a resource line carries name, pinned version, chosen Skills and content hash", () => {
    expect(resourceLine(view().resources[0]!)).toBe(
      "api-extra v1 · api-extra · 内容 abcdef01",
    );
  });

  it("a resource with no chosen Skill says so instead of an empty gap", () => {
    expect(resourceLine({ ...view().resources[0]!, skills: [] })).toBe(
      "api-extra v1 · 未选择 Skill · 内容 abcdef01",
    );
  });

  it("the headline counts rounds, resources and Skills", () => {
    expect(selectionHeadline(view())).toBe("第 3 轮 · 1 个资源 · 1 个 Skill");
  });
});

describe("expiry", () => {
  it("reads in hours and minutes while there is time left", () => {
    expect(expiryLabel("2026-11-02T15:10:00.000Z", NOW)).toBe("约剩 6 小时");
    expect(expiryLabel("2026-11-02T10:40:00.000Z", NOW)).toBe("约剩 1 小时 30 分钟");
    expect(expiryLabel("2026-11-02T09:40:00.000Z", NOW)).toBe("约剩 30 分钟");
  });

  it("does not offer a selection that is already over", () => {
    expect(expiryLabel("2026-11-02T09:10:00.000Z", NOW)).toBe("已过期");
    expect(expiryLabel("2026-11-02T08:10:00.000Z", NOW)).toBe("已过期");
    expect(expiryLabel("not-a-date", NOW)).toBe("已过期");
  });

  it("the lines pair each resource with when the round stops using it", () => {
    const lines = selectionLines(view(), NOW);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe("api-extra v1 · api-extra · 内容 abcdef01");
    expect(lines[1]).toContain("约剩 6 小时");
  });
});

describe("selection error hints", () => {
  it("tells the person what to change", () => {
    expect(selectionErrorHint("protected_skill")).toContain("内置测试 Skill");
    expect(selectionErrorHint("skill_selection_conflict")).toContain("同名 Skill");
    expect(selectionErrorHint("selection_conflict")).toContain("重新选择");
    expect(selectionErrorHint("selection_not_active")).toContain("重新选择");
    expect(selectionErrorHint("session_not_found")).toContain("任务");
    expect(selectionErrorHint("resource_not_found")).toContain("已被删除");
    expect(selectionErrorHint("skill_not_in_resource")).toContain("Skill");
    expect(selectionErrorHint("resource_in_selection")).toContain("取消选择");
  });

  it("leaves codes it does not own to the shared localisation", () => {
    expect(selectionErrorHint("http_error")).toBeUndefined();
    expect(selectionErrorHint(undefined)).toBeUndefined();
  });
});
