/** Chinese labels for bundled skills; the original name remains the invocation identifier. */
const builtinNames: Record<string, string> = {
  "test-point-design": "测试点设计", "requirement-analysis": "需求分析",
  "test-asset-management": "测试资产管理", "qa-investigation": "失败根因调查",
  "test-case-writing": "测试用例编写", "test-design-methods": "测试设计方法",
  "test-selection": "智能测试选择", "miniprogram-execution": "小程序自动化执行",
  "api-contract-analysis": "接口契约分析", "bug-reporting": "缺陷记录",
  "playwright-execution": "网页自动化执行", "api-test-execution": "接口测试执行",
  "test-report-writing": "测试报告生成", "api-testing": "接口测试", "android-execution": "安卓自动化执行",
  firecrawl: "网络搜索与抓取", "remote-claude-code": "远程代码助手", "bento-slides": "幻灯片制作",
  "web-design": "网页设计", "software-engineering": "软件工程", "skill-porting": "技能移植",
  "plugin-porting": "插件移植", "penguin-support": "产品支持", "opro-rsi-toolkit": "指令评分优化",
  vllm: "高性能模型部署", ollama: "本地模型运行", llamafactory: "模型微调",
  humanizer: "自然语言润色", "agent-optimization": "智能体优化", "data-analysis": "数据分析",
  "browser-automation": "浏览器自动化", "awm-rsi-toolkit": "工作流归纳", "ape-rsi-toolkit": "示例指令归纳",
  "benchmark-design": "评测基准设计", "agent-evaluation": "智能体评测", "unified-llm-api": "统一模型接口",
  "penguin-sdk": "智能体开发工具", "penguin-plugin": "智能体插件工作台", "penguin-orchestration": "智能体编排",
  "penguin-config": "运行配置管理", "agent-initialization": "智能体初始化", "company-setup": "组织创建",
  "company-research": "组织科研", "company-mirror": "组织数字镜像", "company-hr": "组织人事管理",
  "company-finance": "组织财务管理", "company-employee": "组织员工协作", "company-ceo": "组织经营管理",
  "ace-rsi-toolkit": "经验规则进化", a2ui: "交互式内容展示",
};

// Read only display strings from SKILL.md. This does not execute or alter skill instructions.
function metadataText(frontmatter: string, key: string): string {
  const match = frontmatter.match(new RegExp(`^${key}:[ \\t]*(.*)$`, "m"));
  if (!match) return "";
  const raw = match[1]!.trim();
  if (/^[>|][+-]?$/.test(raw)) {
    return frontmatter.slice(match.index! + match[0].length).match(/^(?:\n(?:[ \t]+[^\n]*|[ \t]*))*/)?.[0].trim().replace(/\s+/g, " ") ?? "";
  }
  if (raw.startsWith('"')) { try { const value: unknown = JSON.parse(raw); return typeof value === "string" ? value : ""; } catch { return ""; } }
  if (raw.startsWith("'") && raw.endsWith("'")) return raw.slice(1, -1).replace(/''/g, "'");
  return raw.replace(/\s+#.*$/, "").trim();
}

export function skillPresentation(skill: {
  name: string; description?: string; content?: string; displayName?: string;
  shortDescriptionZh?: string; shortDescription?: string;
}): { displayName: string; summary: string } {
  const content = (skill.content ?? "").replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  const frontmatter = content.match(/^---\n([\s\S]*?)\n---(?:\n|$)/)?.[1] ?? "";
  const body = content.replace(/^---\n[\s\S]*?\n---(?:\n|$)/, "");
  const heading = body.match(/^#\s+(.+)$/m)?.[1]?.replace(/\s+Skill\s*$/i, "").trim();
  const displayName = skill.displayName?.trim() || metadataText(frontmatter, "display_name_zh") || metadataText(frontmatter, "name_zh")
    || (heading && /[\u3400-\u9fff]/.test(heading) ? heading : builtinNames[skill.name]) || skill.name;
  const description = skill.description?.trim() ?? "";
  const isPlaceholder = /^AITestHarness\s+内置测试技能\s*[·•]/.test(description);
  // Administrator edits take precedence over older short descriptions embedded in imported files.
  const summary = (!isPlaceholder && /[\u3400-\u9fff]/.test(description) ? description : "")
    || skill.shortDescriptionZh?.trim() || metadataText(frontmatter, "short_description_zh")
    || metadataText(frontmatter, "description") || skill.shortDescription?.trim()
    || (!isPlaceholder ? description : "") || "暂无技能简介";
  return { displayName, summary };
}
