import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { normalizeStageMarkdown } from "./stage-markdown";

export type ArtifactPreviewData = { name: string; text: string; kind: "markdown" | "json" | "html" | "csv" | "text"; url?: string; isolated?: boolean };

export function previewKind(name: string): ArtifactPreviewData["kind"] | null {
  const extension = name.split(".").at(-1)?.toLowerCase();
  if (extension === "md" || extension === "markdown") return "markdown";
  if (extension === "json") return "json";
  if (extension === "html" || extension === "htm") return "html";
  if (extension === "csv") return "csv";
  if (extension === "txt" || extension === "log") return "text";
  return null;
}

// Artifact files can contain secret handles. Preview only shows a redacted copy.
export function redactPreview(text: string) {
  return text.replace(/qa-secret:\/\/[^\s"'<>，。；）)\]}]+/gi, "[敏感引用已隐藏]");
}

function csvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = "", quoted = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (char === '"' && quoted && text[index + 1] === '"') { cell += '"'; index++; }
    else if (char === '"') quoted = !quoted;
    else if (char === "," && !quoted) { row.push(cell); cell = ""; }
    else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && text[index + 1] === "\n") index++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += char;
  }
  if (row.length || cell) { row.push(cell); rows.push(row); }
  return rows;
}

export function ArtifactPreview({ preview }: { preview: ArtifactPreviewData }) {
  const text = redactPreview(preview.text);
  if (preview.kind === "markdown") return <article className="qtd-markdown qtd-preview-content"><ReactMarkdown remarkPlugins={[remarkGfm]}>{normalizeStageMarkdown(text)}</ReactMarkdown></article>;
  if (preview.kind === "json") {
    try { return <pre className="qtd-preview-content qtd-json-formatted" aria-label="格式化 JSON">{JSON.stringify(JSON.parse(text), null, 2)}</pre>; }
    catch { return <pre className="qtd-preview-content" aria-label="JSON 原文">{text}</pre>; }
  }
  if (preview.kind === "html") {
    if (!preview.url) return <pre className="qtd-preview-content">{text}</pre>;
    return <iframe className="qtd-html-preview" title={`${preview.name} 文档预览`} sandbox={preview.isolated ? "allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads" : "allow-scripts"} referrerPolicy="no-referrer" src={preview.url}/>;
  }
  if (preview.kind === "csv") {
    const rows = csvRows(text);
    return <div className="qtd-preview-content qtd-table-wrap"><table><thead><tr>{(rows[0] ?? []).map((cell, index) => <th key={index}>{cell}</th>)}</tr></thead><tbody>{rows.slice(1).map((row, index) => <tr key={index}>{row.map((cell, column) => <td key={column}>{cell}</td>)}</tr>)}</tbody></table></div>;
  }
  return <pre className="qtd-preview-content">{text}</pre>;
}
