import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, GlyphIcon, ICONS, Modal, PageFrame, PageHeader } from "@prismshadow/penguin-ui";
import type { PluginItem, PluginLibraryResponse } from "@prismshadow/penguin-server/api";
import { PluginCard } from "../plugins/plugin-card";
import { downloadArchive } from "../agents/archive-download";
import { controlRequest } from "../../api/control";
import type { Publication } from "./publications-page";
import "../plugins/admin-plugins-page.css";

type Category = { id: string; name: string };
type Assignment = { resourceId: string; categoryId: string };
type Form = { id?: string; revision?: number; name: string; description: string; pluginName: string; instructions: string; categoryId: string };

const libraryPath = "/api/control/admin/plugin-library";

export function CentralPluginsPage() {
  const [resources, setResources] = useState<Publication[]>([]);
  const [library, setLibrary] = useState<PluginItem[]>([]);
  const [usage, setUsage] = useState<Record<string, number>>({});
  const [categories, setCategories] = useState<Category[]>([]);
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [category, setCategory] = useState("");
  const [query, setQuery] = useState("");
  const [form, setForm] = useState<Form | null>(null);
  const [categoryForm, setCategoryForm] = useState<Category | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    const [catalog, groups, packages] = await Promise.all([
      controlRequest("/api/control/admin/resources"),
      controlRequest("/api/control/admin/central-plugin-categories"),
      controlRequest(libraryPath) as Promise<PluginLibraryResponse>,
    ]);
    setResources(catalog.resources.filter((item: Publication) => item.kind === "plugins" && item.payload.source !== "trusted-local-adapter" && (item.published || item.version === 0)));
    const counts: Record<string, number> = {};
    for (const agent of catalog.resources.filter((item: Publication) => item.kind === "agents" && item.published)) {
      for (const pluginId of (Array.isArray(agent.payload.pluginResources) ? agent.payload.pluginResources : []) as string[]) counts[pluginId] = (counts[pluginId] ?? 0) + 1;
    }
    setUsage(counts);
    const order = ["agent_evolution", "office", "software", "ai_apps", "other"];
    setCategories([...groups.categories].sort((a: Category, b: Category) => (order.indexOf(a.id) < 0 ? order.length : order.indexOf(a.id)) - (order.indexOf(b.id) < 0 ? order.length : order.indexOf(b.id))));
    setAssignments(groups.assignments);
    setLibrary(packages.groups.flatMap(group => group.plugins));
  }, []);
  useEffect(() => { void load().catch(cause => setError(String(cause))); }, [load]);
  const categoryOf = (id: string) => assignments.find(item => item.resourceId === id)?.categoryId ?? "other";
  const visible = useMemo(() => resources.filter(item => !String(item.payload.pluginName ?? "").startsWith("sandbox-") && (!category || categoryOf(item.id) === category) && `${item.name} ${item.description} ${item.payload.pluginName ?? ""}`.toLowerCase().includes(query.toLowerCase() )).sort((a, b) => categories.findIndex(group => group.id === categoryOf(a.id)) - categories.findIndex(group => group.id === categoryOf(b.id)) || String(a.payload.pluginName).localeCompare(String(b.payload.pluginName))), [resources, assignments, category, query, categories]);
  async function act(action: () => Promise<void>) {
    setBusy(true); setError("");
    try { await action(); await load(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }
  const edit = (item: Publication) => setForm({ id: item.id, revision: item.revision, name: item.name, description: item.description, pluginName: String(item.payload.pluginName ?? ""), instructions: String(item.payload.instructions ?? ""), categoryId: categoryOf(item.id) });
  const save = () => void act(async () => {
    if (!form) return;
    const original = resources.find(item => item.id === form.id);
    const payload = original?.payload.source === "trusted-local-adapter"
      ? original.payload : original?.payload.source === "upstream-library" || original?.payload.source === "server-module"
        ? { ...original.payload, instructions: form.instructions }
        : { pluginName: form.pluginName, instructions: form.instructions, skillResources: original?.payload.skillResources ?? [] };
    const saved = await controlRequest(`/api/control/admin/resources${form.id ? `/${form.id}` : ""}`, form.id ? "PUT" : "POST", {
      kind: "plugins", name: form.name, description: form.description, payload, audience: ["*"], ...(form.id ? { revision: form.revision } : {}),
    }) as Publication;
    await controlRequest(`/api/control/admin/resources/${saved.id}/publish`, "POST", { revision: saved.revision });
    if (form.categoryId) await controlRequest("/api/control/admin/central-plugin-categories/assign", "PUT", { resourceId: saved.id, categoryId: form.categoryId });
    setForm(null);
  });
  const remove = (item: Publication) => void act(async () => {
    if (usage[item.id]) throw new Error(`该插件正被 ${usage[item.id]} 个 Agent 使用，请先解除关联。`);
    if (!confirm(`删除插件“${item.name}”？`)) return;
    if (item.version) await controlRequest(`/api/control/admin/resources/${item.id}/withdraw`, "POST", {});
    else await controlRequest(`/api/control/admin/resources/${item.id}`, "DELETE", { revision: item.revision });
  });
  const saveCategory = () => void act(async () => {
    if (!categoryForm?.name.trim()) return;
    if (categoryForm.id) await controlRequest(`/api/control/admin/central-plugin-categories/${categoryForm.id}`, "PUT", { name: categoryForm.name.trim() });
    else await controlRequest("/api/control/admin/central-plugin-categories", "POST", { name: categoryForm.name.trim() });
    setCategoryForm(null);
  });
  return <PageFrame width="full" className="admin-plugin-frame" contentClassName="admin-plugin-content">
    <PageHeader title="插件管理" info="发现实用插件，扩展 AITestHarness 的测试能力。" actions={<div className="flex gap-2"><Button size="sm" variant="primary" disabled title="插件包导入暂未接入"><GlyphIcon d={ICONS.upload} size={16} />导入插件</Button><Button size="sm" disabled title="运行设置由用户项目管理"><GlyphIcon d={ICONS.gear} size={16} />设置</Button></div>}>
      <p className="text-sm text-gray-500">发现实用插件，扩展 AITestHarness 的测试能力。　共 {resources.length} 个插件</p>
    </PageHeader>
    {error && <p role="alert" className="admin-plugin-category-error">{error}</p>}
    <div className="admin-plugin-columns">
      <aside className="admin-plugin-categories" aria-label="所属分类">
        <p className="admin-plugin-category-heading">所属分类</p>
        <nav>
          <button type="button" className={category === "" ? "active" : ""} onClick={() => setCategory("")}><span className="admin-plugin-category-mark">全</span><span className="admin-plugin-category-name">全部插件</span><small>{resources.length}</small></button>
          {categories.map((item, index) => <div key={item.id} className={`admin-plugin-category-row${index === 0 ? " first" : ""}`}><button type="button" className={category === item.id ? "active" : ""} onClick={() => setCategory(item.id)}><span className="admin-plugin-category-mark">{item.name.slice(0, 1)}</span><span className="admin-plugin-category-name">{item.name}</span><small>{resources.filter(row => categoryOf(row.id) === item.id).length}</small></button><span className="admin-plugin-category-actions"><button title="编辑分类" onClick={() => setCategoryForm(item)}>✎</button><button title="删除分类" onClick={() => void act(async () => { if (!confirm(`删除分类“${item.name}”？`)) return; await controlRequest(`/api/control/admin/central-plugin-categories/${item.id}`, "DELETE"); if (category === item.id) setCategory(""); })}>♲</button></span></div>)}
        </nav>
        <button className="admin-plugin-add-category" onClick={() => setCategoryForm({ id: "", name: "" })}>＋ 添加分类</button>
      </aside>
      <section className="admin-plugin-results" aria-label="插件列表">
        <div className="admin-plugin-results-head"><h2>{categories.find(item => item.id === category)?.name ?? "全部插件"}</h2><span>{visible.length} 个插件</span><input type="search" aria-label="搜索插件" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索插件名称或描述" /></div>
        <div className="admin-plugin-results-scroll"><div className="admin-plugin-grid">{visible.map(item => <article className="admin-plugin-card" key={item.id}>
          <PluginCard framed={false} libraryPath={libraryPath}
            row={{ key: item.id, name: String(item.payload.pluginName), category: categoryOf(item.id), library: {
              ...library.find(plugin => plugin.name === item.payload.pluginName),
              name: String(item.payload.pluginName), title: item.name, titleZh: item.name,
              description: item.description, descriptionZh: item.description,
              version: String(item.payload.pluginVersion ?? ""), package: String(item.payload.moduleSpecifier ?? `@penguinharness/${item.payload.pluginName}`),
              source: "builtin", skills: library.find(plugin => plugin.name === item.payload.pluginName)?.skills ?? [],
              hooks: library.find(plugin => plugin.name === item.payload.pluginName)?.hooks ?? [], mcpServers: library.find(plugin => plugin.name === item.payload.pluginName)?.mcpServers ?? [],
            } }}
            status={usage[item.id] ? "installed" : "available"}
            usage={{ usedBy: Array.from({ length: usage[item.id] ?? 0 }, (_, index) => String(index)), behind: [] }}
            categoryTitle={categories.find(row => row.id === categoryOf(item.id))?.name ?? "其他"} showCategory
            targets={[]} installed={new Map()} canQuickStart={false} canManageLibrary={false} isAdmin isOwner={false} projectId={null} busy={busy} blocked={false}
            onQuickStart={() => {}} onDeletePlugin={null} onToggleInstall={async () => false} onUpdateOutdated={async () => {}} onModuleApply={() => {}} onMcpChanged={() => {}}
            actionsOverride={where => {
              const archiveAvailable = library.some(plugin => plugin.name === item.payload.pluginName);
              const exportPackage = () => void downloadArchive(`${libraryPath}/${encodeURIComponent(String(item.payload.pluginName))}/archive`, String(item.payload.pluginName)).catch(cause => setError(String(cause)));
              return where === "card" ? [
                <Button key="quick" size="sm" className="h-8 shrink-0" aria-label={`调用 ${item.name}`} title="请在用户项目中调用插件" disabled><GlyphIcon d={ICONS.paperPlane} size={16} /></Button>,
                <Button key="manage" size="sm" className="h-8 shrink-0" aria-label={`管理安装 ${item.name}`} title="请在用户项目中管理插件安装" disabled><GlyphIcon d={ICONS.download} size={16} /></Button>,
              ] : [
                <Button key="export" size="sm" disabled={!archiveAvailable} onClick={exportPackage}><GlyphIcon d={ICONS.download} size={16} />导出插件</Button>,
                <Button key="edit" size="sm" onClick={() => edit(item)}><GlyphIcon d={ICONS.pencil} size={16} />编辑</Button>,
                <Button key="delete" size="sm" variant="danger" disabled={busy} onClick={() => remove(item)}><GlyphIcon d={ICONS.trash} size={16} />删除</Button>,
              ];
            }} />
          <div className="admin-plugin-card-category"><label htmlFor={`plugin-category-${item.id}`}>所属分类</label><select id={`plugin-category-${item.id}`} value={categoryOf(item.id)} onChange={event => void act(async () => { await controlRequest("/api/control/admin/central-plugin-categories/assign", "PUT", { resourceId: item.id, categoryId: event.target.value }); })}>{categories.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}</select></div>
        </article>)}</div>{visible.length === 0 && <p className="admin-plugin-empty">没有匹配的插件</p>}</div>
      </section>
    </div>
    {form && <Modal open title={form.id ? "编辑插件" : "创建插件"} onClose={() => setForm(null)} footer={<><Button size="sm" onClick={() => setForm(null)}>取消</Button><Button size="sm" variant="primary" disabled={busy || !form.name.trim() || !form.pluginName.trim()} onClick={save}>保存</Button></>}><div className="space-y-3 text-sm"><label className="block">名称<input className="mt-1 w-full rounded border p-2" value={form.name} onChange={event => setForm({ ...form, name: event.target.value })} /></label><label className="block">插件标识<input className="mt-1 w-full rounded border p-2" value={form.pluginName} disabled={!!form.id} onChange={event => setForm({ ...form, pluginName: event.target.value })} /></label><label className="block">说明<textarea className="mt-1 w-full rounded border p-2" rows={3} value={form.description} onChange={event => setForm({ ...form, description: event.target.value })} /></label><label className="block">使用说明<textarea className="mt-1 w-full rounded border p-2" rows={6} value={form.instructions} onChange={event => setForm({ ...form, instructions: event.target.value })} /></label><label className="block">所属分类<select className="mt-1 w-full rounded border p-2" value={form.categoryId} onChange={event => setForm({ ...form, categoryId: event.target.value })}><option value="">其他</option>{categories.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}</select></label></div></Modal>}
    {categoryForm && <Modal open title={categoryForm.id ? "编辑插件分类" : "添加插件分类"} onClose={() => setCategoryForm(null)} footer={<><Button size="sm" onClick={() => setCategoryForm(null)}>取消</Button><Button size="sm" variant="primary" disabled={busy || !categoryForm.name.trim()} onClick={saveCategory}>保存</Button></>}><label className="block text-sm">分类名称<input className="mt-2 w-full rounded border p-2" value={categoryForm.name} onChange={event => setCategoryForm({ ...categoryForm, name: event.target.value })} /></label></Modal>}
  </PageFrame>;
}
