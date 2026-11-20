/**
 * 运行痕迹卡（P4 判据 1/4 前端落地，原型 `prototype/run-trace-stalled-prototype.html` 已确认）。
 *
 * 数据来自 GET /qa/task-records/:sessionId/runs/:runId/trace（读模型见 server `qa-run-trace.ts`）。
 * 展示原则与后端口径一致：
 *  - `registered:false` 而 `trace.present:true` 是**有价值的不一致**，如实呈现、不替它补登记；
 *  - `stalled` 用最后一次活动判（长跑不误报），锁在而持锁进程已退出时不看阈值直接判疑似中断；
 *  - dispatch 在而 `startedAt` 空 = 发起了但执行器从没开始——这是此前完全不可见的一种失败；
 *  - 本卡只读：不提供"重新发起 / 标记已处置"按钮（真实端点尚不存在，不放假按钮）。
 */
import { useEffect, useState } from "react";
import { apiFetch, ApiError } from "../../api/client";

type ExecutionTrace = {
  invocationId: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  phase: string | null;
  state: string | null;
  lastActivityAt: string | null;
  attempts: number;
  locked: boolean;
  orphaned: boolean;
  pidStatus: "alive" | "dead" | "unknown";
  blockReason: string | null;
};
type DispatchTrace = { dispatchedAt: string | null; sessionId: string | null; host: string | null; ownerPid: number | null };
type TraceView = {
  runId: string;
  present: boolean;
  manifest: { status: string; manifestVersion: number | null; baselineHash: string | null; sha256: string } | null;
  execution: ExecutionTrace;
  dispatch: DispatchTrace | null;
  startedAt: string | null;
  stalled: boolean;
  stalledReason: string | null;
  staleAfterMs: number;
};
type TraceResponse = { registered: boolean; trace: TraceView };

type TimelineNode = { cls: "done" | "now" | "bad" | ""; t: string; b: string; s: string };
type Fact = { k: string; v: string; tip?: string };
type Scene = { kind: "red" | "amber" | "blue" | null; icon: string; html?: string; summary: string; tone: "bad" | "warn" | "run" | "done" | "unknown" };

const fmtTime = (value: string | null) => {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}:${String(date.getSeconds()).padStart(2, "0")}`;
};
const shortSha = (sha: string) => sha.length > 12 ? `${sha.slice(0, 4)}…${sha.slice(-4)}` : sha;
const minutes = (ms: number) => Math.round(ms / 60000);

function sceneOf(data: TraceResponse, now: number): Scene {
  const { registered, trace } = data;
  const ex = trace.execution;
  if (!registered && trace.present) return {
    kind: "amber", icon: "?", tone: "warn",
    summary: "目录有执行痕迹，平台没有登记行",
    html: `<b>这是一处有价值的不一致</b>：工作区里有这次运行的目录与执行痕迹，qa_runs 里没有对应行——它说明这次执行绕过了所有服务端写入就开跑了（或登记那一步失败了）。平台<b>不会替它补一行</b>：补上就把「曾经没登记」这个事实抹掉了。要不要补登记、还是直接重跑，由人决定。`
  };
  if (trace.dispatch?.dispatchedAt && !ex.startedAt && !ex.finishedAt && ex.attempts === 0) return {
    kind: "red", icon: "!", tone: "bad",
    summary: "已发起，但执行器从未开始",
    html: `<b>发起方的证据在（dispatch.json），执行痕迹全空</b>：命令被调用过（${fmtTime(trace.dispatch.dispatchedAt)}），但执行器从未写锁、也没写过状态——执行器没起来，或起来就退了。这在以前和「从没发起」长得一模一样。请检查执行环境与发起命令，再重新发起（新 run_id）。`
  };
  if (trace.stalled) return ex.orphaned ? {
    kind: "red", icon: "!", tone: "bad",
    summary: "疑似中断：锁未释放且持锁进程已退出",
    html: `<b>执行锁未释放且持锁进程已退出</b>：疑似执行器崩溃或被强制结束。这不是「用例失败」，也不代表「没跑过」——它是一次没有收尾的执行。需人工确认残留（浏览器实例 / 测试数据）后重跑，<b>不要自动续跑</b>：真机上有写操作，自动续跑等于重复执行。`
  } : {
    kind: "red", icon: "!", tone: "bad",
    summary: "疑似中断：最后活动已超过阈值",
    html: `<b>执行尚未收尾，最后一次活动已超过 ${minutes(trace.staleAfterMs)} 分钟</b>：${trace.stalledReason ?? ""}。这不是「用例失败」，也不代表「没跑过」——它是一次没有收尾的执行。需人工确认后重跑，<b>不要自动续跑</b>：真机上有写操作，自动续跑等于重复执行。`
  };
  const started = ex.startedAt ? Date.parse(ex.startedAt) : NaN;
  if (!ex.finishedAt && ex.locked && !Number.isNaN(started) && now - started > trace.staleAfterMs) return {
    kind: "blue", icon: "i", tone: "run",
    summary: `长跑：已 ${minutes(now - started)} 分钟，仍在活动`
  };
  if (ex.finishedAt || ex.state === "completed") return { kind: null, icon: "", tone: "done", summary: "执行已收尾" };
  if (ex.startedAt || trace.dispatch?.dispatchedAt) return { kind: null, icon: "", tone: "run", summary: ex.startedAt ? "执行中" : "已发起，等待执行器开始" };
  return { kind: null, icon: "", tone: "unknown", summary: "无执行痕迹" };
}

function timelineOf(data: TraceResponse): TimelineNode[] {
  const { registered, trace } = data;
  const ex = trace.execution;
  const nodes: TimelineNode[] = [];
  if (trace.present) nodes.push({ cls: "done", t: "—", b: "运行创建（manifest.json）", s: `manifest 状态 ${trace.manifest?.status ?? "未知"}；只证明「这次运行存在」，不证明执行开始。` });
  if (trace.dispatch?.dispatchedAt) nodes.push({ cls: "done", t: fmtTime(trace.dispatch.dispatchedAt), b: "运行被发起（dispatch.json）", s: `发起方${trace.dispatch.host ? `来自 ${trace.dispatch.host}` : "机器未知"}；发起与执行开始是两个刻度。` });
  if (ex.startedAt) nodes.push({ cls: "done", t: fmtTime(ex.startedAt), b: "执行开始", s: `执行锁与 execution-state.json 写入；startedAt 取的就是这一刻，报告与 qa_runs.started_at 都用它。` });
  if (!ex.finishedAt && ex.lastActivityAt) nodes.push({ cls: "now", t: fmtTime(ex.lastActivityAt), b: "最后一次活动", s: `阶段 ${ex.phase ?? "未知"}；判中断用的是这个时刻，不是开始时间。` });
  if (ex.finishedAt) nodes.push({ cls: "done", t: fmtTime(ex.finishedAt), b: `执行结束（密封 ${ex.attempts} 次尝试）`, s: `attempt.json 密封，执行锁删除；之后不再谈中断。` });
  if (trace.stalled) nodes.push({ cls: "bad", t: "—", b: "没有正常收尾", s: `没有密封尝试收尾${ex.locked ? "，执行锁也没删" : ""}。所以不能说「跑完了」，更不能说「失败了」。` });
  else if (trace.dispatch?.dispatchedAt && !ex.startedAt) nodes.push({ cls: "bad", t: "—", b: "执行器从未开始", s: `dispatch 在而执行痕迹全空：执行器没起来，或起来就退了。` });
  else if (!ex.finishedAt && !trace.stalled && ex.startedAt) nodes.push({ cls: "", t: "—", b: "尚未结束", s: ex.locked ? "锁还在。" : "状态未标记收尾。" });
  if (!registered) nodes.push({ cls: "bad", t: "—", b: "平台无登记行", s: `设计 / 结果 / 报告写入点都没出现过这次 run_id；平台不替它补登记。` });
  return nodes;
}

function factsOf(data: TraceResponse): Fact[] {
  const { registered, trace } = data;
  const ex = trace.execution;
  const facts: Fact[] = [{ k: "平台登记", v: registered ? "已登记" : "未登记" }];
  if (trace.startedAt) facts.push({ k: "执行开始 startedAt", v: fmtTime(trace.startedAt) });
  if (ex.finishedAt) facts.push({ k: "执行结束 finishedAt", v: fmtTime(ex.finishedAt) });
  if (ex.lastActivityAt) facts.push({ k: "最后活动", v: fmtTime(ex.lastActivityAt) });
  facts.push({ k: "密封尝试 attempts", v: String(ex.attempts), tip: "每次重跑密封一条 attempt.json；0 = 一次都没跑完" });
  if (ex.phase || ex.state) facts.push({ k: "当前阶段", v: [ex.phase, ex.state].filter(Boolean).join(" · ") });
  if (trace.dispatch?.dispatchedAt) facts.push({ k: "发起（dispatch）", v: `${fmtTime(trace.dispatch.dispatchedAt)}${trace.dispatch.host ? ` · ${trace.dispatch.host}` : ""}` });
  if (ex.locked || ex.pidStatus !== "unknown") facts.push({
    k: "持锁进程",
    v: ex.locked ? (ex.pidStatus === "alive" ? "存活" : ex.pidStatus === "dead" ? "已退出" : "无法判定（跨机）") : "—（已释放）"
  });
  facts.push({ k: "中断判定", v: trace.stalled ? "stalled = true" : "stalled = false", tip: trace.stalled && ex.orphaned ? "pid 证据优先于时间阈值" : trace.stalled ? "最后活动超过阈值" : undefined });
  if (trace.manifest?.sha256) facts.push({ k: "manifest sha256", v: shortSha(trace.manifest.sha256) });
  if (ex.blockReason) facts.push({ k: "执行器阻塞原因", v: ex.blockReason });
  return facts;
}

function whyOf(data: TraceResponse): string {
  const { registered, trace } = data;
  const ex = trace.execution;
  if (!registered && trace.present) return "这类运行以前根本看不见：平台只认自己登记过的行，工作区里的目录只出现在另一份列表里。现在两个来源摆在一起，「看见过」与「登记过」分开表述，不一致本身就是信息。";
  if (trace.dispatch?.dispatchedAt && !ex.startedAt) return "startedAt 只认执行器写的执行锁 / execution-state.json；dispatch.json 只能证明「命令被调用过」，不能证明「执行开始了」。把两者分开，报告就不能靠 dispatch 混过 report_untraced 断言。";
  if (trace.stalled && ex.orphaned) return "不要用「开始到现在超过 30 分钟」判中断：真机跑 40 分钟是正常的，那样会把所有长跑标成中断，人一旦见过一次误报就不再信这个标记。这里的证据是持锁进程已经不在——执行器正常收尾会删锁，剩下的锁只有两种含义：还在跑，或者跑到一半死了。同机可以用 pid 区分；跨机时 pid 不可信，只能退回时间阈值并标「需人工确认」。";
  if (trace.stalled) return `${trace.stalledReason ?? "最后活动超过阈值，且执行尚未收尾"}。判中断只看最后一次活动，不看运行时长；阈值 ${minutes(trace.staleAfterMs)} 分钟随接口一起返回。`;
  return `口径：startedAt 只认执行器写的 execution-state.json / 执行锁；manifest.json 只能证明「这次运行存在过」。stalled 用最后一次活动判（阈值 ${minutes(trace.staleAfterMs)} 分钟，随接口返回）；锁在而进程不在时不等阈值，直接判疑似中断。`;
}

export function RunTraceCard({ projectId, sessionId, runId, refresh }: { projectId: string; sessionId: string; runId: string; refresh: number }) {
  const [data, setData] = useState<TraceResponse | null>(null);
  const [hidden, setHidden] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    setData(null); setHidden(false); setError("");
    if (!projectId || !runId || !sessionId) return;
    void apiFetch<TraceResponse>(`/api/projects/${encodeURIComponent(projectId)}/agents/qa/task-records/${encodeURIComponent(sessionId)}/runs/${encodeURIComponent(runId)}/trace`).then(value => {
      // 形状防御：读不出 trace.execution（老 mock、旧网关）就如实不展示，不编造事实。
      if (!value || typeof value !== "object" || !value.trace || typeof value.trace.execution !== "object") { setHidden(true); return; }
      if (active) setData(value);
    }).catch(cause => {
      if (!active) return;
      // run_not_found（未登记且目录也无痕迹）不是页面错误，只是没有可展示的痕迹。
      if (cause instanceof ApiError && (cause.status === 404 || cause.code === "run_not_found")) { setHidden(true); return; }
      setError(cause instanceof Error ? cause.message : "运行痕迹读取失败。");
    });
    return () => { active = false; };
  }, [projectId, sessionId, runId, refresh]);
  if (hidden) return null;
  if (error) return <aside className="qtr qtr-error" role="alert">运行痕迹读取失败：{error}</aside>;
  if (!data) return null;
  const scene = sceneOf(data, Date.now());
  const alertive = scene.kind !== null;
  return <details className="qtr" open={alertive}>
    <summary>
      <span className={`qtr-badge qtr-badge-${scene.tone}`}>{scene.tone === "bad" ? "疑似中断" : scene.tone === "warn" ? "未登记" : scene.tone === "run" ? "执行中" : scene.tone === "done" ? "已收尾" : "无痕迹"}</span>
      <span className="qtr-title">运行痕迹</span>
      <span className="qtr-statement">{scene.summary}</span>
      {!alertive && <span className="qtr-hint">每个时刻都来自某一份具体文件，不是推算</span>}
    </summary>
    <div className="qtr-body">
      {scene.html && <div className={`qtr-alert qtr-alert-${scene.kind}`} role={scene.kind === "red" ? "alert" : undefined}><span className="qtr-alert-ic">{scene.icon}</span><div dangerouslySetInnerHTML={{ __html: scene.html }}/></div>}
      <section>
        <h3>时间线</h3>
        <ol className="qtr-timeline">{timelineOf(data).map((node, index) =>
          <li className={`qtr-node qtr-node-${node.cls || "plain"}`} key={index}><span className="qtr-node-dot" aria-hidden="true"/><span className="qtr-node-t">{node.t}</span><span className="qtr-node-what"><b>{node.b}</b><small>{node.s}</small></span></li>
        )}</ol>
      </section>
      <section>
        <h3>事实</h3>
        <dl className="qtr-facts">{factsOf(data).map((fact, index) =>
          <div className="qtr-fact" key={index}><dt>{fact.k}{fact.tip && <span className="qtr-tip" title={fact.tip}>?</span>}</dt><dd>{fact.v}</dd></div>
        )}</dl>
      </section>
      <p className="qtr-why">{whyOf(data)}</p>
    </div>
  </details>;
}
