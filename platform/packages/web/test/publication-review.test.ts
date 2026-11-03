import { describe, expect, it } from "vitest";
import {
  canRestore,
  formatSize,
  isValidationSuccess,
  shortHash,
  validationReport,
  versionChanges,
  versionSummaryLines,
  versionTitle,
  type ResourceVersion,
  type ValidationResult,
} from "../src/features/admin/publication-review";

const skillValidation: ValidationResult = {
  valid: true,
  kind: "skills",
  summary: {
    kind: "skills",
    name: "接口测试补充",
    skillName: "api-extra",
    fileCount: 3,
    files: ["SKILL.md", "references/check.md", "references/api.md"],
    sizeBytes: 18_432,
    contentHash: "sha256:0123456789abcdef0123456789abcdef",
  },
  dependencies: [],
  warnings: [],
};

describe("a validation result", () => {
  it("reads a passed payload as a summary and never as a saved resource", () => {
    expect(isValidationSuccess(skillValidation)).toBe(true);
    const report = validationReport(skillValidation);
    expect(report.ok).toBe(true);
    expect(report.title).toBe("校验通过");
    expect(report.details).toContain("技能标识：api-extra");
    expect(report.details).toContain("文件：3 个（SKILL.md、references/check.md、references/api.md）");
    expect(report.details).toContain("大小：18.0 KB");
    expect(report.details).toContain("内容哈希：sha256:0123456789ab…");
    expect(report.details).toContain("依赖：无");
    expect(report.warnings).toEqual([]);
  });

  it("keeps a rejection's message and code, and is not taken as success", () => {
    const rejected: ValidationResult = {
      valid: false,
      error: { code: "invalid_public_configuration", message: "技能名称与原有导出包不一致。" },
    };
    expect(isValidationSuccess(rejected)).toBe(false);
    const report = validationReport(rejected);
    expect(report.ok).toBe(false);
    expect(report.title).toBe("校验未通过");
    expect(report.details).toEqual(["原因：技能名称与原有导出包不一致。"]);
    expect(report.warnings).toEqual(["错误码：invalid_public_configuration"]);
  });

  it("names dependencies and keeps the server's warnings apart", () => {
    const plugin: ValidationResult = {
      valid: true,
      kind: "plugins",
      summary: {
        kind: "plugins",
        name: "qa-helper",
        pluginName: "qa-helper",
        source: "managed",
        skillResources: ["skill-a", "skill-b"],
        instructionsLength: 12,
      },
      dependencies: [{ id: "skill-a", kind: "skills" }],
      warnings: ["依赖 skill-a 尚未发布。"],
    };
    const report = validationReport(plugin);
    expect(report.details).toContain("来源：公共说明与技能组合");
    expect(report.details).toContain("关联技能：2 个");
    expect(report.details).toContain("依赖：技能 skill-a");
    expect(report.warnings).toEqual(["依赖 skill-a 尚未发布。"]);
  });
});

describe("version history", () => {
  const current: ResourceVersion = {
    version: 3,
    created_at: "2026-11-02T09:00:00.000Z",
    current: true,
    published: true,
    summary: { kind: "skills", name: "v3", fileCount: 4, contentHash: "sha256:bbbb", sizeBytes: 2048 },
  };
  const older: ResourceVersion = {
    version: 1,
    created_at: "2026-11-01T09:00:00.000Z",
    current: false,
    published: false,
    summary: { kind: "skills", name: "v1", fileCount: 2, contentHash: "sha256:aaaa", sizeBytes: 1024 },
    audience: ["*"],
  };

  it("marks the current version and the published state", () => {
    expect(versionTitle(current)).toBe("v3 · 当前版本 · 已发布");
    expect(versionTitle(older)).toBe("v1 · 历史版本 · 已下架");
  });

  it("offers a restore only for an older version of a published resource", () => {
    expect(canRestore(older, true)).toBe(true);
    expect(canRestore(current, true)).toBe(false);
    expect(canRestore(older, false)).toBe(false);
    expect(canRestore({ ...older, version: 0 }, true)).toBe(false);
  });

  it("falls back to the retained body for a record without a summary", () => {
    const legacy: ResourceVersion = {
      version: 1,
      created_at: "2026-10-01T00:00:00.000Z",
      body: { name: "旧技能", description: "第一版", payload: { skillName: "qa", content: "x" }, audience: ["*"] },
    };
    expect(versionSummaryLines(legacy, "skills")).toEqual([
      "名称：旧技能",
      "说明：第一版",
      "内容字段：skillName、content",
      "受众：全部用户",
    ]);
    expect(versionSummaryLines({ version: 2, created_at: "" }, "skills")).toEqual([
      "旧版本记录：没有可展示的摘要。",
    ]);
  });

  it("says how a restore differs from the current version", () => {
    expect(versionChanges(older, current, "skills")).toEqual([
      "文件数：4 → 2",
      "大小：2.0 KB → 1.0 KB",
      "内容哈希：sha256:bbbb → sha256:aaaa",
    ]);
    expect(versionChanges(current, current, "skills")).toEqual([
      "与当前版本的内容摘要一致；恢复仍会记录为一个新版本，不改写历史。",
    ]);
    expect(versionChanges(older, undefined, "skills")).toEqual([
      "没有可比对的版本摘要；恢复仍会把历史内容记录为一个新版本。",
    ]);
  });
});

describe("sizes and hashes", () => {
  it("formats bytes at the unit a reader can compare", () => {
    expect(formatSize(undefined)).toBe("未提供");
    expect(formatSize(512)).toBe("512 B");
    expect(formatSize(1536)).toBe("1.5 KB");
    expect(formatSize(1024 * 1024 * 2.5)).toBe("2.50 MB");
  });

  it("keeps the algorithm prefix when shortening a hash", () => {
    expect(shortHash(undefined)).toBe("未提供");
    expect(shortHash("sha256:0123456789abcdef")).toBe("sha256:0123456789ab…");
    expect(shortHash("abc")).toBe("abc");
  });
});
