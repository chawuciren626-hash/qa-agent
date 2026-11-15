const reviewFields = new Set([
  "测试点", "优先级", "测试方法", "风险", "覆盖类型", "来源", "关联规则", "预期结果", "依据与规则", "待澄清问题", "限制",
  "运行", "执行状态", "结果来源", "未完成原因", "阶段结论", "执行限制", "未覆盖用例", "待核查操作",
  "结果", "预期", "实际结果", "断言", "证据模式", "结果待核查", "证据文件",
]);

/** Format old sealed review documents for display without changing their stored bytes. */
export function normalizeStageMarkdown(markdown: string): string {
  return markdown.split(/(```[\s\S]*?```|~~~[\s\S]*?~~~)/g).map(part => {
    if (/^(?:```|~~~)/.test(part)) return part;
    return part.replace(/^\*\*([^*\n]{1,30})\*\*[ \t]*\r?\n[ \t]*\r?\n([^\r\n]+)(?=\r?\n|$)/gm,
      (whole, label: string, value: string) => reviewFields.has(label) ? `**${label}：** ${value}` : whole);
  }).join("");
}

export type MarkdownSection = { content: string; level: 0 | 2 | 3 };

/** Split every second- and third-level heading into a distinct section across all stages. */
export function splitStageMarkdown(markdown: string): MarkdownSection[] {
  const sections: MarkdownSection[] = [];
  let lines: string[] = [];
  let level: 0 | 2 | 3 = 0;
  let fence = "";
  const flush = () => { if (lines.join("").trim()) sections.push({ content: lines.join(""), level }); lines = []; };
  for (const line of markdown.match(/.*(?:\r?\n|$)/g)?.filter(Boolean) ?? []) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) fence = fence ? (marker[0] === fence[0] && marker.length >= fence.length ? "" : fence) : marker;
    const heading = !fence ? /^\s{0,3}(#{2,3})\s+/.exec(line)?.[1]?.length : undefined;
    const boundary = heading === 2 || heading === 3;
    if (boundary) { flush(); level = heading as 2 | 3; }
    lines.push(line);
  }
  flush();
  return sections;
}
