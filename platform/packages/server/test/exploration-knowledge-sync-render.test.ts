import { describe, expect, it } from "vitest";
import { renderReversePrd, type ExplorationKnowledgeSyncInput } from "../src/services/exploration-knowledge-sync.js";

// 纯渲染测试：不启动平台、不碰数据库——渲染器是确定性字符串拼装，行号与标注
// 错一个字段，下游知识构建的"原文位置"就会变成假证据。

const baseInput: ExplorationKnowledgeSyncInput = {
  projectId: "p1",
  env: "test",
  round: 2,
  targetUrl: "https://www.saucedemo.com/",
  layers: [
    {
      layer: "module",
      entries: [
        { key: "/", summary: "已渲染 · 3 控件" },
        { key: "/inventory.html", summary: "已渲染 · 12 控件" },
      ],
    },
    {
      layer: "interface",
      entries: [{ key: "POST /api/unique-events/submit", summary: "模块 default" }],
    },
    {
      layer: "wall",
      entries: [{ key: "login-required", summary: "业务页需登录：未登录访问会被重定向到登录页" }],
    },
  ],
  evidence: {
    observations: [
      { id: "obs-1", page: "/inventory.html", kind: "price", verbatim: "$29.99", context: "Sauce Labs Backpack", verification: "verified" },
      { id: "obs-2", page: "/inventory.html", kind: "field_label", verbatim: "Username", verification: "verified" },
      { id: "obs-3", page: "/", kind: "option_list", verbatim: "Name (A to Z) | Name (Z to A)", verification: "verified" },
    ],
    rules: [
      { id: "rule-1", statement: "「Sauce Labs Backpack」定价 $29.99（当前版本实测）", verification: "verified", evidence_ids: ["obs-1"] },
      { id: "rule-2", statement: "未确认的规则", verification: "tbd", evidence_ids: [] },
    ],
  },
  openHypotheses: [
    { statement: "登录会话可访问的页面与可执行操作范围未确认", expectation: "以当前会话遍历已发现路由" },
  ],
  limitations: ["登录成功只证明本次凭据被接受，不证明权限范围或业务可用。"],
};

describe("renderSnapshot", () => {
  it("snapshot items keep line refs aligned when hypotheses append after facts", async () => {
    const { renderSnapshot } = await import("../src/services/exploration-knowledge-sync.js");
    const { content, items } = renderSnapshot(baseInput, "doc-explore-test");
    const lines = content.split("\n");
    for (const item of items) {
      const line = lines[(item.source as { line: number }).line - 1] ?? "";
      expect(line.startsWith("- ")).toBe(true);
      expect(line).toContain(String(item.name));
    }
    // 假设只追加展示，不产生知识项
    expect(content).toContain("## 待验证假设");
    expect(content).toContain("[tbd] 登录会话可访问的页面与可执行操作范围未确认");
    expect(items.every((item) => !String(item.statement).includes("可执行操作范围未确认"))).toBe(true);
  });
});

describe("renderReversePrd", () => {
  it("renders all sections with verification labels and keeps inference out", () => {
    const prd = renderReversePrd(baseInput, "doc-reverse-prd-test");
    expect(prd).toContain("# 逆向需求文档（环境 test）");
    expect(prd).toContain("round-2");
    expect(prd).toContain("## 一、页面与功能");
    expect(prd).toContain("- `/inventory.html`：已渲染 · 12 控件 [verified]");
    expect(prd).toContain("## 二、接口");
    expect(prd).toContain("## 三、访问墙");
    expect(prd).toContain("## 四、业务规则");
    expect(prd).toContain("- 「Sauce Labs Backpack」定价 $29.99（当前版本实测） [verified]（证据：obs-1）");
    expect(prd).toContain("## 五、数据字段与选项");
    expect(prd).toContain("- 价格 $29.99（Sauce Labs Backpack） [verified]");
    expect(prd).toContain("- `/inventory.html` 字段：Username [verified]");
    expect(prd).toContain("- `/` 选项：Name (A to Z) | Name (Z to A) [verified]");
    expect(prd).toContain("## 六、待确认未知");
    expect(prd).toContain("- [tbd] 登录会话可访问的页面与可执行操作范围未确认");
    expect(prd).toContain("## 七、来源与局限");
    expect(prd).toContain("- 登录成功只证明本次凭据被接受");
    // 未确认的规则（tbd）不得以"业务规则"身份出现在第四节
    expect(prd).not.toContain("未确认的规则");
  });

  it("empty input renders honest placeholders instead of fabricated facts", () => {
    const prd = renderReversePrd(
      { ...baseInput, layers: [], evidence: null, openHypotheses: [], limitations: [] },
      "doc-reverse-prd-test",
    );
    expect(prd).toContain("- （本轮没有采集到页面事实）");
    expect(prd).toContain("- （未发现接口清单；可通过读流量或 OpenAPI 导入补充）");
    expect(prd).toContain("- （暂无；规则需绑定业务对象上下文且经所有者确认，见知识候选）");
    expect(prd).toContain("- （本轮未提取到语义字段）");
    expect(prd).toContain("- （当前无 open 假设）");
    expect(prd).toContain("- （探索回执未声明局限）");
    // 图例行之外不允许任何 [verified] 列表项——空态不编造事实
    const verifiedItems = (prd.match(/^- .*\[verified\]/gm) ?? [])
      .filter((line) => !line.startsWith("- 验证等级标注"));
    expect(verifiedItems).toEqual([]);
  });
});
