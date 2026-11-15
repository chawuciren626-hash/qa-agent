// @vitest-environment jsdom
import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { ArtifactPreview, previewKind, redactPreview } from "../src/features/qa/artifact-preview";

it("renders markdown, formatted JSON and a sandboxed HTML report", () => {
  expect(previewKind("test_brief.md")).toBe("markdown");
  expect(renderToStaticMarkup(createElement(ArtifactPreview,{preview:{name:"brief.md",kind:"markdown",text:"# 标题\n\n**结论**"}}))).toContain("<h1>标题</h1>");
  const table=renderToStaticMarkup(createElement(ArtifactPreview,{preview:{name:"report.md",kind:"markdown",text:"| 状态 | 数量 |\n| --- | --- |\n| passed | 5 |"}}));
  expect(table).toContain("<table>");
  expect(table).toContain("<td>passed</td>");
  const json=renderToStaticMarkup(createElement(ArtifactPreview,{preview:{name:"ledger.json",kind:"json",text:'{"rules":[{"id":"R1"}]}'}}));
  expect(json).toContain("qtd-json-formatted");
  expect(json).toContain("\n  &quot;rules&quot;");
  expect(json).toContain("R1");
  const html=renderToStaticMarkup(createElement(ArtifactPreview,{preview:{name:"report.html",kind:"html",text:"",url:"/api/sessions/s1/files/preview-redirect?path=report%2Ftest_report.html",isolated:true}}));
  expect(html).toContain('sandbox="allow-scripts allow-same-origin');
  expect(html).toContain("preview-redirect");
  expect(html).toContain("<iframe");
  const fallback=renderToStaticMarkup(createElement(ArtifactPreview,{preview:{name:"report.html",kind:"html",text:"",url:"/preview",isolated:false}}));
  expect(fallback).toContain('sandbox="allow-scripts"');
});

it("hides secret handles in every text preview", () => {
  expect(redactPreview('"password":"qa-secret://session-a/123"')).toBe('"password":"[敏感引用已隐藏]"');
});
