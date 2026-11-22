// A4：系统地图内嵌视图——资料页「系统地图」页签展示探索产出：
// 页面/接口建档计数与覆盖率、探索知识四层（模块/链路/墙点/接口）清单。
// 数据从项目环境端点拉取（listEnvironments + getEnvironmentKnowledge），
// 只读展示、不做推断；页面/路由明细清单端点尚未提供，如实说明而非编造列表。
import { useEffect, useState } from "react";
import { getEnvironmentKnowledge, listEnvironments } from "./project-management/api";
import type { EnvironmentKnowledge, EnvironmentView, KnowledgeLayer } from "./project-management/types";

const LAYER_LABELS: Record<KnowledgeLayer, string> = { module: "模块", flow: "业务链路", wall: "墙点", interface: "接口" };
const LAYER_ORDER: KnowledgeLayer[] = ["module", "flow", "wall", "interface"];
const percentage = (part: number, total: number) => total > 0 ? `${Math.round((part / total) * 100)}%` : null;

export function SystemMapView({ projectId }: { projectId: string }) {
  const [environments, setEnvironments] = useState<EnvironmentView[] | null>(null);
  const [env, setEnv] = useState("");
  const [knowledge, setKnowledge] = useState<EnvironmentKnowledge | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    let alive = true;
    setEnvironments(null); setEnv(""); setKnowledge(null); setError("");
    void listEnvironments(projectId)
      .then(result => {
        if (!alive) return;
        setEnvironments(result.environments);
        const target = result.environments.find(item => item.isDefault) ?? result.environments[0];
        if (target) setEnv(target.env);
      })
      .catch(cause => { if (alive) setError(cause instanceof Error ? cause.message : "环境读取失败"); });
    return () => { alive = false; };
  }, [projectId]);
  useEffect(() => {
    if (!env) return;
    let alive = true;
    setLoading(true); setKnowledge(null); setError("");
    void getEnvironmentKnowledge(projectId, env)
      .then(value => { if (alive) setKnowledge(value.knowledge); })
      .catch(cause => { if (alive) setError(cause instanceof Error ? cause.message : "系统地图读取失败"); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [projectId, env]);
  const environment = environments?.find(item => item.env === env) ?? null;
  const coverage = environment ? percentage(environment.pages?.registered ?? 0, environment.pages?.total ?? 0) : null;
  return <section className="qa-k-map" aria-label="系统地图">
    {error && <p role="alert" className="rounded border border-red-300 p-2 text-sm text-red-600">{error}</p>}
    {environments !== null && environments.length > 1 && <label className="mb-3 block text-sm">环境 <select aria-label="选择系统地图环境" value={env} onChange={event => setEnv(event.target.value)} className="qa-k-select">{environments.map(item => <option key={item.env} value={item.env}>{item.env}{item.isDefault ? "（默认）" : ""}</option>)}</select></label>}
    {loading && <p role="status" className="text-sm opacity-70">正在读取系统地图…</p>}
    {!loading && environments !== null && !environments.length && <p className="text-sm opacity-70">这个项目还没有登记环境；建档与探索需要在「项目环境」页完成。</p>}
    {knowledge && knowledge.lastRound === 0 && <p className="text-sm opacity-70">这个环境还没有探索记录（0 = 从没探索过）；在「项目环境」页完成建档与探索后，这里会展示探索产出。</p>}
    {environment && knowledge && knowledge.lastRound > 0 && <>
      <div className="qa-k-map-stats">
        <div className="qa-k-map-stat"><strong>{environment.pages?.total ?? "—"}</strong><small>页面建档计数</small></div>
        <div className="qa-k-map-stat"><strong>{environment.pages?.registered ?? "—"}</strong><small>已登记页面</small></div>
        <div className="qa-k-map-stat"><strong>{coverage ?? "—"}</strong><small>页面登记覆盖率</small></div>
        <div className="qa-k-map-stat"><strong>{environment.apis?.total ?? "—"}</strong><small>接口建档计数</small></div>
        {LAYER_ORDER.map(layer => <div className="qa-k-map-stat" key={layer}><strong>{knowledge.counts[layer]}</strong><small>{LAYER_LABELS[layer]}条目</small></div>)}
      </div>
      {environment.apis?.modules?.length ? <div className="mb-3"><h3 className="mb-1 text-sm font-semibold">接口模块</h3><div className="flex flex-wrap gap-1">{environment.apis.modules.map(module => <span key={module} className="rounded border border-[var(--border)] px-2 py-0.5 text-xs">{module}</span>)}</div></div> : null}
      {LAYER_ORDER.map(layer => <div className="mb-3" key={layer}>
        <h3 className="mb-1 text-sm font-semibold">{LAYER_LABELS[layer]}清单</h3>
        {knowledge.layers[layer]?.length ? <ul className="text-sm" aria-label={`${LAYER_LABELS[layer]}清单`}>
          {knowledge.layers[layer].map(entry => <li key={entry.key} className="mb-1"><strong>{entry.key}</strong>{entry.summary && <span className="opacity-70"> · {entry.summary}</span>}<span className="ml-1 text-xs opacity-50">（第 {entry.round} 轮）</span></li>)}
        </ul> : <p className="text-sm opacity-70">本层暂无条目。</p>}
      </div>)}
      <p className="text-xs opacity-60">页面/路由逐条明细清单接口尚未提供，当前展示建档计数、覆盖率与探索知识条目；地图原文件路径 {environment.mapsPath ?? "未登记"}。</p>
    </>}
  </section>;
}
