/**
 * 本轮对话的上下文装配账目：模型实际看到了什么、被裁掉了什么、每一条为什么被裁。
 *
 * 这张卡存在的意义是让"预算生效"可被核对。如果只显示"已装配 5240 tokens"，那和
 * "把资料整篇塞进去再报个数字"没有区别；必须能看到被裁项和原因，才能判断这一轮
 * 的结论是不是建立在缺资料的基础上。
 */
import { useEffect, useState } from "react";
import { apiFetch } from "../../api/client";
import {
  assemblerLabel,
  dropReasonLabel,
  ledgerRefLabel,
  type ContextLedgerView,
} from "./project-knowledge-model";

type CardState = "loading" | "ready" | "empty" | "error";

export function ContextLedgerCard({ projectId, sessionId }: { projectId: string; sessionId: string }) {
  const [ledger, setLedger] = useState<ContextLedgerView | null>(null);
  const [cardState, setCardState] = useState<CardState>("loading");
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    setLedger(null);
    setCardState("loading");
    setError("");
    if (!projectId || !sessionId) {
      setCardState("empty");
      return;
    }
    void apiFetch<{ ledger: ContextLedgerView | null }>(
      `/api/projects/${encodeURIComponent(projectId)}/agents/qa/tasks/${encodeURIComponent(sessionId)}/context-ledger`,
    )
      .then((answer) => {
        if (!active) return;
        setLedger(answer.ledger ?? null);
        setCardState(answer.ledger ? "ready" : "empty");
      })
      .catch((cause: unknown) => {
        if (!active) return;
        setError(cause instanceof Error ? cause.message : "读取装配账目失败");
        setCardState("error");
      });
    return () => {
      active = false;
    };
  }, [projectId, sessionId]);

  if (cardState === "loading") {
    return <p className="qtd-ledger-empty">正在读取本次装配账目…</p>;
  }
  if (cardState === "error") {
    return (
      <p className="qtd-ledger-empty qtd-ledger-error" role="alert">
        装配账目读不到：{error}。这不代表没有裁剪，只代表这次查不到记录。
      </p>
    );
  }
  if (cardState === "empty" || ledger === null) {
    return (
      <p className="qtd-ledger-empty">
        本次任务还没有上下文装配记录。任务开始派单后，这里会列出装入的知识、资料与被裁项。
      </p>
    );
  }

  const degraded = ledger.assembler.startsWith("fallback");
  const ratio = ledger.budgetTokens > 0 ? Math.min(100, Math.round((ledger.tokensEst / ledger.budgetTokens) * 100)) : 0;

  return (
    <details className="qtd-ledger" open={degraded || ledger.dropped.length > 0 ? undefined : false}>
      <summary>
        <span className="qtd-ledger-title">本次装配账目</span>
        <span className="qtd-ledger-statement">{ledger.statement}</span>
        {ledger.dropped.length > 0 && (
          <span className="qtd-ledger-badge qtd-ledger-badge-warn">裁掉 {ledger.dropped.length} 项</span>
        )}
        {degraded && <span className="qtd-ledger-badge qtd-ledger-badge-bad">降级装配</span>}
      </summary>

      <div className="qtd-ledger-body">
        <div className="qtd-ledger-budget">
          <span>{ledger.tokensEst} / {ledger.budgetTokens} tokens</span>
          <span className="qtd-ledger-bar" aria-hidden="true">
            <span className="qtd-ledger-bar-fill" style={{ width: `${ratio}%` }} />
          </span>
          <span className="qtd-ledger-assembler">{assemblerLabel(ledger.assembler)}</span>
        </div>

        <div className="qtd-ledger-stats">
          <span>知识 {ledger.loaded.knowledge.loaded}/{ledger.loaded.knowledge.total} 条</span>
          <span>资料 {ledger.loaded.documents} 篇</span>
          <span>正式规则 {ledger.loaded.rules} 条</span>
          <span>知识版本 {ledger.loaded.knowledge.version ?? "未指定"}</span>
        </div>

        {degraded && (
          <p className="qtd-ledger-note qtd-ledger-error">
            装配器不可用时只给索引、正文一个字都不进。这一轮的结论不能当成"已核对资料"的结论。
          </p>
        )}

        {ledger.dropped.length === 0 ? (
          <p className="qtd-ledger-note">没有内容被裁掉：本轮装下的就是全部范围内的知识。</p>
        ) : (
          <div className="qtd-ledger-table-wrap">
            <table className="qtd-ledger-table">
              <thead>
                <tr>
                  <th>类型</th>
                  <th>被裁条目</th>
                  <th>量级</th>
                  <th>原因</th>
                </tr>
              </thead>
              <tbody>
                {ledger.dropped.map((entry, index) => (
                  <tr key={`${entry.kind}-${index}`}>
                    <td>{entry.kind}</td>
                    <td className="qtd-ledger-ref">{ledgerRefLabel(entry.ref)}</td>
                    <td>{entry.tokens} tokens</td>
                    <td>{dropReasonLabel(entry.reason)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </details>
  );
}
