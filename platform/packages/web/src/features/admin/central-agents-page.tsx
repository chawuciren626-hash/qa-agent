import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router";
import { AgentAvatar, Button, ConfirmModal, GlyphIcon, ICONS, ICON_SIZE, Modal, PageFrame, PageHeader, Pill } from "@prismshadow/penguin-ui";
import { controlRequest } from "../../api/control";
import { agentDescription } from "./agent-description";
import { AgentCard } from "../agents/agents-page";
import { CreateAgentDialog } from "../agents/create-agent-dialog";
import type { PluginPickItem } from "../agents/create-agent-dialog";
import "../agents/admin-agents-page.css";

export interface CentralAgentCard {
  resourceId: string;
  version: number;
  status: "draft" | "published" | "history" | "withdrawn";
  stageId: string;
  name: string;
  description: string;
  payload: Record<string, unknown>;
  updatedAt: string;
  revision?: number;
  toolCount: number | null;
  skillCount: number | null;
  hookCount: number | null;
  workbenchCount: number | null;
  scheduleCount: number | null;
  memoryCount: number;
  vaultKeyCount: number;
}
interface Stage { id: string; name: string; color: string; builtin: number }
interface Resource { id: string; kind: string; name: string; published: boolean; revision: number; version: number; audience: string[]; payload: Record<string, unknown> }
const stageOrder = ["common", "req", "design", "case", "web", "api", "app", "mini", "defect", "report"];
const stageIcons: Record<string, string> = { common: "●", req: "R", design: "D", case: "C", web: "W", api: "A", app: "M", mini: "S", defect: "B", report: "P" };
const colors = ["#7b61ff", "#0ea5a4", "#2ea86e", "#e8833a", "#d97706", "#8b5cf6", "#07a35a", "#3b82d4", "#e8618c", "#64748b"];
const centralUrl = (card: CentralAgentCard, tab?: string) => `/agents/${encodeURIComponent(card.resourceId)}${tab ? `?tab=${tab}` : ""}`;

export function CentralAgentsPage() {
  const navigate = useNavigate();
  const [cards, setCards] = useState<CentralAgentCard[]>([]);
  const [stages, setStages] = useState<Stage[]>([]);
  const [resources, setResources] = useState<Resource[]>([]);
  const [publishedResources, setPublishedResources] = useState<Resource[]>([]);
  const [selectedStage, setSelectedStage] = useState("all");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [createStageId, setCreateStageId] = useState("common");
  const [stageOpen, setStageOpen] = useState(false);
  const [editingStageId, setEditingStageId] = useState<string | null>(null);
  const [stageName, setStageName] = useState("");
  const [stageColor, setStageColor] = useState(colors[0]!);
  const [publishing, setPublishing] = useState<CentralAgentCard | null>(null);
  const [deleting, setDeleting] = useState<CentralAgentCard | null>(null);
  const load = useCallback(async () => {
    const [cardData, groupData, resourceData, publishedData] = await Promise.all([
      controlRequest("/api/control/admin/agent-cards"),
      controlRequest("/api/control/admin/agent-groups"),
      controlRequest("/api/control/admin/resources"),
      controlRequest("/api/control/catalog"),
    ]);
    setCards((cardData.cards as CentralAgentCard[]).map(card => ({ ...card, description: agentDescription(card) })));
    setStages((groupData.stages as Stage[]).sort((a, b) => (stageOrder.indexOf(a.id) < 0 ? 100 : stageOrder.indexOf(a.id)) - (stageOrder.indexOf(b.id) < 0 ? 100 : stageOrder.indexOf(b.id))));
    setResources(resourceData.resources as Resource[]);
    setPublishedResources(publishedData.resources as Resource[]);
  }, []);
  useEffect(() => { void load().catch(cause => setError(cause instanceof Error ? cause.message : "读取内置智能体失败")).finally(() => setLoading(false)); }, [load]);
  const shown = useMemo(() => cards.filter(card => (selectedStage === "all" || card.stageId === selectedStage) && [card.name, String(card.payload.agentId ?? ""), card.description].some(value => value.toLowerCase().includes(query.trim().toLowerCase()))), [cards, query, selectedStage]);
  const act = async (task: () => Promise<void>) => { setBusy(true); setError(""); try { await task(); await load(); } catch (cause) { setError(cause instanceof Error ? cause.message : "操作失败"); } finally { setBusy(false); } };
  const openStage = (stage?: Stage) => { setEditingStageId(stage?.id ?? null); setStageName(stage?.name ?? ""); setStageColor(stage?.color ?? colors[0]!); setError(""); setStageOpen(true); };
  const confirmPublish = () => void act(async () => {
    if (!publishing) return;
    const resource = resources.find(item => item.id === publishing.resourceId);
    if (!resource) throw new Error("内置智能体已变化，请刷新。");
    const checked = await controlRequest(`/api/control/admin/resources/${resource.id}/validate`, "POST");
    if (checked.valid !== true || checked.warnings?.length) throw new Error(checked.error?.message ?? checked.warnings?.join("；") ?? "校验未通过");
    await controlRequest(`/api/control/admin/resources/${resource.id}/publish`, "POST", { revision: resource.revision });
    setPublishing(null);
  });
  const confirmDelete = () => void act(async () => {
    if (!deleting || deleting.status !== "draft") return;
    const resource = resources.find(item => item.id === deleting.resourceId);
    if (!resource) throw new Error("内置智能体已变化，请刷新。");
    if (resource.version === 0) await controlRequest(`/api/control/admin/resources/${resource.id}`, "DELETE", { revision: resource.revision });
    else await controlRequest(`/api/control/admin/resources/${resource.id}/copy`, "DELETE", { revision: resource.revision });
    setDeleting(null);
  });
  const library = useMemo<PluginPickItem[]>(() => publishedResources.filter(resource => resource.kind === "plugins" && resource.published).map(resource => ({ name: resource.id, title: resource.name, titleZh: resource.name, description: resource.name, version: String(resource.version), mcpServers: [], fallbackIcon: ICONS.puzzle })), [publishedResources]);
  return <PageFrame width="full" className="admin-agent-frame" contentClassName="admin-agent-content">
    <PageHeader title="智能体管理" description="Agent 管理 · 按测试阶段查看和配置智能体" actions={<Button size="sm" onClick={() => { setCreateStageId(selectedStage === "all" ? "common" : selectedStage); setCreateOpen(true); }}>手动创建</Button>} />
    <div className="admin-agent-columns">
      <aside className="admin-agent-stages" aria-label="所属阶段">
        <div className="admin-agent-stage-heading">所属阶段</div>
        {[{ id: "all", name: "全部", color: "#185fa5", builtin: 1 }, ...stages].map((stage, index) => <div key={stage.id} className={index === 1 ? "admin-agent-stage-row with-divider" : "admin-agent-stage-row"}>
          <button type="button" className={selectedStage === stage.id ? "active" : ""} aria-current={selectedStage === stage.id ? "true" : undefined} onClick={() => setSelectedStage(stage.id)}><span className="admin-agent-stage-icon" style={{ backgroundColor: stage.color }}>{stageIcons[stage.id] ?? stage.name.slice(0, 1)}</span><span className="admin-agent-stage-name">{stage.name}</span><small>{stage.id === "all" ? cards.length : cards.filter(card => card.stageId === stage.id).length}</small></button>
          {stage.id !== "all" && selectedStage === stage.id && <span className="admin-agent-stage-actions"><button type="button" aria-label={`编辑阶段 ${stage.name}`} title="编辑阶段" onClick={() => openStage(stage)}><GlyphIcon d={ICONS.pencil} size={14} /></button><button type="button" aria-label={`删除阶段 ${stage.name}`} title="删除阶段" onClick={() => { if (cards.some(card => card.stageId === stage.id)) { setError("该阶段下仍有 Agent，仅可删除空阶段。"); return; } if (confirm(`删除阶段「${stage.name}」？`)) void act(async () => { await controlRequest(`/api/control/admin/agent-groups/${stage.id}`, "DELETE"); setSelectedStage("all"); }); }}><GlyphIcon d={ICONS.trash} size={14} /></button></span>}
        </div>)}
        <button type="button" className="admin-agent-add-stage" onClick={() => openStage()}>＋ 新增阶段</button>
      </aside>
      <section className="admin-agent-right" aria-label="Agent 列表">
        <div className="admin-agent-results-head"><h2>{selectedStage === "all" ? "全部" : stages.find(stage => stage.id === selectedStage)?.name}</h2><span>{shown.length} 个 Agent</span><input type="search" aria-label="搜索 Agent" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索 Agent：ID / 名称 / 描述" /></div>
        <div className="admin-agent-list-scroll"><div className="space-y-3">
          {loading && <p role="status">正在读取内置智能体…</p>}
          {!loading && shown.length === 0 && <p className="p-4 text-sm opacity-70">暂无 Agent</p>}
          {shown.map(card => {
            const agentId = String(card.payload.agentId ?? card.resourceId);
            const stats = [["tools", ICONS.terminalPrompt, card.toolCount, "工具"], ["skills", ICONS.bookOpen, card.skillCount, "技能"], ["hooks", ICONS.fishHook, card.hookCount, "钩子"], ["workbenches", ICONS.anvil, card.workbenchCount, "工作台"], ["memory", ICONS.brain, card.memoryCount, "记忆"], ["vault", ICONS.key, card.vaultKeyCount, "密钥"], ["schedules", ICONS.alarmClock, card.scheduleCount, "定时任务"]] as const;
            return <AgentCard key={`${card.resourceId}:${card.status}:${card.version}`} onOpen={() => navigate(centralUrl(card))} className="admin-agent-card">
              <div className="min-w-[14rem] flex-1"><div className="flex items-center gap-2"><AgentAvatar id={agentId} name={card.name} size={18} className="shrink-0 rounded" /><Link to={centralUrl(card)} className="min-w-0 truncate rounded-sm text-base font-bold hover:underline">{card.name}</Link><span className="hidden shrink-0 font-mono text-xs text-gray-400 md:inline dark:text-gray-500">{agentId}</span><Pill>{card.status === "published" ? "已发布" : card.status === "draft" ? "未发布" : card.status === "withdrawn" ? "已撤回" : "历史版本"}</Pill></div>
                <p className="mt-1.5 min-h-4 truncate text-xs text-gray-500 dark:text-gray-400">{card.description}</p>
                <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-gray-500 dark:text-gray-400">{stats.map(([tab, icon, count, label]) => <button key={tab} type="button" className="inline-flex shrink-0 cursor-pointer items-center gap-1 tabular-nums hover:text-[var(--ad-accent,#185fa5)]" data-tooltip={`${label} ${count === null ? "暂无统计" : count}`} aria-label={`${label} ${count === null ? "暂无统计" : count}`} onClick={() => navigate(centralUrl(card, tab))}><GlyphIcon d={icon} size={ICON_SIZE.inlineGlyph} />{count ?? "—"}</button>)}</div>
              </div>
              <div className="flex shrink-0 items-center gap-2">{card.status === "draft" && <Button size="sm" disabled={busy} onClick={() => setPublishing(card)}>发布</Button>}<Button size="sm" onClick={() => navigate(centralUrl(card))}><GlyphIcon d={ICONS.gear} />编辑</Button><Button size="icon" title={card.status === "draft" ? "删除工作副本" : "已发布版本保留历史记录"} disabled={busy || card.status !== "draft"} onClick={() => setDeleting(card)}><GlyphIcon d={ICONS.trash} /></Button></div>
            </AgentCard>;
          })}
        </div></div>
      </section>
    </div>
    {error && <p role="alert" className="p-2 text-sm text-red-600">{error}</p>}
    <CreateAgentDialog open={createOpen} projectId={null} library={library} libraryError={null} centralResources={publishedResources} machines={[]} onClose={() => setCreateOpen(false)} onCreated={async resourceId => { await controlRequest("/api/control/admin/agent-groups/assign", "PUT", { resourceId, stageId: createStageId }); setCreateOpen(false); await load(); navigate(`/agents/${encodeURIComponent(resourceId)}`); }} adminStages={stages.map(stage => ({ id: stage.id, name: stage.name }))} adminStageId={createStageId} onAdminStageChange={setCreateStageId} />
    {stageOpen && <Modal open title={editingStageId ? "编辑阶段" : "新增阶段"} onClose={() => setStageOpen(false)} footer={<><Button size="sm" onClick={() => setStageOpen(false)}>取消</Button><Button size="sm" variant="primary" disabled={!stageName.trim() || busy} onClick={() => void act(async () => { if (editingStageId) await controlRequest(`/api/control/admin/agent-groups/${editingStageId}`, "PUT", { name: stageName.trim(), color: stageColor }); else { const created = await controlRequest("/api/control/admin/agent-groups", "POST", { name: stageName.trim(), color: stageColor }); setSelectedStage(created.id); } setStageOpen(false); })}>保存</Button></>}><label className="block text-sm">阶段名称<input className="mt-2 w-full rounded border bg-transparent p-2" value={stageName} maxLength={40} onChange={event => setStageName(event.target.value)} /></label><fieldset className="mt-4"><legend className="text-sm">标识颜色</legend><div className="mt-2 flex flex-wrap gap-2">{colors.map(color => <button key={color} type="button" aria-label={color} aria-pressed={stageColor === color} onClick={() => setStageColor(color)} className="h-7 w-7 rounded-md" style={{ backgroundColor: color, outline: stageColor === color ? "2px solid currentColor" : undefined, outlineOffset: 2 }} />)}</div></fieldset>{error && <p role="alert" className="mt-2 text-sm text-red-600">{error}</p>}</Modal>}
    {publishing && <Modal open title="发布智能体" onClose={() => setPublishing(null)} footer={<><Button size="sm" onClick={() => setPublishing(null)}>取消</Button><Button size="sm" variant="primary" disabled={busy} onClick={confirmPublish}>确认发布</Button></>}><p className="text-sm">发布前将校验内置配置和已发布依赖。</p></Modal>}
    <ConfirmModal open={deleting !== null} title="删除智能体工作副本" busy={busy} onClose={() => setDeleting(null)} onConfirm={confirmDelete} confirmLabel="删除" cancelLabel="取消"><p className="text-sm text-gray-600 dark:text-gray-300">{deleting ? `删除「${deleting.name}」的未发布工作副本？` : ""}</p></ConfirmModal>
  </PageFrame>;
}
