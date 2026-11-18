/**
 * 确认卡点页（A3 三层卡点 + A4 报告审批；批次 5，按 2026-11-18 已确认原型落码）。
 *
 * 页面只渲染服务端派生视图（qa-confirm-gate.ts buildView），不在前端重算抽样名单——
 * 名单与指纹以服务端为准，前端重算会造出第二个真相源。
 *
 * 三层卡点纪律（v3 §23.2 第 5 条，评审 P2-2）：
 *   ① 差异聚焦 ② 抽样审核（seed+id 哈希可复现；问题率超阈退回全审）
 *   ③ 风险加权（P0/涉资/权限/未标 → 强制全审，不受 ①② 省略）
 * 审批硬闸：必审集处置完成 + 抽样未退回 + 执行证据（批准时附带，缺证据不批准）。
 */
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { toastError, toastSuccess } from "@prismshadow/penguin-ui";
import { useProject, projectDisplayName } from "../../state/project";
import {
  approveBatch, createBatch, getBatch, listBatches, rejectBatch, resampleBatch, reviewItem, submitBatch,
} from "./confirm-gate-api";
import {
  ACTION_LABEL, RISK_CLASS, RISK_LABEL, STATUS_CLASS, STATUS_LABEL,
  displayStatus, filterItems, isMustItem, rowAccent,
  type AuditEntry, type ConfirmBatch, type ConfirmBatchView, type ItemFilter,
} from "./confirm-gate-model";
import "./confirm-gate.css";

const FILTERS: [ItemFilter, string][] = [
  ["all", "全部"], ["must", "必审（差异+风险）"], ["sampled", "抽样名单"], ["todo", "待处理"], ["inherit", "已继承"],
];

const DEMO_ITEMS = [
  { id: "REQ-201", type: "需求", text: "登录失败 5 次锁定 10 分钟", risk: "P0", changed: true },
  { id: "REQ-202", type: "需求", text: "支持短信验证码登录", risk: "money", changed: true },
  { id: "REQ-203", type: "需求", text: "密码强度提示文案", risk: "P2", changed: true },
  { id: "REQ-204", type: "需求", text: "账号命名规则不变", risk: "P1", changed: false },
  { id: "C-409", type: "用例", text: "多端同时在线踢出策略", risk: "unknown", changed: false },
  ...Array.from({ length: 14 }, (_, i) => ({
    id: `C-5${String(i).padStart(2, "0")}`,
    type: "用例",
    text: `回归普通项 ${i + 1}`,
    risk: i % 3 === 0 ? "P1" : "P2",
    changed: false,
  })),
];

function timeText(at: string): string {
  return at.replace("T", " ").slice(0, 19);
}

function LayerCard({ num, tone, title, desc, chips }: {
  num: string; tone: "diff" | "sample" | "risk"; title: string; desc: string; chips: { cls: string; text: string }[];
}) {
  return (
    <section className={`cg-layer cg-layer-${tone}`}>
      <h3><span className="cg-layer-num">{num}</span>{title}</h3>
      <p>{desc}</p>
      <div className="cg-layer-chips">{chips.map(chip => <span key={chip.text} className={`cg-chip ${chip.cls}`}>{chip.text}</span>)}</div>
    </section>
  );
}

function AuditList({ audit }: { audit: AuditEntry[] }) {
  if (!audit.length) return <p className="cg-audit-empty">（暂无记录）</p>;
  return (
    <div className="cg-audit" aria-label="审计留痕">
      {audit.map(entry => (
        <div className="cg-audit-row" key={entry.seq}>
          <span className="cg-audit-seq">{entry.seq}</span>
          <span className={`cg-audit-act${entry.action === "approve_blocked" ? " is-blocked" : entry.action === "approved" ? " is-ok" : ""}`}>
            {ACTION_LABEL[entry.action]}
          </span>
          <span className="cg-audit-note">
            {entry.note ?? ""}{entry.gateFailures?.length ? `（${entry.gateFailures.map(failure => failure.gate).join("、")}）` : ""}
            {" "}
            <small>{timeText(entry.at)}</small>
          </span>
        </div>
      ))}
    </div>
  );
}

function CreatePanel({ projectId, onCreated }: { projectId: string; onCreated: (batch: ConfirmBatch) => void }) {
  const [title, setTitle] = useState("登录模块改版确认");
  const [seed, setSeed] = useState("20261118");
  const [busy, setBusy] = useState(false);
  const create = async () => {
    setBusy(true);
    try {
      onCreated(await createBatch(projectId, { title, seed: seed || undefined, items: DEMO_ITEMS }));
      toastSuccess("确认批次已创建");
    } catch (error) {
      toastError(error instanceof Error ? error.message : "创建失败");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="cg-create" aria-label="创建确认批次">
      <p>
        确认项由生成管线（需求 → 测试点 → 用例）产出后登记成批；接管线前，可先建演示批体验三层卡点。
        演示批含 19 项：风险强制 3、差异强制 3、普通项 14（够抽样门槛）。
      </p>
      <label>批次标题 <input value={title} onChange={event => setTitle(event.target.value)} maxLength={200} /></label>
      <label>抽样种子 <input value={seed} onChange={event => setSeed(event.target.value)} maxLength={64} /></label>
      <button type="button" className="qpm-btn-main" disabled={busy || !title.trim()} onClick={() => void create()}>创建演示批次</button>
    </section>
  );
}

function EvidenceDialog({ onConfirm, onClose, busy }: {
  onConfirm: (evidence: unknown, note?: string) => void; onClose: () => void; busy: boolean;
}) {
  const [text, setText] = useState(JSON.stringify({
    replay: { status: "completed", per_case: [{ case_id: "C-1", verdict: "stable_passed" }] },
  }, null, 2));
  const [note, setNote] = useState("");
  const confirm = () => {
    try {
      onConfirm(JSON.parse(text), note.trim() || undefined);
    } catch {
      toastError("执行证据不是合法 JSON");
    }
  };
  return (
    <div className="cg-modal-backdrop" role="dialog" aria-modal="true" aria-label="附执行证据批准">
      <div className="cg-modal">
        <h2>批准：附重放执行证据</h2>
        <p className="cg-modal-hint">
          缺证据不批准。证据取自任务的 execution/replay-comparison：status 必须 completed，per_case 无 unstable / not_run。
        </p>
        <textarea value={text} onChange={event => setText(event.target.value)} rows={10} spellCheck={false} />
        <label className="cg-modal-note">备注（可选）<input value={note} onChange={event => setNote(event.target.value)} maxLength={200} /></label>
        <div className="cg-modal-actions">
          <button type="button" className="qpm-btn-ghost" onClick={onClose} disabled={busy}>取消</button>
          <button type="button" className="qpm-btn-main" onClick={confirm} disabled={busy}>确认批准</button>
        </div>
      </div>
    </div>
  );
}

function Workbench({ projectId, view, onChange }: {
  projectId: string; view: ConfirmBatchView; onChange: (next: ConfirmBatchView) => void;
}) {
  const [filter, setFilter] = useState<ItemFilter>("all");
  const [busy, setBusy] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const [seedDraft, setSeedDraft] = useState(view.batch.seed);
  const batch = view.batch;
  const locked = batch.status === "approved";

  const act = useCallback(async (fn: () => Promise<ConfirmBatchView>, success?: string) => {
    setBusy(true);
    try {
      onChange(await fn());
      if (success) toastSuccess(success);
    } catch (error) {
      toastError(error instanceof Error ? error.message : "操作失败");
    } finally {
      setBusy(false);
    }
  }, [onChange]);

  const rows = filterItems(view, filter);
  const { stats } = view;

  return (
    <div className="cg-workbench">
      <header className="cg-head">
        <div>
          <h1>确认卡点 · {batch.title}</h1>
          <p>
            状态 <b>{batch.status}</b> · 种子 <code>{batch.seed}</code> · 名单指纹 <code>{view.sampleFingerprint}</code>
            {view.smallBatch ? " · 普通项不足 10 条：本批升级全审" : ""}
          </p>
        </div>
      </header>

      {view.retroToFull && (
        <div className="cg-retro" role="alert">
          ⚠️ 抽样问题率 {stats.problemRate} 超过阈值 10% —— 本批<b>退回全审</b>：
          普通项的「抽样通过」全部作废（按待审显示），需逐条人工审完才能送审。
        </div>
      )}

      <div className="cg-layers">
        <LayerCard num="1" tone="diff" title="差异聚焦"
          desc="只强制审「与上一版不同」的部分，未变的默认继承；没有上一版时全部按新增审。"
          chips={[{ cls: "cg-chip-blue", text: `差异强制 ${stats.diffForced}` }, { cls: "cg-chip-grey", text: `未变继承 ${stats.inherited}` }]} />
        <LayerCard num="2" tone="sample" title="抽样审核"
          desc="每批随机 10% 深审（seed + id 哈希，同种子名单可复现）；问题率超阈值退回全审。"
          chips={view.smallBatch
            ? [{ cls: "cg-chip-amber", text: "池不足 → 升级全审" }]
            : [
              { cls: "cg-chip-green", text: `抽中 ${stats.sampled}` },
              { cls: "cg-chip-grey", text: `已深审 ${stats.sampledDone}/${stats.sampled}` },
              ...(stats.problems ? [{ cls: "cg-chip-red", text: `问题 ${stats.problems}` }] : []),
            ]} />
        <LayerCard num="3" tone="risk" title="风险加权"
          desc="P0 / 涉资字段 / 权限变更 → 强制全审；未标风险按强制处理，不受 ①② 省略。"
          chips={[{ cls: "cg-chip-red", text: `强制全审 ${stats.forceFull}` }, { cls: "cg-chip-amber", text: `未标风险 ${stats.riskUnknown}` }]} />
      </div>

      <div className="cg-sample-panel">
        <span className="cg-sample-lbl">抽样</span>
        <label>种子 <input value={seedDraft} onChange={event => setSeedDraft(event.target.value)} maxLength={64} disabled={locked || busy} /></label>
        <button type="button" className="qpm-btn-ghost" disabled={locked || busy || !seedDraft.trim() || seedDraft === batch.seed}
          onClick={() => void act(async () => await resampleBatch(projectId, batch.batchId, seedDraft.trim()), "已按新种子重抽")}>
          按此种子重抽
        </button>
        <span className="cg-sample-meta">
          抽样率 10% · 名单指纹 <code>{view.sampleFingerprint}</code>（同种子重抽一致） · 问题率 {stats.problemRate ?? "—"} / 阈值 10%
        </span>
      </div>

      <div className="cg-toolbar">
        <h2>确认项（必审未处置 {stats.mustRemaining}）</h2>
        {FILTERS.map(([value, label]) => (
          <button key={value} type="button" className={`cg-fbtn${filter === value ? " is-on" : ""}`} aria-pressed={filter === value}
            onClick={() => setFilter(value)}>{label}</button>
        ))}
        <span className="cg-toolbar-hint">左条：红 = 风险强制 · 绿 = 抽中深审</span>
      </div>

      <div className="cg-table-wrap">
        <table className="cg-table">
          <thead>
            <tr><th>编号</th><th>类型</th><th>内容</th><th>风险</th><th>与上版</th><th>状态</th><th>处置</th></tr>
          </thead>
          <tbody>
            {rows.map(item => {
              const status = displayStatus(item, view);
              const accent = rowAccent(item, view);
              return (
                <tr key={item.id} className={accent || (item.st === "inherit" ? "is-inherit" : "")}>
                  <td><code>{item.id}</code></td>
                  <td>{item.type}</td>
                  <td>{item.text}</td>
                  <td><span className={`cg-risk ${RISK_CLASS[item.risk]}`}>{RISK_LABEL[item.risk]}</span></td>
                  <td><i className={`cg-dot ${item.changed ? "is-changed" : "is-same"}`} />{item.changed ? "有差异" : "与上版一致"}</td>
                  <td><span className={`cg-st ${STATUS_CLASS[status]}`}>{STATUS_LABEL[status]}</span></td>
                  <td>
                    {locked ? <span className="cg-done-note">已批准</span>
                      : status === "todo"
                        ? <>
                          <button type="button" className="cg-mini is-ok" disabled={busy}
                            onClick={() => void act(() => reviewItem(projectId, batch.batchId, item.id, "pass"))}>通过</button>
                          <button type="button" className="cg-mini is-bad" disabled={busy}
                            onClick={() => void act(() => reviewItem(projectId, batch.batchId, item.id, "problem"))}>问题</button>
                        </>
                        : <span className="cg-done-note">已处置{isMustItem(item) ? "（必审）" : ""}</span>}
                  </td>
                </tr>
              );
            })}
            {!rows.length && <tr><td colSpan={7} className="cg-empty-row">当前筛选范围暂无确认项。</td></tr>}
          </tbody>
        </table>
      </div>

      <section className="cg-approval" aria-label="报告审批">
        <div className="cg-approval-head">
          <h2>回归报告审批</h2>
          <div className="cg-flow">
            {(["draft", "reviewing", "approved"] as const).map((status, index) => (
              <span key={status} className="cg-flow-wrap">
                {index > 0 && <span className="cg-flow-arrow">→</span>}
                <span className={`cg-flow-node${batch.status === status ? " is-cur" : ""}${status === "draft" && batch.status !== "draft" ? " is-block" : ""}`}>
                  {status}
                </span>
              </span>
            ))}
          </div>
        </div>
        <div className="cg-approval-body">
          <div className="cg-gates">
            <h4>确认侧硬闸（批准前必须全过）</h4>
            {view.gates.length
              ? view.gates.map(gate => (
                <div className="cg-gate-row" key={gate.gate}>
                  <span className="cg-gate-ic is-fail">✗</span>
                  <b>{gate.gate}</b>
                  <span className="cg-gate-detail">{gate.detail}</span>
                </div>
              ))
              : (
                <div className="cg-gate-row"><span className="cg-gate-ic is-pass">✓</span><b>confirm_done</b>
                  <span className="cg-gate-detail">必审集已全部处置，抽样未退回全审。</span></div>
              )}
            <p className="cg-approval-note">{view.approvalNote}</p>
          </div>
          <div className="cg-audit-col">
            <h4>审计留痕（append-only · seq 连续）</h4>
            <AuditList audit={batch.audit} />
          </div>
        </div>
        {rejectOpen && (
          <div className="cg-reject-bar">
            <input value={rejectReason} onChange={event => setRejectReason(event.target.value)} placeholder="退回原因（必填）" maxLength={200} />
            <button type="button" className="qpm-btn-ghost" onClick={() => setRejectOpen(false)} disabled={busy}>取消</button>
            <button type="button" className="qpm-btn-main" disabled={busy || !rejectReason.trim()}
              onClick={() => { void act(async () => await rejectBatch(projectId, batch.batchId, rejectReason.trim()), "已退回修改"); setRejectOpen(false); setRejectReason(""); }}>
              确认退回
            </button>
          </div>
        )}
        <div className="cg-approval-foot">
          <button type="button" className="qpm-btn-main" disabled={locked || busy || batch.status !== "draft" || !view.mustDone || view.retroToFull}
            onClick={() => void act(() => submitBatch(projectId, batch.batchId), "已提交送审")}>提交送审</button>
          <button type="button" className="qpm-btn-ghost is-approve" disabled={locked || busy || batch.status !== "reviewing"}
            onClick={() => setEvidenceOpen(true)}>批准…</button>
          <button type="button" className="qpm-btn-ghost is-reject" disabled={locked || busy || batch.status !== "reviewing"}
            onClick={() => setRejectOpen(true)}>退回修改</button>
          <span className="cg-foot-msg">
            {batch.status === "draft" && (!view.mustDone || view.retroToFull) && "必审集未完成或抽样退回全审中，暂不能送审。"}
            {batch.status === "draft" && view.mustDone && !view.retroToFull && "必审集已全部处置，可提交送审。"}
            {batch.status === "reviewing" && "送审中。批准需附执行证据，硬闸失败会记 approve_blocked。"}
            {batch.status === "approved" && "已批准。审计留痕可导出。"}
          </span>
        </div>
      </section>

      {evidenceOpen && (
        <EvidenceDialog busy={busy} onClose={() => setEvidenceOpen(false)}
          onConfirm={(evidence, note) => {
            void act(async () => await approveBatch(projectId, batch.batchId, evidence, note));
            setEvidenceOpen(false);
          }} />
      )}
    </div>
  );
}

export function ConfirmGatePage() {
  const { currentProject } = useProject();
  const navigate = useNavigate();
  const projectId = currentProject?.projectId;
  const [batches, setBatches] = useState<ConfirmBatch[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [view, setView] = useState<ConfirmBatchView | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    (async () => {
      try {
        const list = await listBatches(projectId);
        if (cancelled) return;
        setBatches(list);
        setError("");
      } catch (loadError) {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : "加载确认批次失败");
      }
    })();
    return () => { cancelled = true; };
  }, [projectId]);

  useEffect(() => {
    if (!projectId || !selected) { setView(null); return; }
    let cancelled = false;
    (async () => {
      try {
        const next = await getBatch(projectId, selected);
        if (!cancelled) { setView(next); setError(""); }
      } catch (loadError) {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : "加载批次详情失败");
      }
    })();
    return () => { cancelled = true; };
  }, [projectId, selected]);

  if (!projectId) {
    return (
      <main className="qpm-page" aria-label="确认卡点">
        <div className="qpm-scroll">
          <div className="qpm-empty">
            <h2 className="qpm-empty-title">确认卡点在项目内</h2>
            <p className="qpm-empty-sub">确认批次按项目隔离，先进一个项目再看这里。</p>
            <button type="button" className="qpm-btn-main" onClick={() => navigate("/qa/projects")}>去项目管理</button>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="qpm-page cg-page" aria-label="确认卡点">
      <div className="qpm-scroll">
        <header className="qpm-head">
          <div>
            <h1>确认卡点</h1>
            <p>{projectDisplayName(currentProject)} · 三层卡点（差异聚焦 / 抽样审核 / 风险加权）+ 报告审批留痕</p>
          </div>
        </header>
        {error && <div className="qpm-error" role="alert"><p>{error}</p></div>}

        {batches && batches.length > 0 && (
          <div className="cg-batch-list" aria-label="确认批次列表">
            {batches.map(batch => (
              <button key={batch.batchId} type="button" className={`cg-batch-card${selected === batch.batchId ? " is-on" : ""}`}
                aria-label={`打开批次 ${batch.title}`} aria-pressed={selected === batch.batchId} onClick={() => setSelected(batch.batchId)}>
                <b>{batch.title}</b>
                <span>{batch.status} · {batch.items.length} 项 · 种子 {batch.seed}</span>
              </button>
            ))}
          </div>
        )}

        {view && <Workbench projectId={projectId} view={view} onChange={setView} />}

        {!view && (
          <CreatePanel projectId={projectId}
            onCreated={batch => { setBatches(current => [batch, ...(current ?? [])]); setSelected(batch.batchId); }} />
        )}
      </div>
    </main>
  );
}
