import { expect, it } from "vitest";
import {
  DEFECT_SEVERITY_LABELS,
  DEFECT_SEVERITY_ORDER,
  isSeverityUnknown,
  severityDimensionLabel,
  severityDimensionValueLabel,
  severityLabel,
  severityRank,
  severitySummary,
} from "../src/features/qa/quality-traceability-model";

it("labels every level and keeps unknown apart from a low level", () => {
  expect(Object.keys(DEFECT_SEVERITY_LABELS)).toEqual([...DEFECT_SEVERITY_ORDER]);
  expect(severityLabel("Blocker")).toBe("阻断");
  expect(severityLabel("unknown")).toBe("未评估");
  expect(severityLabel(undefined)).toBe("未记录");
  expect(isSeverityUnknown("unknown")).toBe(true);
  expect(isSeverityUnknown(undefined)).toBe(true);
  expect(isSeverityUnknown("Trivial")).toBe(false);
});

it("orders unknown last without ranking it as the mildest known level", () => {
  expect(severityRank("Blocker")).toBeLessThan(severityRank("Critical"));
  expect(severityRank("Minor")).toBeLessThan(severityRank("unknown"));
  expect(severityRank("nonsense")).toBe(DEFECT_SEVERITY_ORDER.length);
});

it("summarizes known, unknown and unrecorded counts separately", () => {
  const summary = severitySummary([{ severity: "Critical" }, { severity: "unknown" }, {}, { severity: "critical" }]);
  expect(summary.levels.Critical).toBe(1);
  expect(summary.unknown).toBe(1);
  expect(summary.unrecorded).toBe(2);
  expect(summary.total).toBe(4);
});

it("translates severity dimension keys and values, falling back to the raw value", () => {
  expect(severityDimensionLabel("recoverability")).toBe("恢复方式");
  expect(severityDimensionValueLabel("workaround")).toBe("有绕过");
  expect(severityDimensionLabel("other")).toBe("other");
  expect(severityDimensionValueLabel("other")).toBe("other");
});
