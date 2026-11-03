/**
 * The project knowledge page's pure vocabulary: who may write, what an evidence reference
 * names, and the server refusals that must be said in the person's own words.
 */
import { describe, expect, it } from "vitest";
import {
  canEditKnowledge,
  candidateOriginLabel,
  documentSourceLabel,
  evidenceLine,
  knowledgeErrorHint,
  shortHash,
} from "../src/features/qa/project-knowledge-model";

describe("canEditKnowledge", () => {
  it("is true only for the account named by ownerUserId", () => {
    expect(canEditKnowledge({ role: "owner", ownerUserId: "u1" }, "u1")).toBe(true);
    // A QA admin can read any project (role owner) but is not its owner: the Q2 routes refuse
    // writes to exactly this state, so the page must not offer them.
    expect(canEditKnowledge({ role: "owner", ownerUserId: "u1" }, "admin")).toBe(false);
    expect(canEditKnowledge({ role: "member", ownerUserId: "u1" }, "u2")).toBe(false);
    expect(canEditKnowledge(null, "u1")).toBe(false);
    expect(canEditKnowledge({ role: "owner", ownerUserId: "u1" }, undefined)).toBe(false);
  });
});

describe("evidenceLine", () => {
  it("names a document with its revision and section", () => {
    expect(
      evidenceLine({ type: "document", documentId: "doc-1", revision: 3, section: "登录" }),
    ).toBe("资料 doc-1 修订 3 · 登录");
  });

  it("names a rule with its version", () => {
    expect(evidenceLine({ type: "rule", ruleId: "rule-1", version: 2 })).toBe("规则 rule-1 v2");
  });

  it("names an execution by task/run and evidence path", () => {
    expect(
      evidenceLine({
        type: "execution",
        sessionId: "s-1",
        runId: "run-1",
        evidencePath: "output/runs/run-1/report.md",
      }),
    ).toBe("执行 s-1/run-1 · output/runs/run-1/report.md");
  });

  it("names an external source by system and id or url", () => {
    expect(evidenceLine({ type: "external", system: "jira", externalId: "QA-1" })).toBe(
      "外部 jira · QA-1",
    );
    expect(evidenceLine({ type: "external", system: "wiki", url: "https://example.test/a" })).toBe(
      "外部 wiki · https://example.test/a",
    );
  });
});

describe("labels", () => {
  it("says where a document came from, including an uploaded file's name", () => {
    expect(documentSourceLabel({ type: "upload", filename: "spec.md" })).toBe("导入文件 spec.md");
    expect(documentSourceLabel({ type: "manual" })).toBe("手工录入");
    expect(documentSourceLabel(undefined)).toBe("来源未知");
  });

  it("distinguishes a person from an Agent and names the Agent's task", () => {
    expect(candidateOriginLabel({ type: "user", userId: "alice" })).toBe("用户 alice");
    expect(
      candidateOriginLabel({
        type: "agent",
        userId: "alice",
        agentId: "test_agent",
        sessionId: "s-1",
      }),
    ).toBe("Agent（test_agent · s-1）");
    expect(candidateOriginLabel({ type: "agent", userId: "alice" })).toBe("Agent");
  });

  it("cuts a hash to a comparable prefix", () => {
    expect(shortHash("sha256:abcdef1234567890")).toBe("abcdef12");
    expect(shortHash(undefined)).toBe("未知");
  });
});

describe("knowledgeErrorHint", () => {
  it("explains owner-only writes and revision conflicts with their own words", () => {
    expect(knowledgeErrorHint("project_owner_required")).toContain("仅项目所有者");
    expect(knowledgeErrorHint("document_revision_conflict")).toContain("刷新后再提交");
    expect(knowledgeErrorHint("unsupported_document_format")).toContain("UTF-8");
    expect(knowledgeErrorHint("document_not_found")).toContain("不属于当前项目");
  });

  it("leaves an unmapped code to the server message", () => {
    expect(knowledgeErrorHint("something_else")).toBeUndefined();
  });
});
