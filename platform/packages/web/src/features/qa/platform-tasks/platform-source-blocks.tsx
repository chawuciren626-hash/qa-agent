/**
 * 平台真实资料板块：需求基准 / 研发自测摘要 / 节点变更记录。
 * 数据来自交接包同步（platform_task_links 的 *_digest_json 列），非 AI 产出，
 * 与"AI 分析结论"板块分开呈现（AI 建议 vs 平台事实）。
 */
import type { ReactNode } from "react";

import type { TaskDetail } from "./api";

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

function timeShort(value: unknown): string {
  const text = str(value);
  return text ? text.slice(0, 16).replace("T", " ") : "";
}

export function PlatformSourceBlocks({ task: t }: { task: TaskDetail["task"] }): ReactNode {
  const baseline = t.requirementBaseline;
  const selfTest = t.selfTestDigest;
  const changes = t.changesDigest ?? [];
  return (
    <>
      {baseline && str(baseline.final_content) && (
        <div className="qpt-sum-block">
          <h4>需求基准（研发处理判断确认版）{baseline.confirmed ? "" : " · 未确认"}</h4>
          <p className="qpt-reason">{str(baseline.final_content)}</p>
          {Array.isArray(baseline.acceptance_criteria) && baseline.acceptance_criteria.length > 0 && (
            <>
              <h4>验收口径</h4>
              <ul>{baseline.acceptance_criteria.map((item, i) => <li key={i}>{item}</li>)}</ul>
            </>
          )}
        </div>
      )}
      {baseline && str(baseline.original_content) && (
        <div className="qpt-sum-block"><h4>原始反馈</h4><p className="qpt-reason">{str(baseline.original_content)}</p></div>
      )}
      {selfTest && (str(selfTest.self_test_result) || str(selfTest.test_focus) || str(selfTest.known_risks)) && (
        <div className="qpt-sum-block">
          <h4>研发自测摘要{selfTest.reviewed_at ? ` · 审核通过 ${timeShort(selfTest.reviewed_at)}` : ""}</h4>
          {str(selfTest.self_test_result) && <p className="qpt-reason">{str(selfTest.self_test_result)}</p>}
          {str(selfTest.test_focus) && <p><b>验证重点：</b>{str(selfTest.test_focus)}</p>}
          {str(selfTest.known_risks) && <p className="qpt-risk"><b>研发已知风险：</b>{str(selfTest.known_risks)}</p>}
          {Array.isArray(selfTest.related_links) && selfTest.related_links.length > 0 && (
            <p className="qpt-mono">{selfTest.related_links.join(" · ")}</p>
          )}
        </div>
      )}
      {changes.length > 0 && (
        <div className="qpt-sum-block">
          <h4>节点变更记录（{changes.length} 条）</h4>
          <ul>
            {changes.slice(-15).map((c, i) => (
              <li key={i}>
                [{str(c.node) || str(c.node_code)}]{typeof c.batch === "number" ? ` 第${c.batch}批` : ""}
                {str(c.operator) ? ` · ${str(c.operator)}` : ""}
                {timeShort(c.changed_at) ? ` · ${timeShort(c.changed_at)}` : ""}
                {str(c.content) && <span>：{str(c.content)}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
      {!baseline && !selfTest && changes.length === 0 && (
        <p className="qpt-reason">（该任务由早期版本同步，未携带平台真实资料；重新同步后可见）</p>
      )}
    </>
  );
}
