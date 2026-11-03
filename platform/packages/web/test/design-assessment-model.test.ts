/**
 * The three synthetic acceptance samples the handoff requires, plus a legacy artifact:
 * 1. a simple case whose expected sentence is quoted from a loaded source;
 * 2. a case whose citation exists but does not support the promised semantics;
 * 3. a report with a high-risk untested point and a pending defect;
 * 4. old artifacts without expected_basis/observations stay readable.
 *
 * Each fixture keeps its input and expected judgement so a reviewer can see why the model said
 * what it said. These are engineering checks, not real business acceptance.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  assessDesign,
  assessResidualRisk,
  type DesignAssessmentInput,
  type ResidualRiskInput,
} from "../src/features/qa/design-assessment-model";

type Fixture<T> = {
  name: string;
  description: string;
  input: T;
  expected: Record<string, unknown>;
};

function fixture<T>(name: string): Fixture<T> {
  return JSON.parse(
    readFileSync(new URL(`./fixtures/design-assessment/${name}.json`, import.meta.url), "utf8"),
  ) as Fixture<T>;
}

const stringArray = (value: unknown): string[] => (Array.isArray(value) ? value.map(String) : []);

describe("design assessment synthetic acceptance samples", () => {
  it("sample 1: a simple case with verbatim source support is executable and its point risk stays separate from complexity", () => {
    const sample = fixture<DesignAssessmentInput>("simple-supported");
    const design = assessDesign(sample.input);
    const point = design.points[0]!;
    const item = design.cases[0]!;

    expect(point.complexity).toBe(sample.expected.pointComplexity);
    expect(point.risk.level).toBe(sample.expected.pointRisk);
    expect(item.complexity).toBe(sample.expected.caseComplexity);
    expect(item.status).toBe(sample.expected.caseStatus);
    expect(item.confidence.expectedBasis.status).toBe(sample.expected.expectedBasis);
    expect(item.confidence.designValidity.status).toBe(sample.expected.designValidity);
    expect(item.confidence.executability.status).toBe(sample.expected.executability);
    expect(item.confidence.coverageSufficiency.status).toBe(sample.expected.coverageSufficiency);
    expect(item.confidence.expectedBasis.reasons.join(" ")).toContain("机械语义检查");
    expect(design.summary.executableCases).toBe(1);
  });

  it("sample 2: an existing citation whose quote does not support the clause is unsupported, not trusted", () => {
    const sample = fixture<DesignAssessmentInput>("citation-unsupported");
    const design = assessDesign(sample.input);
    const item = design.cases[0]!;
    const basis = item.confidence.expectedBasis;

    expect(sample.expected.citationExists).toBe(true);
    expect(item.status).toBe(sample.expected.caseStatus);
    expect(basis.status).toBe(sample.expected.expectedBasis);
    expect(item.confidence.designValidity.status).toBe(sample.expected.designValidity);
    expect(basis.reasons.join(" ")).toContain(String(sample.expected.reasonIncludes));
    expect(basis.reasons.join(" ")).toContain("引用存在不等于语义受支持");
    expect(design.summary.needsRevisionCases).toBe(1);
  });

  it("sample 3: high-risk untested work and a pending defect are separate residual risk groups, and no result is not a pass", () => {
    const sample = fixture<ResidualRiskInput>("residual-risk-report");
    const risk = assessResidualRisk(sample.input);
    const expectedCounts = sample.expected.counts as Record<string, number>;

    expect(risk.headline).toBe(sample.expected.headline);
    expect(risk.headlineLabel).toBe(sample.expected.headlineLabel);
    expect(risk.counts.points).toBe(expectedCounts.points);
    expect(risk.counts.businessCases).toBe(expectedCounts.businessCases);
    expect(risk.counts.assertions).toBe(expectedCounts.assertions);
    expect(risk.counts.passed).toBe(expectedCounts.passed);
    expect(risk.counts.confirmedDefects).toBe(expectedCounts.confirmedDefects);
    expect(risk.counts.pendingDefects).toBe(expectedCounts.pendingDefects);

    expect(risk.groups.confirmedDefects.map((item) => item.id)).toEqual(["defect:DEF-1"]);
    expect(risk.groups.pendingPhenomena.map((item) => item.id)).toEqual(["defect:DEF-2"]);

    const uncoveredIds = risk.groups.uncoveredRisks.map((item) => item.id);
    for (const id of stringArray(sample.expected.uncoveredIds)) expect(uncoveredIds).toContain(id);

    const highPoint = risk.groups.uncoveredRisks.find((item) => item.id === "point:P-HIGH")!;
    expect(highPoint.impact).toBe("high");
    expect(highPoint.status).toBe("未测");
    expect(highPoint.reasons.join(" ")).toContain("高风险测试点没有完整执行结果");

    expect(risk.notes.join(" ")).toContain("没有执行结果不得计为通过");
    expect(risk.notes.join(" ")).toContain("缺失事实显示“无法评估”");
  });

  it("an independent case without a related point is not failed for that alone", () => {
    const design = assessDesign({
      points: [],
      cases: [
        {
          case_id: "CASE-STANDALONE",
          title: "独立提交",
          steps: ["点击提交"],
          expected: "页面显示提交成功",
          automation_feasible: true,
          expected_basis: [
            { expected: "页面显示提交成功", kind: "requirement", source_path: "inputs/req.txt", quote: "页面显示提交成功" },
          ],
        },
      ],
      sources: { "inputs/req.txt": "页面显示提交成功" },
    });
    const item = design.cases[0]!;

    expect(item.confidence.designValidity.status).toBe("supported");
    expect(item.confidence.coverageSufficiency.status).toBe("unknown");
    expect(item.status).toBe("executable");
  });

  it("legacy artifacts keep their missing fields readable instead of inventing support", () => {    const sample = fixture<DesignAssessmentInput>("legacy-missing-fields");
    const design = assessDesign(sample.input);
    const point = design.points[0]!;
    const item = design.cases[0]!;

    expect(point.complexity).toBe(sample.expected.pointComplexity);
    expect(point.risk.level).toBe("unknown");
    expect(item.complexity).toBe(sample.expected.caseComplexity);
    expect(item.confidence.expectedBasis.status).toBe(sample.expected.expectedBasis);
    expect(item.confidence.executability.status).toBe(sample.expected.executability);
    expect(item.status).toBe(sample.expected.caseStatus);
    expect(item.confidence.expectedBasis.reasons.join(" ")).toContain("旧产物或当前用例未记录预期依据");
    expect(design.points[0]!.title).toBe("TP-OLD");
  });

  it("missing facts produce unknown residual risk rather than low or zero risk", () => {
    const risk = assessResidualRisk({});
    expect(risk.headline).toBe("unknown");
    expect(risk.counts.points).toBeNull();
    expect(risk.counts.confirmedDefects).toBeNull();
    expect(risk.unknowns.join(" ")).toContain("缺陷事实未加载");
    expect(risk.unknowns.join(" ")).toContain("报告索引未加载");
    expect(risk.items).toHaveLength(0);
  });
});
