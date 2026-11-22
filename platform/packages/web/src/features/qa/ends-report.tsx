// A8：报告按端分节。把报告 Markdown 的二级/三级分节按涉及端归组展示
// （各端结论/未测范围/风险仍以报告原文为准，这里只做归组导航，不改写内容）。
// 未识别出端的分节归入「总体」；整份报告没有任何端信息时退化为普通渲染。
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { normalizeStageMarkdown, splitStageMarkdown, type MarkdownSection } from "./stage-markdown";
import { localizeGeneratedMarkdown } from "./stage-localization";

export type ReportEndGroup = { end: string; label: string; sections: MarkdownSection[] };

const END_PATTERNS: { end: string; label: string; pattern: RegExp }[] = [
  { end: "web", label: "Web 端", pattern: /web/i },
  { end: "api", label: "接口端", pattern: /接口|api/i },
  { end: "app", label: "App 端", pattern: /\bapp\b|安卓|android/i },
  { end: "miniprogram", label: "小程序端", pattern: /小程序|miniprogram/i },
  { end: "desktop", label: "桌面端", pattern: /桌面|desktop/i },
];

const sectionEnd = (section: MarkdownSection): string | null => {
  if (section.level === 0) return null;
  const heading = section.content.split(/\r?\n/, 1)[0] ?? "";
  return END_PATTERNS.find(item => item.pattern.test(heading))?.end ?? null;
};

/** 按文档出现顺序归组；同一端只出现一组，「总体」按原文位置插入。 */
export function reportEndSections(markdown: string): ReportEndGroup[] {
  const sections = splitStageMarkdown(localizeGeneratedMarkdown(normalizeStageMarkdown(markdown)));
  if (!sections.length) return [];
  const groups: ReportEndGroup[] = [];
  const groupOf = (end: string | null): ReportEndGroup => {
    const key = end ?? "overall";
    let group = groups.find(item => item.end === key);
    if (!group) {
      const found = END_PATTERNS.find(item => item.end === end);
      group = { end: key, label: key === "overall" ? "总体" : found?.label ?? key, sections: [] };
      groups.push(group);
    }
    return group;
  };
  for (const section of sections) groupOf(sectionEnd(section)).sections.push(section);
  return groups;
}

function MarkdownSections({ sections }: { sections: MarkdownSection[] }) {
  return <>{sections.map((section, index) => <div className={`qtd-ends-section qtd-ends-level-${section.level}`} key={index}><ReactMarkdown remarkPlugins={[remarkGfm]}>{section.content}</ReactMarkdown></div>)}</>;
}

export function EndsReportSection({ markdown, label }: { markdown: string; label: string }) {
  const groups = reportEndSections(markdown);
  if (groups.length <= 1 && (!groups[0] || groups[0].end === "overall")) return <article className="qtd-markdown" aria-label={label}><MarkdownSections sections={groups[0]?.sections ?? []}/></article>;
  return <article className="qtd-markdown qtd-ends-report" aria-label={label}>
    <nav className="qtd-ends-nav" aria-label="报告分端导航">{groups.map(group => <a key={group.end} href={`#qtd-end-${group.end}`}>{group.label}</a>)}</nav>
    {groups.map(group => <section className={`qtd-ends-group qtd-ends-group-${group.end}`} id={`qtd-end-${group.end}`} key={group.end} aria-label={group.label}>
      <h2 className="qtd-ends-title">{group.label}</h2>
      <MarkdownSections sections={group.sections}/>
    </section>)}
  </article>;
}
