/**
 * The loader is the only bridge between the raw design artifacts and the pure model. These tests
 * pin what it may read: verified artifacts and the run's own sources; an artifact whose hash check
 * failed or a source outside the run stays unread instead of being guessed.
 */
import { afterEach, expect, it, vi } from "vitest";
import { loadDesignAssessment } from "../src/features/qa/design-assessment-loader";

const detail = {
  runId: "run-1",
  status: "completed",
  workflowMode: "task",
  artifacts: [
    {
      path: "output/runs/run-1/design/test_points.json",
      name: "test_points.json",
      stage: "test_points",
      type: "数据",
      size: 10,
      available: true,
      verified: true,
    },
    {
      path: "output/runs/run-1/design/test_cases.json",
      name: "test_cases.json",
      stage: "test_cases",
      type: "数据",
      size: 10,
      available: true,
      verified: true,
    },
  ],
};

const points = [{ id: "TP-1", description: "登录成功", risk: "中", coverage_type: ["functional"] }];
const cases = [
  {
    case_id: "CASE-1",
    title: "登录成功",
    steps: ["点击登录"],
    expected: "页面显示登录成功",
    automation_feasible: true,
    related_test_point: "TP-1",
    expected_basis: [
      { expected: "页面显示登录成功", source_path: "inputs/req.txt", quote: "页面显示登录成功" },
    ],
  },
];
const manifest = {
  run_id: "run-1",
  test_tracks: { spec: { tracks: [{ source_paths: ["inputs/req.txt"] }] } },
  orchestration: { plan: { workflow_mode: "task" } },
};
const ledger = {
  sources: [{ id: "SRC-1", path: "inputs/req.txt" }],
  rules: [{ id: "RULE-1", statement: "页面显示登录成功", status: "confirmed", citations: [{ source_id: "SRC-1", quote: "页面显示登录成功" }] }],
};

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
}

function stubRun(options: { pointsVerified?: boolean } = {}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/projects/")) return json({ ...detail, artifacts: detail.artifacts.map((item) => ({ ...item, verified: options.pointsVerified === false && item.stage === "test_points" ? false : item.verified })) });
      if (url.includes("test_points.json")) return json(points);
      if (url.includes("test_cases.json")) return json(cases);
      if (url.includes("manifest.json")) return json(manifest);
      if (url.includes("requirement-ledger.json")) return json(ledger);
      if (url.includes("inputs%2Freq.txt") || url.includes("inputs/req.txt")) return new Response("页面显示登录成功");
      return new Response("", { status: 404 });
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("loads verified design artifacts, the run manifest, ledger rules and source text", async () => {
  stubRun();
  const data = await loadDesignAssessment("demo", "session-1", "run-1", new AbortController().signal);

  expect(data.mode).toBe("task");
  expect(data.points).toHaveLength(1);
  expect(data.cases).toHaveLength(1);
  expect(data.rules.map((rule) => rule.ruleId)).toEqual(["RULE-1"]);
  expect(data.sources["inputs/req.txt"]).toContain("登录成功");
  expect(data.artifacts.points?.verified).toBe(true);
  expect(data.artifacts.cases?.loaded).toBe(true);
  expect(data.warnings).toEqual([]);
  expect(data.sourceStatus).toEqual([{ path: "inputs/req.txt", loaded: true }]);
});

it("does not use an artifact whose hash check failed", async () => {
  stubRun({ pointsVerified: false });
  const data = await loadDesignAssessment("demo", "session-1", "run-1", new AbortController().signal);

  expect(data.points).toEqual([]);
  expect(data.artifacts.points?.loaded).toBe(false);
  expect(data.warnings.join(" ")).toContain("哈希校验未通过");
});
