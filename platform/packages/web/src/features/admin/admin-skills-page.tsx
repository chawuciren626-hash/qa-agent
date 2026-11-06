import { useCallback, useEffect, useMemo, useState } from "react";
import type { SkillMetadataItem } from "@prismshadow/penguin-server/api";
import { Button, ConfirmModal, GlyphIcon, ICONS, Modal, PageFrame, PageHeader, toastError, toastSuccess } from "@prismshadow/penguin-ui";
import * as api from "../../api/endpoints";
import { apiErrorText } from "../../lib/api-error";
import { useProject } from "../../state/project";
import { skillPresentation } from "../skills/skill-presentation";
import { SkillTile } from "../skills/skill-icon-view";
import { CentralSkillFiles } from "../skills/central-skill-files";
import { AdminSkillVersionsPage } from "./admin-skill-versions-page";
import { controlRequest } from "../../api/control";
import "../skills/skill-preview-modal.css";
import "./admin-skills-page.css";

type SkillSource = { agentId: string; label: string; skill: SkillMetadataItem };
type Entry = SkillMetadataItem & { displayName: string; summary: string; id: string; content: string; files: Record<string,string>; categoryId: string; revision: number; publishedVersion: number; published: boolean; hasDraft: boolean; archive: boolean; agentId: string; agentName: string; sources: SkillSource[]; stage: string };
const centralSkills = "/api/control/skills";
const baseStages = [
  { id: "common", name: "通用" }, { id: "req", name: "需求分析" }, { id: "design", name: "测试设计" },
  { id: "case", name: "用例生成" }, { id: "web", name: "Web 自动化" }, { id: "api", name: "接口自动化" },
  { id: "app", name: "App 自动化" }, { id: "mini", name: "小程序自动化" }, { id: "report", name: "测试报告" },
  { id: "defect", name: "缺陷管理" },
];
function Editor({ entry, close, saved }: { entry: Entry | null; close: () => void; saved: () => void }) {
  const [name, setName] = useState(entry?.name ?? "");
  const [description, setDescription] = useState(entry?.description ?? "");
  const [content, setContent] = useState((entry?.content ?? "").replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "").trim());
  const [loading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState(false);
  const [error, setError] = useState("");
  const valid = /^[a-z][a-z0-9_-]{0,63}$/.test(name) && !!description.trim() && !!content.trim();
  const save = async (publish = false) => {
    if (!valid) return;
    setSaving(true); setError("");
    try {
      await controlRequest(centralSkills + "/admin" + (entry ? "/" + entry.id : ""), entry ? "PUT" : "POST", { name, publish, description: description.trim(), content: content.trim(), ...(entry ? { revision: entry.revision } : {}) });
      toastSuccess(publish ? "技能已发布" : "技能草稿已保存"); saved();
    } catch (cause) { setError(apiErrorText(cause)); }
    finally { setSaving(false); }
  };
  return <div className="admin-skill-editor"><PageHeader title={entry ? `编辑 ${entry.name}` : "新建 Skill"} description={entry ? `编辑内置技能 · 已发布 v${entry.publishedVersion} · 保存草稿后可发布新版本` : "新建内置技能草稿"} back={{ label: "返回技能列表", onClick: close }} actions={<><Button onClick={close}>取消</Button><Button variant="primary" disabled={!valid || loading || saving} onClick={() => void save()}>{saving ? "保存中…" : "保存草稿"}</Button><Button variant="primary" disabled={!valid || saving} onClick={() => void save(true)}>发布新版本</Button></>} />
    <div className="admin-skill-editor-columns"><div><section className="admin-skill-box"><h2>基本信息</h2><label>技能名称<input value={name} disabled={!!entry} maxLength={64} onChange={event => setName(event.target.value)} placeholder="如 defect-registration-helper" /></label><small>名称用于技能目录和调用；创建后不可修改。</small><label>技能描述<textarea value={description} maxLength={2000} rows={3} onChange={event => setDescription(event.target.value)} placeholder="说明技能用途与适用场景" /></label></section><section className="admin-skill-box"><div className="admin-skill-box-title"><h2>SKILL.md 正文</h2><div><button type="button" className={!preview ? "active" : ""} onClick={() => setPreview(false)}>编辑</button><button type="button" className={preview ? "active" : ""} onClick={() => setPreview(true)}>预览</button></div></div>{preview ? <pre className="admin-skill-preview">{content || "暂无内容"}</pre> : <textarea className="admin-skill-body" value={content} onChange={event => setContent(event.target.value)} placeholder="# 技能目标\n\n写下执行步骤和约束…" disabled={loading} />}</section></div>
      <aside><section className="admin-skill-box"><h2>完成度检查</h2><p>{/^[A-Za-z0-9_-]{1,64}$/.test(name) ? "✓" : "○"} 名称合法</p><p>{description.trim() ? "✓" : "○"} 描述已填写</p><p>{content.trim() ? "✓" : "○"} 正文已填写</p></section><section className="admin-skill-box"><h2>YAML 元信息预览</h2><pre>{`---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(description)}\n---`}</pre></section><section className="admin-skill-box"><h2>文件结构</h2><p>📄 SKILL.md</p><small>{entry ? "原有参考文件和脚本会保留。" : "可通过 ZIP 导入附属文件。"}</small></section></aside></div>{error && <p role="alert" className="admin-skill-error">{error}</p>}</div>;
}

export function AdminSkillsPage({ central = false }: { central?: boolean }) {
  return central ? <SkillsPage /> : <LocalSkillsPage />;
}

function LocalSkillsPage() {
  const project = useProject();
  return <SkillsPage project={project} />;
}

function SkillsPage({ project }: { project?: Pick<ReturnType<typeof useProject>, "agents" | "currentProject"> }) {
  const agents = project?.agents ?? [];
  const currentProject = project?.currentProject;
  const projectId = currentProject?.projectId ?? null;
  const [selected, setSelected] = useState("");
  const skillAgents = useMemo(() => agents.filter(agent => agent.agentId !== "default_agent"), [agents]);
  const agentId = skillAgents.some(agent => agent.agentId === selected) ? selected : skillAgents[0]?.agentId ?? "";
  const agentOptions = useMemo(() => skillAgents.map(agent => ({ agentId: agent.agentId, label: agent.name || agent.agentId })), [skillAgents]);
  const [stage, setStage] = useState("all");
  const [categories, setCategories] = useState<{ id: string; name: string; builtin: number }[]>(baseStages.map(item => ({ ...item, builtin: 1 })));
  const [categoryOpen, setCategoryOpen] = useState(false);
  const [editingCategoryId, setEditingCategoryId] = useState<string | null>(null);
  const [categoryName, setCategoryName] = useState("");
  const [categoryError, setCategoryError] = useState("");
  const [categoryBusy, setCategoryBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [entries, setEntries] = useState<Entry[]>([]);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [importOpen, setImportOpen] = useState(false);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [editing, setEditing] = useState<Entry | "new" | null>(null);
  const [viewing, setViewing] = useState<Entry | null>(null);
  const [versionEntry, setVersionEntry] = useState<Entry | null>(null);
  const [removing, setRemoving] = useState<Entry | null>(null);
  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const result = await controlRequest(centralSkills + "/admin");
      setEntries(result.skills.map((skill: Entry) => ({ ...skill, publishedVersion:Number(skill.version), ...skillPresentation(skill), agentId: "", agentName: "内置技能", sources: [], stage: skill.categoryId })));
      setCategories(result.categories);
    } catch (cause) { setError(apiErrorText(cause)); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const reloadCategories = useCallback(async () => { await load(); }, [load]);

  useEffect(() => {
    if (!projectId || !agentId) { setEnabled(null); return; }
    let active = true;
    void api.getAgentConfig(projectId, agentId, null).then(result => { if (active) setEnabled(result.config.skills.enabled); }).catch(cause => { if (active) setError(apiErrorText(cause)); });
    return () => { active = false; };
  }, [projectId, agentId]);
  const categoryOf = (item: Entry) => {
    const id = item.categoryId;
    return categories.some(category => category.id === id) ? id : categories[0]?.id ?? "common";
  };
  const categoryNameOf = (id: string) => categories.find(item => item.id === id)?.name ?? baseStages.find(item => item.id === id)?.name ?? id;
  const visible = useMemo(() => entries.filter(item => (stage === "all" || categoryOf(item) === stage) && (!query.trim() || `${item.name} ${item.displayName} ${item.summary} ${item.description}`.toLowerCase().includes(query.trim().toLowerCase()))), [entries, stage, query, categories]);
  const assignCategory = async (item: Entry, next: string) => {
    const previous = item.categoryId;
    try {
      await controlRequest(centralSkills + "/categories/assign", "PUT", { skillName: item.name, categoryId: next });
      setEntries(current => current.map(entry => entry.id === item.id ? { ...entry, categoryId: next } : entry));
      setCategoryError("");
    } catch (cause) {
      setEntries(current => current.map(entry => entry.id === item.id ? { ...entry, categoryId: previous } : entry));
      setCategoryError(apiErrorText(cause));
    }
  };
  const toggle = async () => {
    if (!projectId || !agentId || enabled === null) return;
    setBusy(true);
    try { const result = await api.putAgentConfig(projectId, agentId, { config: { skills: { enabled: !enabled } } }, null); setEnabled(result.config.skills.enabled); toastSuccess("技能设置已保存"); }
    catch (cause) { toastError(apiErrorText(cause)); }
    finally { setBusy(false); }
  };
  const remove = async () => {
    if (!removing) return;
    setBusy(true);
    try { await controlRequest(centralSkills + "/admin/" + removing.id, "DELETE"); toastSuccess("技能已删除"); setRemoving(null); await load(); }
    catch (cause) { toastError(apiErrorText(cause)); }
    finally { setBusy(false); }
  };
  const exportSkill = async (entry: Entry) => {
    try { const result = await controlRequest(centralSkills + "/admin/" + entry.id + "/export"); const bytes = Uint8Array.from(atob(result.dataBase64), (char: string) => char.charCodeAt(0)); const url = URL.createObjectURL(new Blob([bytes], { type: "application/zip" })); const link = document.createElement("a"); link.href = url; link.download = entry.name + ".zip"; link.click(); URL.revokeObjectURL(url); }
    catch (cause) { toastError(apiErrorText(cause)); }
  };
  if (versionEntry) return <PageFrame width="full" className="admin-skills-frame" contentClassName="admin-skills-content"><AdminSkillVersionsPage id={versionEntry.id} back={() => { setVersionEntry(null); void load(); }} /></PageFrame>;
  const upload = async () => {
    if (!importFile) return;
    setBusy(true);
    try {
      const dataBase64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error("文件读取失败"));
        reader.onload = () => resolve(String(reader.result).split(",")[1]!);
        reader.readAsDataURL(importFile);
      });
      await controlRequest(centralSkills + "/admin", "POST", { archiveBase64: dataBase64 });
      setImportOpen(false); setImportFile(null); toastSuccess("技能已上传"); await load();
    } catch (cause) { toastError(apiErrorText(cause)); }
    finally { setBusy(false); }
  };
  return <PageFrame width="full" className="admin-skills-frame" contentClassName="admin-skills-content">
    {editing !== null ? <Editor key={editing === "new" ? "new" : editing.id} entry={editing === "new" ? null : editing} close={() => setEditing(null)} saved={() => { setEditing(null); void load(); }} /> : <>
      <PageHeader title="技能管理" description="查看、上传、新增、编辑和导出内置技能" actions={<><Button variant="primary" onClick={() => setImportOpen(true)}>↑ 上传 Skill</Button><Button onClick={() => setEditing("new")}>＋ 新增 Skill</Button></>} />
      <div className="admin-skills-enable"><div><strong>启用技能</strong><span>按 Agent 控制会话是否自动匹配和加载技能</span></div><Button size="sm" disabled={!project} title={!project ? "请在本地项目中管理 Agent 的技能启用开关" : undefined} onClick={() => setSettingsOpen(true)}>管理开关</Button></div>
      <div className="admin-skills-columns"><aside className="admin-skills-stages" aria-label="所属阶段">
        <div className="admin-skills-stage-head">所属阶段</div>
        <button type="button" className={stage === "all" ? "active" : ""} onClick={() => setStage("all")}><span className="admin-skills-stage-mark">全</span><span>全部</span><small>{entries.length}</small></button>
        {categories.map(item => <div key={item.id} className="admin-skills-stage-row"><button type="button" className={stage === item.id ? "active" : ""} onClick={() => setStage(item.id)}><span className="admin-skills-stage-mark">{item.name.slice(0, 1)}</span><span className="admin-skills-stage-name">{item.name}</span><small>{entries.filter(entry => categoryOf(entry) === item.id).length}</small></button>{stage === item.id && <span className="admin-skills-stage-actions"><button type="button" title="编辑分类" aria-label={`编辑分类 ${item.name}`} onClick={() => { setEditingCategoryId(item.id); setCategoryName(item.name); setCategoryError(""); setCategoryOpen(true); }}><GlyphIcon d={ICONS.pencil} size={14} /></button><button type="button" title="删除分类" aria-label={`删除分类 ${item.name}`} onClick={async () => { if (entries.some(entry => categoryOf(entry) === item.id)) { setCategoryError("此分类下存在技能，请先移走后再删除。"); toastError("此分类下存在技能，请先移走后再删除。"); return; } if (!window.confirm(`删除分类「${item.name}」？`)) return; setCategoryBusy(true); setCategoryError(""); try { await controlRequest(`/api/control/skills/categories/${item.id}`, "DELETE"); if (stage === item.id) setStage("all"); await reloadCategories(); } catch (cause) { setCategoryError(apiErrorText(cause)); } finally { setCategoryBusy(false); } }}><GlyphIcon d={ICONS.trash} size={14} /></button></span>}</div>)}
        <button type="button" className="admin-skills-add-stage" onClick={() => { setEditingCategoryId(null); setCategoryName(""); setCategoryError(""); setCategoryOpen(true); }}>＋ 添加分类</button>
        {categoryError && <p role="alert" className="admin-skill-error">{categoryError}</p>}
      </aside>
        <section className="admin-skills-results"><div className="admin-skills-results-head"><h2>{stage === "all" ? "全部" : categoryNameOf(stage)}</h2><span>{visible.length} 个技能</span><input type="search" aria-label="搜索技能" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索技能名称 / 描述" /></div>{loading ? <p className="admin-skills-empty">正在加载技能…</p> : visible.length === 0 ? <p className="admin-skills-empty">没有匹配的技能</p> : <div className="admin-skills-grid">{visible.map(item => <article key={item.name} className="admin-skills-card" role="button" tabIndex={0} aria-label={`预览 ${item.name}`} onClick={() => setViewing(item)} onKeyDown={event => { if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); setViewing(item); } }}><div className="admin-skills-card-top"><SkillTile icon={item.icon} name={item.name} /><strong title={item.displayName}>{item.displayName}</strong></div><p title={item.summary}>{item.summary}</p><footer><span>{categoryNameOf(categoryOf(item))}</span><span>内置 · {item.publishedVersion ? `v${item.publishedVersion}` : "未发布"}{item.hasDraft ? " · 有草稿" : ""}</span><div className="admin-skills-card-actions"><button type="button" title="版本管理" aria-label={`版本管理 ${item.name}`} onClick={event=>{event.stopPropagation();setVersionEntry(item);}}>↶</button><button type="button" title="导出 ZIP" aria-label={`导出 ${item.name}`} onClick={event => { event.stopPropagation(); void exportSkill(item); }}>↓</button><button type="button" title="删除" aria-label={`删除 ${item.name}`} onClick={event => { event.stopPropagation(); setRemoving(item); }}>×</button></div></footer><div className="admin-skills-card-category" onClick={event => event.stopPropagation()}><label htmlFor={`skill-category-${item.name}`}>所属分类</label><select id={`skill-category-${item.name}`} aria-label={`${item.name} 所属分类`} value={categoryOf(item)} onChange={event => void assignCategory(item, event.target.value)}>{categories.map(category => <option key={category.id} value={category.id}>{category.name}</option>)}</select></div></article>)}</div>}</section></div>
      {error && <p role="alert" className="admin-skill-error">{error}</p>}
    </>}
    {importOpen && <Modal open title="上传 Skill" onClose={() => setImportOpen(false)} footer={<><Button onClick={() => setImportOpen(false)}>取消</Button><Button variant="primary" disabled={!importFile || busy} onClick={() => void upload()}>{busy ? "上传中…" : "上传"}</Button></>}><input type="file" accept=".zip,.skill" onChange={event => setImportFile(event.target.files?.[0] ?? null)} /><p className="mt-2 text-sm">ZIP 中需包含 SKILL.md，上传为草稿，发布后用户端可使用。</p></Modal>}
    {viewing && <Modal open title={viewing.displayName} onClose={() => setViewing(null)} widthClass="sm:max-w-4xl"><div className="skill-preview-info"><p className="skill-preview-id">{viewing.name}</p><p>{viewing.summary}</p></div><div className="mt-5"><CentralSkillFiles key={viewing.id} name={viewing.name} files={viewing.files}/></div></Modal>}
    {categoryOpen && <Modal open title={editingCategoryId ? "编辑技能分类" : "添加技能分类"} onClose={() => setCategoryOpen(false)} footer={<><Button size="sm" onClick={() => setCategoryOpen(false)}>取消</Button><Button size="sm" variant="primary" disabled={!categoryName.trim() || categoryBusy} onClick={async () => {
      const name = categoryName.trim();
      if (categories.some(item => item.id !== editingCategoryId && item.name.toLocaleLowerCase() === name.toLocaleLowerCase())) { setCategoryError("分类名称已存在。"); return; }
      setCategoryBusy(true); setCategoryError("");
      try {
        if (editingCategoryId) await controlRequest(`/api/control/skills/categories/${editingCategoryId}`, "PUT", { name });
        else { const created = await controlRequest("/api/control/skills/categories", "POST", { name }); setStage(created.id); }
        await reloadCategories(); setCategoryOpen(false);
      } catch (cause) { setCategoryError(apiErrorText(cause)); }
      finally { setCategoryBusy(false); }
    }}>{editingCategoryId ? "保存" : "添加分类"}</Button></>}><label className="block text-sm">分类名称<input autoFocus className="mt-2 w-full rounded border bg-transparent p-2" value={categoryName} maxLength={40} onChange={event => setCategoryName(event.target.value)} /></label>{categoryError && <p role="alert" className="mt-3 text-sm text-red-600">{categoryError}</p>}</Modal>}
    {settingsOpen && <Modal open title="启用技能" onClose={() => setSettingsOpen(false)} widthClass="sm:max-w-lg"><div className="admin-skill-settings"><label>所属 Agent<select aria-label="技能开关所属 Agent" value={agentId} onChange={event => setSelected(event.target.value)}>{agentOptions.map(agent => <option key={agent.agentId} value={agent.agentId}>{agent.label}</option>)}</select></label><div className="admin-skills-enable"><div><strong>启用技能</strong><span>控制此 Agent 的会话是否自动匹配和加载技能</span></div><button type="button" role="switch" aria-label={`启用 ${agentId} 的技能`} aria-checked={enabled === true} disabled={busy || enabled === null} className={enabled ? "on" : ""} onClick={() => void toggle()}><i /></button></div></div></Modal>}
    <ConfirmModal open={!!removing} title={removing ? `删除 ${removing.name}` : ""} busy={busy} onClose={() => setRemoving(null)} onConfirm={() => void remove()} confirmLabel="删除" cancelLabel="取消"><p>删除后用户端将无法再读取此技能。</p></ConfirmModal>
  </PageFrame>;
}
