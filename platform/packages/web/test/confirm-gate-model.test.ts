/**
 * 确认卡点前端模型：展示口径的纯函数测试。
 *
 * 规则本体在服务端，前端模型只负责把服务端派生视图渲染对：
 * 必审筛选与三层视觉徽标必须与服务端口径一致，不允许前端出现第二套规则。
 */
import { describe, expect, it } from "vitest";
import {
  displayStatus, filterItems, isMustItem, rowAccent, RISK_LABEL,
  type ConfirmBatch, type ConfirmBatchView, type ConfirmItem,
} from "../src/features/qa/confirm-gate-model";

const items = [
  { id: "REQ-201", type: "需求", text: "登录锁定", risk: "P0", changed: true, st: "todo" },
  { id: "REQ-204", type: "需求", text: "命名规则不变", risk: "P1", changed: false, st: "inherit" },
  { id: "C-409", type: "用例", text: "多端踢出", risk: "unknown", changed: false, st: "todo" },
  { id: "C-501", type: "用例", text: "普通项", risk: "P2", changed: false, st: "pass" },
  { id: "C-502", type: "用例", text: "普通项被标问题", risk: "P2", changed: false, st: "problem" },
] as ConfirmBatch["items"];

const [req201, req204, c409, c501] = items as [ConfirmItem, ConfirmItem, ConfirmItem, ConfirmItem];

const view = (over: Partial<ConfirmBatchView> = {}): ConfirmBatchView => ({
  batch: {
    kind: "confirm-batch", batchId: "b-1", projectId: "p-1", title: "演示批",
    status: "draft", seed: "20261118", items, audit: [],
    createdBy: "u", createdAt: "2026-11-18T00:00:00Z", updatedAt: "2026-11-18T00:00:00Z",
  },
  sampledIds: ["C-501", "C-502"],
  sampleFingerprint: "ab12cd34",
  smallBatch: false,
  retroToFull: false,
  mustDone: false,
  effective: Object.fromEntries(items.map(item => [item.id, item.st])),
  stats: {
    diffForced: 1, inherited: 4, forceFull: 2, riskUnknown: 1,
    sampled: 2, sampledDone: 2, problems: 1, problemRate: "50%", mustRemaining: 2,
  },
  gates: [],
  approvalNote: "批准时必须附重放执行证据",
  ...over,
});

describe("confirm-gate model", () => {
  it("must-review = risk-forced ∪ diff, matching the server rule exactly", () => {
    expect(isMustItem(req201)).toBe(true);  // P0
    expect(isMustItem(req204)).toBe(false); // P1 未变
    expect(isMustItem(c409)).toBe(true);    // 未标风险按强制
    expect(isMustItem(c501)).toBe(false);   // P2 未变
    // 差异项即使 P2 也必审
    expect(isMustItem({ ...c501, changed: true })).toBe(true);
  });

  it("risk labels read out money/permission/unknown in plain words", () => {
    expect(RISK_LABEL.money).toBe("涉资字段");
    expect(RISK_LABEL.perm).toBe("权限变更");
    expect(RISK_LABEL.unknown).toBe("未标风险");
  });

  it("row accent: red for risk-forced, green for sampled, forced wins over sampled", () => {
    expect(rowAccent(req201, view())).toBe("force-row");     // P0 → 红
    expect(rowAccent(c409, view())).toBe("force-row");     // 未标风险 → 红
    expect(rowAccent(c501, view())).toBe("sampled-row");   // 抽中 → 绿
    expect(rowAccent(req204, view())).toBe("");              // 其他无条
  });

  it("displayStatus uses the server-computed effective status, not the raw one", () => {
    const v = view();
    expect(displayStatus(req201, v)).toBe("todo");
    // 退回全审期间：抽中项的「通过」按待审显示
    const retro = view({ retroToFull: true, effective: { ...v.effective, "C-501": "todo" } });
    expect(displayStatus(c501, retro)).toBe("todo");
    // 非抽中项不受退回影响
    expect(displayStatus(req204, retro)).toBe("inherit");
  });

  it("filters: must / sampled / todo / inherit match their labels", () => {
    const v = view();
    expect(filterItems(v, "must").map(item => item.id)).toEqual(["REQ-201", "C-409"]);
    expect(filterItems(v, "sampled").map(item => item.id)).toEqual(["C-501", "C-502"]);
    expect(filterItems(v, "todo").map(item => item.id)).toEqual(["REQ-201", "C-409"]);
    expect(filterItems(v, "inherit").map(item => item.id)).toEqual(["REQ-204"]);
    expect(filterItems(v, "all")).toHaveLength(5);
  });
});
