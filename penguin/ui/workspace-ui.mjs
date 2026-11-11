// Presentation-only project groups, scoped to installation, account and host configuration.
// Never changes credentials, agent configuration, source folders, or historical task files.
export function qaScope(projectId, userId, storage = globalThis.localStorage) {
  return `aitest.client.v2.${encodeURIComponent(storage.getItem("penguin.installId") || "local")}.${encodeURIComponent(userId || "anonymous")}.${encodeURIComponent(projectId || "default")}`;
}
export function qaRead(scope, storage = globalThis.localStorage) {
  try {
    const value = JSON.parse(storage.getItem(scope) || "{}");
    return {
      projects: Array.isArray(value.projects)
        ? value.projects.filter(
            (p) =>
              typeof p.id === "string" &&
              typeof p.name === "string" &&
              Array.isArray(p.folders),
          )
        : [],
      bindings:
        value.bindings && typeof value.bindings === "object"
          ? value.bindings
          : {},
    };
  } catch {
    return { projects: [], bindings: {} };
  }
}
export function qaWrite(scope, value, storage = globalThis.localStorage) {
  storage.setItem(scope, JSON.stringify(value));
  globalThis.window?.dispatchEvent(
    new CustomEvent("aitest:projects", { detail: scope }),
  );
}
export function qaBindProject(
  projectId,
  userId,
  groupId,
  sessionId,
  storage = globalThis.localStorage,
) {
  const scope = qaScope(projectId, userId, storage),
    value = qaRead(scope, storage);
  if (!groupId) {
    groupId = "default-workspace";
    if (!value.projects.some(p => p.id === groupId)) value.projects.push({ id: groupId, name: "默认工作空间", folders: [] });
  }
  if (!value.projects.some((p) => p.id === groupId)) return;
  value.bindings[sessionId] = groupId;
  qaWrite(scope, value, storage);
}
// Separate from project groups so clearing a group does not reset first-use setup.
export function qaCompleteFirstRun(projectId, userId, storage = globalThis.localStorage) {
  try { storage.setItem(qaScope(projectId, userId, storage) + '.onboarding', 'completed'); } catch {}
}
export function qaFirstRunCompleted(projectId, userId, sessions = [], storage = globalThis.localStorage) {
  try { if (storage.getItem(qaScope(projectId, userId, storage) + '.onboarding') === 'completed') return true; } catch {}
  return sessions.some(s => s.agentId === 'test_agent' && !s.origin?.length && s.source !== 'subagent' && s.source !== 'benchmark' && !String(s.source).startsWith('org_') && s.hasTrace === true);
}
export function qaProjectForSession(projects, bindings, session) {
  const bound = bindings[session.sessionId];
  if (bound) return projects.find((p) => p.id === bound) || null;
  const normalize = (value) =>
    String(value || "")
      .replaceAll("\\", "/")
      .replace(/\/+$/, "")
      .toLowerCase();
  const workspace = normalize(session.workspace);
  const matches = projects
    .flatMap((p) =>
      p.folders
        .filter((path) => {
          const root = normalize(path);
          return (
            root && (workspace === root || workspace.startsWith(root + "/"))
          );
        })
        .map((path) => ({ project: p, length: normalize(path).length })),
    )
    .sort((a, b) => b.length - a.length);
  if (
    !matches.length ||
    (matches[1] &&
      matches[1].length === matches[0].length &&
      matches[1].project.id !== matches[0].project.id)
  )
    return null;
  return matches[0].project;
}
// Derived groups keep historical tasks reachable without moving any directories or rewriting history.
export function qaWorkspaceGroups(value, sessions = []) {
  const projects = [...value.projects], bindings = { ...value.bindings };
  for (const session of sessions) {
    const matched = qaProjectForSession(projects, bindings, session);
    if (matched) { bindings[session.sessionId] = matched.id; continue; }
    const path = String(session.workspace || "").replaceAll("\\", "/").replace(/\/+$/, "");
    const leaf = path.split("/").at(-1);
    const folder = /^\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}-[a-f0-9]+$/i.test(leaf || "") ? path.slice(0, path.lastIndexOf("/")) : path;
    const id = bindings[session.sessionId] || (folder ? "historical:" + folder.toLowerCase() : "default-workspace");
    if (!projects.some(p => p.id === id)) projects.push({ id, name: folder ? folder.split("/").filter(Boolean).at(-1) || folder : "默认工作空间", folders: folder ? [folder] : [], historical: true });
    bindings[session.sessionId] = id;
  }
  return { projects, bindings };
}
export function qaTaskStatus(session, live = {}) {
  if (live.humanWaiting) return { label: "等待人工操作", kind: "waiting" };
  if (live.error) return { label: "连接异常", kind: "error" };
  if (live.pending > 0) return { label: "等待确认", kind: "waiting" };
  const status = live.status ?? session?.status;
  if (status === "running") return { label: "运行中", kind: "running" };
  if (status === "compacting") return { label: "整理上下文", kind: "running" };
  if (
    status === "failed" ||
    status === "error" ||
    live.stopReason === "failed" ||
    live.stopReason === "error"
  )
    return { label: "执行失败", kind: "error" };
  if (
    status === "cancelled" ||
    status === "canceled" ||
    live.stopReason === "cancelled" ||
    live.stopReason === "interrupted" ||
    live.stopReason === "aborted"
  )
    return { label: "已停止", kind: "idle" };
  if (live.stopReason === "completed" || status === "completed")
    return { label: "本轮已完成", kind: "done" };
  return { label: session?.hasTrace ? "待继续" : "未开始", kind: "idle" };
}
export function qaLastOutcome(items = []) {
  for (const item of [...items].reverse()) {
    if (item.kind === "user_text") return undefined;
    if (item.kind === "abort")
      return item.errorCode || item.errorMessage ? "failed" : "aborted";
    if (item.kind === "assistant_text" && item.stopReason)
      return item.stopReason;
  }
  return undefined;
}
// Temporarily disabled until the scene-specific workflow is defined.
export const qaScenesEnabled = false;
const qaGeneralPrompts = [
  "帮我新建一个测试任务",
  "根据需求生成测试用例",
  "执行一轮回归测试",
  "汇总本轮测试结果并输出测试报告",
  "根据需求生成测试点",
];
export const qaScenes = [
  {
    name: "功能测试",
    icon: "bolt",
    prefix: "请按功能测试场景处理：",
    prompts: [
      "帮我新建一个功能测试任务",
      "根据需求生成测试用例",
      "执行一轮功能回归测试",
      "汇总本轮测试结果并输出测试报告",
      "根据功能需求生成测试点",
    ],
  },
  {
    name: "接口自动化",
    icon: "plug",
    prefix: "请按接口自动化测试场景处理：",
    prompts: [
      "帮我新建一个接口自动化测试任务",
      "根据接口文档生成测试用例",
      "执行一轮接口自动化回归测试",
      "汇总接口测试结果并输出测试报告",
      "根据接口文档生成测试点",
    ],
  },
  {
    name: "Web 自动化",
    icon: "globe",
    prefix: "请按 Web 自动化测试场景处理：",
    prompts: [
      "帮我新建一个 Web 自动化测试任务",
      "根据页面需求生成测试用例",
      "执行一轮 Web 自动化回归测试",
      "汇总 Web 自动化测试结果并输出测试报告",
      "根据页面需求生成测试点",
    ],
  },
];
export const qaFirstTaskPrompt = "请为以下需求设计 3 条测试用例，交付 Excel，不执行测试：登录页的用户名和密码均为必填；用户名为空时提示‘请输入用户名’，密码为空时提示‘请输入密码’。覆盖两项必填校验和正常填写场景。";
export function qaModelSetup(catalog, agentConfig) {
  const configured=agentConfig?.config?.model;
  const ref=configured?.provider && configured?.modelId ? configured : catalog?.defaultModel;
  const model=Array.isArray(catalog?.models)?catalog.models.find(m=>m.provider===ref?.provider&&m.modelId===ref?.modelId):null;
  if(!model)return {status:'missing_model',label:'尚未选择可用的总控模型',ref:null,stamp:null};
  return {status:model.effective?.apiKeySource&&model.effective.apiKeySource!=='none'?'configured':'needs_check',label:model.displayName||model.modelId,
    ref:{provider:model.provider,modelId:model.modelId},stamp:JSON.stringify([model.provider,model.modelId,catalog.updatedAt??null,model.effective?.baseUrl??null,model.effective?.clientType??null,model.effective?.apiKeySource??null])};
}
export async function qaProbeConfiguredModel(request,base) {
  const load=async()=>{const [models,config]=await Promise.all([request(base+'/models'),request(base+'/agents/test_agent/config')]);return qaModelSetup(models,config);};
  const before=await load();if(!before.ref)return {status:'missing_model'};
  const result=await request(base+'/models/test',{method:'POST',body:before.ref});
  const after=await load();if(after.stamp!==before.stamp)return {status:'changed',model:after};
  return {status:result?.ok===true?'connected':'failed',model:after};
}
// Persist turn numbers, not reducer item IDs: prepending history rebuilds item IDs.
export function qaReadBookmarks(key, storage = globalThis.localStorage) {
  try { const value=JSON.parse(storage.getItem(key)||'[]');return Array.isArray(value)?[...new Set(value.filter(n=>Number.isSafeInteger(n)&&n>=0))]:[]; } catch { return []; }
}
export function qaToggleBookmark(key, turn, storage = globalThis.localStorage) {
  if(!Number.isSafeInteger(turn)||turn<0)throw new Error('Invalid conversation turn');
  const current=qaReadBookmarks(key,storage),next=current.includes(turn)?current.filter(n=>n!==turn):[...current,turn];
  storage.setItem(key,JSON.stringify(next));return next;
}
export function createWorkspaceUI(deps) {
  // Source builds inject these assets; legacy distributions supply the concatenated constants.
  const clientStyles = deps.clientStyles ?? (typeof qaClientStyles === "string" ? qaClientStyles : "");
  const brandLogo = deps.brandLogo ?? (typeof qaBrandLogo === "string" ? qaBrandLogo : "");
  const brandLogoLight = deps.brandLogoLight ?? (typeof qaBrandLogoLight === "string" ? qaBrandLogoLight : brandLogo);
  const {
    React: R,
    useProject,
    useSessions,
    useAuth,
    useNavigate,
    useLocation,
    FolderPicker,
    Modal,
    AccountMenu,
    ProjectNavigation,
    useSessionActions = () => null,
    notify,
    reportError,
  } = deps;
  const h = R.createElement;
  function ConversationNav({entries=[],turnOffset=0,version,scrollRef,jump,findActive,sessionId,fit,compact=false,older}) {
    const {currentProject}=useProject(),{user}=useAuth();
    const key=qaScope(currentProject?.projectId,user?.userId)+'.bookmarks.'+encodeURIComponent(sessionId||'');
    const [saved,setSaved]=R.useState(()=>qaReadBookmarks(key)),[active,setActive]=R.useState(null),[hover,setHover]=R.useState(null),[open,setOpen]=R.useState(false),[onlySaved,setOnlySaved]=R.useState(false);
    const nav=R.useRef(null),closeTimer=R.useRef(null);
    R.useEffect(()=>{setSaved(qaReadBookmarks(key));setHover(null);setOpen(false);setOnlySaved(false);const changed=e=>{if(e.key===key)setSaved(qaReadBookmarks(key));};window.addEventListener('storage',changed);return()=>{window.removeEventListener('storage',changed);clearTimeout(closeTimer.current);};},[key]);
    R.useEffect(()=>{
      const scroller=scrollRef.current;if(!scroller)return;
      let frame;const update=()=>{frame=null;setActive(findActive(scroller,new Set(entries.map(e=>e.anchorId))));};
      const schedule=()=>{if(frame==null)frame=requestAnimationFrame(update);};update();scroller.addEventListener('scroll',schedule,{passive:true});
      const resize=new ResizeObserver(schedule);resize.observe(scroller);if(scroller.firstElementChild)resize.observe(scroller.firstElementChild);
      return()=>{scroller.removeEventListener('scroll',schedule);resize.disconnect();if(frame!=null)cancelAnimationFrame(frame);};
    },[scrollRef,version,entries,findActive]);
    R.useEffect(()=>{if(!open)return;const outside=e=>{if(!nav.current?.contains(e.target))setOpen(false);};document.addEventListener('pointerdown',outside);return()=>document.removeEventListener('pointerdown',outside);},[open]);
    R.useEffect(()=>{const rail=nav.current?.querySelector('.qa-turn-rail'),tick=rail?.querySelector('[aria-current]');if(!rail||!tick)return;const a=rail.getBoundingClientRect(),b=tick.getBoundingClientRect();if(b.top<a.top)rail.scrollTop+=b.top-a.top;else if(b.bottom>a.bottom)rail.scrollTop+=b.bottom-a.bottom;},[active,entries.length]);
    const rows=entries.map((e,i)=>({...e,turn:turnOffset+i})),visible=onlySaved?rows.filter(e=>saved.includes(e.turn)):rows;
    const selected=rows.find(e=>e.anchorId===hover?.id);
    const keep=()=>clearTimeout(closeTimer.current),close=()=>{keep();closeTimer.current=setTimeout(()=>setHover(null),180);};
    function show(e,event){keep();const rect=event.currentTarget.getBoundingClientRect(),base=nav.current.getBoundingClientRect();setHover({id:e.anchorId,top:rect.top+rect.height/2-base.top});}
    function go(e){jump(scrollRef.current,e.anchorId);setActive(e.anchorId);setOpen(false);}
    function toggle(e){try{setSaved(qaToggleBookmark(key,e.turn));}catch{reportError('书签保存失败，请检查本地存储空间后重试');}}
    const mark=e=>h('button',{type:'button',className:'qa-turn-bookmark','aria-label':(saved.includes(e.turn)?'取消书签：':'添加书签：')+(e.question||'图片提问'),'aria-pressed':saved.includes(e.turn),onClick:()=>toggle(e)},h('svg',{width:15,height:17,viewBox:'0 0 16 18',fill:saved.includes(e.turn)?'currentColor':'none',stroke:'currentColor',strokeWidth:1.25,'aria-hidden':true},h('path',{d:'M4 2h8a1 1 0 0 1 1 1v13L8 13l-5 3V3a1 1 0 0 1 1-1Z'})));
    const menu=open&&h('section',{className:'qa-turn-menu','aria-label':'提问与书签',style:compact?undefined:{maxHeight:Math.max(80,(fit?.height||300)-20)}},h('div',{className:'qa-turn-tabs'},h('button',{type:'button','aria-pressed':!onlySaved,onClick:()=>setOnlySaved(false)},'全部提问'),h('button',{type:'button','aria-pressed':onlySaved,onClick:()=>setOnlySaved(true)},'书签 '+saved.length)),h('div',{className:'qa-turn-list'},visible.map(e=>h('div',{key:e.anchorId,className:'qa-turn-row'},h('button',{type:'button','aria-current':active===e.anchorId?'location':undefined,onClick:()=>go(e),title:e.question},h('small',null,e.turn+1),e.question||'图片提问'),mark(e))),visible.length===0&&h('p',null,onlySaved?'当前已加载内容中暂无书签':'暂无提问')),older?.hasMore&&h('button',{type:'button',className:'qa-turn-load',disabled:older.loading,onClick:older.onLoad},older.loading?'正在加载…':older.error?'重试加载更早提问':'加载更早提问'));
    if(!sessionId||(!entries.length&&!older?.hasMore)||(!compact&&!fit?.shown))return null;
    return h('nav',{ref:nav,className:compact?'qa-turn-nav qa-turn-compact':'qa-turn-nav','aria-label':'会话导航',onKeyDown:e=>{if(e.key==='Escape'){setOpen(false);setHover(null);nav.current.querySelector('.qa-turn-menu-toggle')?.focus();}}},
      !compact&&h('div',{className:'qa-turn-rail',style:{maxHeight:Math.max(60,(fit.height||300)-90)}},rows.map(e=>h('button',{type:'button',key:e.anchorId,className:'qa-turn-tick'+(saved.includes(e.turn)?' is-bookmarked':''),'data-outline-tick':e.anchorId,'aria-current':active===e.anchorId?'location':undefined,'aria-label':`第 ${e.turn+1} 次提问：${e.question||'图片提问'}`,onMouseEnter:event=>show(e,event),onMouseLeave:close,onFocus:event=>show(e,event),onBlur:close,onClick:()=>go(e)},h('span')))),
      h('button',{type:'button',className:'qa-turn-menu-toggle','aria-label':'提问与书签','aria-expanded':open,onClick:()=>{setOpen(!open);setHover(null);}},h(Icon,{name:'list',size:16})),menu,
      !open&&selected&&!compact&&h('div',{className:'qa-turn-preview',style:{top:Math.min(Math.max(hover.top,26),Math.max(26,(fit.height||300)-26))},onMouseEnter:keep,onMouseLeave:close,onFocus:keep,onBlur:e=>{if(!e.currentTarget.contains(e.relatedTarget))close();}},h('button',{type:'button',className:'qa-turn-summary',title:selected.question,onClick:()=>go(selected)},selected.question||'图片提问'),mark(selected)));
  }
  function BrandLogo({className = "qa-sidebar-logo"}) {
    return h("span", {className: `qa-brand-mark ${className}`, role: "img", "aria-label": "AITestHarness Logo"},
      h("img", {src: brandLogo, className:"qa-logo-default", alt:"", "aria-hidden":true, draggable:false}),
      h("img", {src: brandLogoLight, className:"qa-logo-light", alt:"", "aria-hidden":true, draggable:false}));
  }
  if (
    typeof document !== "undefined" &&
    !document.getElementById("aitest-client-styles")
  ) {
    const el = document.createElement("style");
    el.id = "aitest-client-styles";
    el.textContent = clientStyles;
    document.head.append(el);
    document.documentElement.dataset.qaClient = "v2";
  }
  const paths = {
    folder: "M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11H3Z",
    plus: "M12 5v14M5 12h14",
    chevron: "m9 5 7 7-7 7",
    edit: "m16 3 5 5-12 12-6 1 1-6Z",
    clock: "M12 8v5l3 2M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0",
    book: "M12 5v16M3 3h5a4 4 0 0 1 4 2 4 4 0 0 1 4-2h5v16h-5a4 4 0 0 0-4 2 4 4 0 0 0-4-2H3Z",
    bot: "M8 3h4v4M3 9h18v12H3ZM7 13h1m8 0h1M8 17h8",
    box: "m12 2 10 5v10l-10 5-10-5V7Zm0 10v10M2 7l10 5 10-5",
    puzzle: "M9 3H4v6a3 3 0 1 1 0 6v6h6a3 3 0 1 1 6 0h5v-6a3 3 0 1 0 0-6V3h-6a3 3 0 1 0-6 0Z",
    server: "M3 3h18v7H3ZM3 14h18v7H3ZM7 6h1m-1 11h1",
    chart: "M4 3v18h17M9 17V9m5 8V5m5 12v-6",
    trophy: "M8 3h8v7a4 4 0 0 1-8 0ZM8 5H4v3a4 4 0 0 0 4 4m8-7h4v3a4 4 0 0 1-4 4M12 14v7m-4 0h8",
    bolt: "m13 2-9 12h7l-1 8 10-13h-7Z",
    plug: "M8 2v5m8-5v5M5 7h14v4a7 7 0 0 1-14 0ZM12 18v4",
    globe:
      "M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0M2 12h20M12 2c6 6 6 14 0 20-6-6-6-14 0-20",
    refresh: "M20 7V2l-4 4a9 9 0 1 0 4 10M20 7h-5",
    back: "M20 12H4m7-7-7 7 7 7",
    more: "M4 12h1m6 0h1m6 0h1",
    list: "M4 6h16M4 12h12M4 18h16",
    close: "m6 6 12 12M6 18 18 6",
  };
  function Icon({ name, size = 16, className }) {
    return h(
      "svg",
      {
        width: size,
        height: size,
        className,
        viewBox: "0 0 24 24",
        fill: "none",
        stroke: "currentColor",
        strokeWidth: 1.6,
        strokeLinecap: "round",
        strokeLinejoin: "round",
        "aria-hidden": true,
      },
      h("path", { d: paths[name] || paths.folder }),
    );
  }
  function useGroups() {
    const { currentProject } = useProject(),
      { user } = useAuth();
    const scope = qaScope(currentProject?.projectId, user?.userId);
    const [, bump] = R.useReducer((n) => n + 1, 0);
    R.useEffect(() => {
      const change = () => bump();
      window.addEventListener("aitest:projects", change);
      window.addEventListener("storage", change);
      return () => {
        window.removeEventListener("aitest:projects", change);
        window.removeEventListener("storage", change);
      };
    }, []);
    const value = qaRead(scope);
    let previous = [];
    try {
      previous = JSON.parse(
        localStorage.getItem(
          "penguin.sidebarWorkspaces." + currentProject?.projectId,
        ) || "[]",
      );
    } catch {}
    const imported = Array.isArray(previous)
      ? previous
          .map((p) => (typeof p === "string" ? { path: p } : p))
          .filter((p) => p && typeof p.path === "string" && p.path.trim())
          .map((p) => ({
            id: "workspace:" + p.path,
            name: p.alias || p.path.split(/[\\/]/).filter(Boolean).pop(),
            folders: [p.path],
          }))
      : [];
    return {
      scope,
      ...value,
      projects: [
        ...value.projects,
        ...imported.filter(
          (p) => !value.projects.some((v) => v.folders.includes(p.folders[0])),
        ),
      ],
    };
  }
  function ProjectModal({ open, onClose, onCreated }) {
    const { currentProject } = useProject(),
      groups = useGroups();
    const [name, setName] = R.useState(""),
      [folders, setFolders] = R.useState([]),
      [error, setError] = R.useState("");
    R.useEffect(() => {
      if (open) {
        setName("");
        setFolders([]);
        setError("");
      }
    }, [open]);
    function create() {
      const label = name.trim();
      if (!label) return setError("请输入工作空间名称后再创建");
      if (groups.projects.some((p) => p.name === label))
        return setError("已有同名工作空间，请使用其他名称");
      const project = {
        id: crypto.randomUUID(),
        name: label,
        folders,
        createdAt: new Date().toISOString(),
      };
      try {
        const latest = qaRead(groups.scope);
        qaWrite(groups.scope, {
          ...latest,
          projects: [...latest.projects, project],
        });
        onCreated(project);
        notify(`工作空间「${label}」已创建`);
      } catch {
        setError("工作空间保存失败，请检查本机存储空间后重试");
      }
    }
    return h(
      Modal,
      {
        open,
        title: "新建工作空间",
        onClose,
        widthClass: "qa-project-modal",
        footer: h(
          "div",
          { className: "qa-modal-actions" },
          h("button", { className: "qa-button", onClick: onClose }, "取消"),
          h(
            "button",
            {
              className: "qa-button qa-primary",
              disabled: !name.trim(),
              onClick: create,
            },
            "创建工作空间",
          ),
        ),
      },
      h(
        "div",
        { className: "qa-project-form" },
        h(
          "label",
          { htmlFor: "qa-project-name", className: "qa-sr" },
          "工作空间名称",
        ),
        h(
          "div",
          { className: `qa-name-input ${error ? "qa-invalid" : ""}` },
          h(Icon, { name: "folder" }),
          h("input", {
            id: "qa-project-name",
            autoFocus: true,
            maxLength: 80,
            placeholder: "工作空间名称",
            value: name,
            "aria-invalid": !!error,
            onChange: (e) => {
              setName(e.target.value);
              setError("");
            },
            onKeyDown: (e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing) create();
            },
          }),
        ),
        error && h("p", { role: "alert", className: "qa-error" }, error),
        h("h3", null, "来源文件夹"),
        h(
          "div",
          { className: "qa-source-box" },
          folders.length
            ? h(
                "div",
                { className: "qa-folder-list" },
                ...folders.map((path) =>
                  h(
                    "div",
                    { className: "qa-folder-row", key: path },
                    h(Icon, { name: "folder" }),
                    h("span", { title: path }, path),
                    h(
                      "button",
                      {
                        className: "qa-icon-button",
                        "aria-label": `移除 ${path}`,
                        onClick: () =>
                          setFolders(folders.filter((f) => f !== path)),
                      },
                      h(Icon, { name: "close", size: 14 }),
                    ),
                  ),
                ),
              )
            : h(
                "p",
                { className: "qa-empty" },
                "尚未添加文件夹，任务将使用独立工作区",
              ),
          h(FolderPicker, {
            projectId: currentProject?.projectId || "",
            workspace: "",
            fieldLabel: "来源文件夹",
            onChange: (path) => {
              if (path && !folders.includes(path))
                setFolders([...folders, path]);
            },
            trigger: (isOpen, toggle) =>
              h(
                "button",
                {
                  className: "qa-button qa-add-folder",
                  onClick: toggle,
                  "aria-expanded": isOpen,
                },
                h(Icon, { name: "plus" }),
                folders.length ? "继续添加" : "添加本机文件夹",
              ),
          }),
          folders.length > 0 &&
            h(
              "p",
              { className: "qa-hint" },
              "来源：本机 · 发起任务时可选择工作文件夹",
            ),
        ),
      ),
    );
  }
  function Sidebar({ onNavigate, onCollapse }) {
    const project = useProject(),
      sessionState = useSessions(),
      { user } = useAuth(),
      navigate = useNavigate(),
      location = useLocation(),
      storedGroups = useGroups();
    const [modal, setModal] = R.useState(false),
      [collapsed, setCollapsed] = R.useState({}),
      [more, setMore] = R.useState(false),
      [refreshing, setRefreshing] = R.useState(false);
    const loadMarker = R.useRef(null);
    const [loadError, setLoadError] = R.useState(false);
    const canLoad = project.agents.some(a => sessionState.hasMoreFor(a.agentId, "active"));
    R.useEffect(() => {
      if (!canLoad || refreshing || loadError || !loadMarker.current) return;
      const observer = new IntersectionObserver(entries => {
        if (!entries.some(entry => entry.isIntersecting)) return;
        observer.disconnect(); setRefreshing(true);
        Promise.all(project.agents.filter(a => sessionState.hasMoreFor(a.agentId, "active")).map(a => sessionState.loadMoreFor(a.agentId, "active")))
          .catch(() => setLoadError(true)).finally(() => setRefreshing(false));
      });
      observer.observe(loadMarker.current);
      return () => observer.disconnect();
    }, [canLoad, refreshing, loadError, sessionState.sessions.length, project.currentProject?.projectId]);
    const selectedId = location.pathname.split("/chat/")[1];
    const sessionActions = useSessionActions({selectedId, onRemoved: () => go("/chat/new")});
    const search = String(sessionActions?.searchQuery || "").trim();
    const sessions = sessionState.sessions.filter(
      (s) =>
        !s.origin?.length &&
        s.source !== "subagent" &&
        s.source !== "benchmark" &&
        !String(s.source).startsWith("org_") &&
        !s.archived &&
        s.status !== "archived",
    );
    const groups = { ...storedGroups, ...qaWorkspaceGroups(storedGroups, sessions) };
    const agentId =
      project.agents.find((a) => a.agentId === "test_agent")?.agentId ||
      project.currentAgent?.agentId;
    function go(path, state) {
      navigate(path, state ? { state } : undefined);
      onNavigate?.();
    }
    function start(group) {
      group ??= groups.projects.find(p => p.id === location.state?.qaProjectId)
        || qaProjectForSession(groups.projects, groups.bindings, sessions.find(s => s.sessionId === selectedId) || { sessionId: "" })
        || (groups.projects.length === 1 ? groups.projects[0] : null)
        || groups.projects.find(p => p.id === "default-workspace")
        || { id: "default-workspace", name: "默认工作空间", folders: [] };
      try {
        const latest = qaRead(groups.scope);
        if (!latest.projects.some(p => p.id === group.id)) qaWrite(groups.scope, { ...latest, projects: [...latest.projects, group] });
      } catch { reportError("工作空间保存失败，请重试后再创建任务"); return; }
      go("/chat/new", {
        agentId,
        workspace: group?.folders[0] || "",
        qaProjectId: group?.id || null,
      });
    }
    function task(session) {
      project.setCurrentAgentId(session.agentId);
      go(`/chat/${encodeURIComponent(session.sessionId)}`);
    }
    function toggle(id) {
      setCollapsed((current) => ({ ...current, [id]: !current[id] }));
    }
    const matches = (s) =>
      !search || (s.title || "").toLowerCase().includes(search.toLowerCase());
    const recent = [...sessions]
      .filter(matches)
      .sort((a, b) =>
        Number(sessionActions?.pins.has(b.sessionId) ?? false) - Number(sessionActions?.pins.has(a.sessionId) ?? false) ||
        String(b.lastActiveAt).localeCompare(String(a.lastActiveAt)),
      );
    const projectActivity = (group) =>
      sessions.reduce(
        (latest, session) =>
          qaProjectForSession(groups.projects, groups.bindings, session)?.id ===
            group.id && (session.lastActiveAt || "") > latest
            ? session.lastActiveAt
            : latest,
        group.createdAt || "",
      );
    const taskRow = (s) => {
      if (sessionActions) return h("ul", {key:s.sessionId, className:"qa-native-session-row"}, sessionActions.row(s, task));
      const status = qaTaskStatus(s);
      return h(
        "button",
        {
          key: s.sessionId,
          className: `qa-task ${s.sessionId === selectedId ? "is-active" : ""}`,
          "aria-current": s.sessionId === selectedId ? "page" : undefined,
          onClick: () => task(s),
          title: `${s.title || "未命名任务"} · ${status.label}`,
        },
        h("span", {
          className: `qa-dot ${status.kind}`,
          "aria-label": status.label,
        }),
        h("span", { className: "qa-task-title" }, s.title || "未命名任务"),
        h(
          "time",
          { dateTime: s.lastActiveAt, title: s.lastActiveAt },
          relativeTime(s.lastActiveAt),
        ),
      );
    };
    const allowed = key => key === "models" || user?.isAdmin || !user?.modulePermissions || user.modulePermissions.includes(key);
    const nav = (label, icon, path, moduleKey = path.includes("library")?"library":path.includes("schedules")?"schedules":path.includes("qa/project")?"projects":path.split("/")[1]) =>
      (!allowed(moduleKey) ? null : h(
        "button",
        {
          className: `qa-nav ${(path === "/qa/library" ? location.pathname === "/qa/library" || (location.pathname === "/chat" && new URLSearchParams(location.search).get("view") === "library") : location.pathname + location.search === path) ? "is-active" : ""}`,
          onClick: () => go(path),
          key: label,
        },
        h(Icon, { name: icon }),
        label,
      ));
    return h(
      "div",
      { className: "qa-sidebar" },
      sessionActions?.overlays,
      h(
        "div",
        { className: "qa-brand" },
        h(BrandLogo),
        ProjectNavigation ? h(ProjectNavigation) : h("span", null, "AITestHarness"),
        onCollapse &&
          h(
            "button",
            {
              className: "qa-icon-button",
              onClick: onCollapse,
              "aria-label": "收起侧栏",
            },
            h(Icon, { name: "back" }),
          ),
      ),
      h(
        "button",
        { className: "qa-new-task", onClick: () => start() },
        h(Icon, { name: "edit" }),
        "新建任务",
      ),
      h(
        "nav",
        { className: "qa-nav-list", "aria-label": "功能导航" },
        nav("项目视图", "folder", "/qa/project"),
        nav("定时任务", "clock", "/chat?view=schedules"),
        nav("项目资料", "book", "/qa/library", "library"),
      ),
      h(
        "div",
        { className: "qa-sidebar-scroll" },
        h(
          "div",
          { className: "qa-section-heading" },
          !sessionActions?.searchOpen && h(
            "button",
            {
              onClick: () => toggle("projects"),
              "aria-label": "工作空间",
              "aria-expanded": !collapsed.projects,
            },
            h(
              "span",
              { className: collapsed.projects ? "" : "qa-expanded" },
              h(Icon, { name: "chevron", size: 12 }),
            ),
            "工作空间",
          ),
          sessionActions?.searchControl,
          h(
            "button",
            {
              className: "qa-icon-button",
              "aria-label": "新建工作空间",
              title: "新建工作空间",
              onClick: () => setModal(true),
            },
            h(Icon, { name: "plus" }),
          ),
        ),
        (!collapsed.projects || search) &&
          h(
            "div",
            null,
            ...[...groups.projects]
              .filter(group => !search || recent.some(s => qaProjectForSession(groups.projects, groups.bindings, s)?.id === group.id))
              .sort((a, b) =>
                projectActivity(b).localeCompare(projectActivity(a)),
              )
              .slice(0, more || search ? undefined : 3)
              .map((group) =>
                h(
                  "section",
                  { key: group.id, className: "qa-project" },
                  h(
                    "div",
                    { className: "qa-project-row" },
                    h(
                      "button",
                      {
                        onClick: () => toggle(group.id),
                        "aria-expanded": !collapsed[group.id],
                      },
                      h(Icon, { name: "folder" }),
                      h("span", null, group.name),
                      h(
                        "span",
                        { className: collapsed[group.id] ? "" : "qa-expanded" },
                        h(Icon, { name: "chevron", size: 12 }),
                      ),
                    ),
                    h(
                      "button",
                      {
                        className: "qa-icon-button",
                        "aria-label": `在${group.name}中新建任务`,
                        onClick: () => start(group),
                      },
                      h(Icon, { name: "plus", size: 14 }),
                    ),
                  ),
                  (!collapsed[group.id] || search) &&
                    h(
                      "div",
                      { className: "qa-project-tasks" },
                      ...recent
                        .filter(
                          (s) =>
                            qaProjectForSession(
                              groups.projects,
                              groups.bindings,
                              s,
                            )?.id === group.id && matches(s),
                        )
                        .slice(0, collapsed["more:" + group.id] || search ? undefined : 3)
                        .map(taskRow),
                      recent.filter(
                        (s) =>
                          qaProjectForSession(
                            groups.projects,
                            groups.bindings,
                            s,
                          )?.id === group.id,
                      ).length > 3 &&
                        h(
                          "button",
                          {
                            className: "qa-show-more",
                            onClick: () => toggle("more:" + group.id),
                          },
                          collapsed["more:" + group.id]
                            ? "收起任务"
                            : "显示更多任务",
                        ),
                      !sessions.some(
                        (s) =>
                          qaProjectForSession(
                            groups.projects,
                            groups.bindings,
                            s,
                          )?.id === group.id,
                      ) &&
                        h(
                          "button",
                          {
                            className: "qa-empty-task",
                            onClick: () => start(group),
                          },
                          "开始第一个测试任务",
                        ),
                    ),
                ),
              ),
            !groups.projects.length &&
              h(
                "button",
                { className: "qa-empty-task", onClick: () => setModal(true) },
                "创建工作空间，组织测试任务",
              ),
            groups.projects.length > 3 &&
              h(
                "button",
                { className: "qa-show-more", onClick: () => setMore(!more) },
                more ? "收起" : "显示更多",
              ),
          ),
        h("div", { ref: loadMarker, style: { height: 1 }, "aria-hidden": true }),
        loadError && h("button", {className: "qa-show-more", onClick: () => setLoadError(false)}, "读取任务失败，点击重试"),
      ),
      h(
        "div",
        { className: "qa-account" },
        h(AccountMenu, {
          menuClass: "bottom-full left-0 right-0 mb-1 origin-bottom",
          trigger: ({ open, toggle }) =>
            h(
              "button",
              {
                onClick: toggle,
                "aria-haspopup": "menu",
                "aria-expanded": open,
              },
              h(
                "span",
                { className: "qa-avatar" },
                (user?.displayName || user?.userId || "U")
                  .slice(0, 1)
                  .toUpperCase(),
              ),
              h("span", null, user?.displayName || user?.userId || "用户"),
              h("small", null, user?.isAdmin ? "管理员" : "成员"),
            ),
        }),
      ),
      h(ProjectModal, {
        open: modal,
        onClose: () => setModal(false),
        onCreated: (group) => {
          setModal(false);
          start(group);
        },
      }),
    );
  }
  function WorkspaceSelector({ groupId, workspace, onWorkspaceChange, onProjectChange }) {
    const groups = useGroups();
    const group = groups.projects.find(p => p.id === groupId);
    const [open, setOpen] = R.useState(false), [search, setSearch] = R.useState(""), [creating, setCreating] = R.useState(false);
    const anchor = R.useRef(null), trigger = R.useRef(null);
    const selected = group?.name || (workspace ? workspace.split(/[\\/]/).filter(Boolean).pop() : "");
    const results = groups.projects.filter(p => (p.name + " " + p.folders.join(" ")).toLowerCase().includes(search.trim().toLowerCase()));
    function close() { setOpen(false); trigger.current?.focus(); }
    function choose(project) { onProjectChange(project); setSearch(""); close(); }
    R.useEffect(() => {
      if (!open) return;
      const outside = e => { if (!anchor.current?.contains(e.target)) setOpen(false); };
      const keyboard = e => { if (e.key === "Escape") { e.preventDefault(); close(); } };
      document.addEventListener("pointerdown", outside);
      document.addEventListener("keydown", keyboard);
      return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", keyboard); };
    }, [open]);
    return h("div", {className:"qa-project-context",role:"group","aria-label":"工作空间",ref:anchor},
      selected && h("button", {type:"button",className:"qa-workspace-clear","aria-label":"清除工作空间选择",title:"不在工作空间中工作",onClick:()=>choose(null)}, h(Icon,{name:"close",size:12})),
      h("button", {type:"button",ref:trigger,className:"qa-workspace-trigger","aria-haspopup":"dialog","aria-expanded":open,
        title:workspace || group?.folders[0] || "选择工作空间工作空间",onClick:()=>{setSearch("");setOpen(!open)}},
        !selected && h(Icon,{name:"folder",size:14}), h("span",null,selected || "选择工作空间")),
      group?.folders.length > 1 && h("select", {"aria-label":"工作空间文件夹",value:workspace,onChange:e=>onWorkspaceChange(e.target.value)},
        ...group.folders.map(path=>h("option",{key:path,value:path},path))),
      open && h("div", {className:"qa-workspace-popover",role:"dialog","aria-label":"选择工作空间工作空间"},
        h("input", {className:"qa-workspace-search",type:"search",placeholder:"搜索工作空间…","aria-label":"搜索工作空间",autoFocus:true,value:search,onChange:e=>setSearch(e.target.value)}),
        h("div", {className:"qa-workspace-options"}, ...results.map(project=>h("button",{key:project.id,type:"button",className:project.id===groupId?"is-selected":"",title:project.folders.join("\n")||project.name,onClick:()=>choose(project)},
          h(Icon,{name:"folder",size:14}),h("span",null,project.name))),
          !results.length && h("p",{className:"qa-workspace-empty"},search.trim()?"没有匹配的工作空间":"暂无工作空间，可新建工作空间")),
        h("button", {type:"button",className:"qa-workspace-create",onClick:()=>{setOpen(false);setCreating(true)}},h(Icon,{name:"plus",size:14}),"新建工作空间工作空间")),
      h(ProjectModal,{open:creating,onClose:()=>{setCreating(false);trigger.current?.focus()},onCreated:project=>{setCreating(false);choose(project)}}));
  }
  function FirstRunGuide({controlRef}) {
    const {currentProject,agents=[]}=useProject();
    const {user}=useAuth();
    const {sessions=[]}=useSessions();
    const navigate=useNavigate(),projectId=currentProject?.projectId;
    const completed=qaFirstRunCompleted(projectId,user?.userId,sessions);
    const base=projectId?`/api/projects/${encodeURIComponent(projectId)}`:null;
    const scope=JSON.stringify([base,user?.userId??null]);
    const [state,setState]=R.useState({scope:null,status:'loading'}),[expanded,setExpanded]=R.useState(true);
    const epoch=R.useRef(0),busy=R.useRef(false);
    const roleIds=['test_agent','requirement_analysis_agent','test_point_agent','test_case_agent','automation_execution_agent','api_automation_agent','defect_analysis_agent','test_report_agent'];
    const count=roleIds.filter(id=>agents.some(a=>a.agentId===id&&a.enabled!==false)).length;
    async function refresh(){
      const ticket=++epoch.current;busy.current=false;setState({scope,status:'loading'});
      if(!base)return;
      try{const [models,config]=await Promise.all([deps.request(base+'/models'),deps.request(base+'/agents/test_agent/config')]);if(epoch.current===ticket)setState({scope,status:'loaded',model:qaModelSetup(models,config)});}
      catch{if(epoch.current===ticket)setState({scope,status:'load_failed'});}
    }
    R.useEffect(()=>{
      if(completed) qaCompleteFirstRun(projectId,user?.userId);
      else refresh();
      return()=>{epoch.current++;busy.current=false;};
    },[scope,completed]);
    const current=state.scope===scope?state:{status:'loading'};
    async function probe(){
      if(busy.current||!base)return;busy.current=true;const ticket=++epoch.current;
      setState(s=>({...s,status:'checking'}));
      try{const result=await qaProbeConfiguredModel(deps.request,base);if(epoch.current===ticket)setState({scope,...result});}
      catch{if(epoch.current===ticket)setState({scope,status:'failed'});}
      finally{if(epoch.current===ticket)busy.current=false;}
    }
    const messages={loading:'正在读取初始化与模型配置…',load_failed:'无法读取配置，请重试；项目访问权限也可能影响读取。',loaded:current.model?.status==='missing_model'?'请先在模型库配置模型。':'连接尚未验证。没有密钥的本地服务也可以尝试验证。',checking:'正在验证总控模型连接…',connected:'总控模型连接通过。专业角色和完整测试流程仍需实际任务验证。',failed:'连接未通过。请在模型库检查服务地址、凭据、余额和项目权限后重试。',changed:'验证期间模型配置发生变化，请重新验证。',missing_model:'请先在模型库配置并选择默认模型。'};
    if(completed)return null;
    return h('section',{className:'qa-first-run','aria-label':'开始使用'},
      h('div',{className:'qa-first-run-heading'},h('strong',null,'开始使用'),h('button',{type:'button','aria-expanded':expanded,onClick:()=>setExpanded(!expanded)},expanded?'收起':'展开')),
      expanded&&h(R.Fragment,null,
        h('p',null,`测试角色：${count}/${roleIds.length} 就绪。`,count<roleIds.length?' 尚未全部就绪，请等待初始化或检查智能体列表。':''),
        h('p',null,'总控模型：',current.model?.label||'待读取。'),
        h('p',{role:'status'},messages[current.status]||'请验证当前配置。'),
        h('div',{className:'qa-first-run-actions'},
          h('button',{type:'button',onClick:()=>navigate('/models')},'1. 配置模型'),
          h('button',{type:'button',disabled:!base||current.status==='checking'||current.status==='loading'||count<roleIds.length,onClick:probe},'2. 验证连接'),
          h('button',{type:'button',disabled:count<roleIds.length,onClick:()=>controlRef.current?.fillPrompt(qaFirstTaskPrompt,[])},'3. 填写示例任务'),
          h('button',{type:'button',disabled:current.status==='checking',onClick:refresh},'刷新配置')),
        h('small',null,'连接验证会发送一次小型模型请求，可能产生少量费用。示例仅填入输入框，由你确认发送；可用自己的模型账号配置，不附带模型额度。')));
  }
  function Hero({
    controlRef,
    scene,
    onSceneChange,
    groupId,
    workspace,
    onWorkspaceChange,
    onProjectChange,
  }) {
    const labels = [
      "新建测试任务",
      "生成测试用例",
      "执行回归测试",
      "输出测试报告",
      "生成测试点",
    ];
    return h(
      "div",
      { className: "qa-hero" },
      h("h1", null, "AITestHarness, 我帮你"),
      h(FirstRunGuide,{controlRef}),
      qaScenesEnabled && h(
        "div",
        { className: "qa-scenes", role: "group", "aria-label": "测试场景" },
        ...qaScenes.map((s, i) =>
          h(
            "button",
            {
              key: s.name,
              className: `qa-chip ${scene === i ? "is-active" : ""}`,
              "aria-pressed": scene === i,
              onClick: () => onSceneChange(i),
            },
            h(Icon, { name: s.icon, size: 14 }),
            s.name,
          ),
        ),
      ),
      h(
        "div",
        { className: "qa-quick-actions" },
        ...labels.map((label, i) =>
          h(
            "button",
            {
              key: label,
              className: "qa-quick-chip",
              onClick: () =>
                controlRef.current?.fillPrompt(qaScenesEnabled ? qaScenes[scene].prompts[i] : qaGeneralPrompts[i], []),
            },
            label,
          ),
        ),
      ),
      h(WorkspaceSelector, {groupId, workspace, onWorkspaceChange, onProjectChange}),
    );
  }
  function SessionContext({ session, status, pending, error, items, onBack }) {
    const [human, setHuman] = R.useState({ session: null, actions: [] });
    const [busy, setBusy] = R.useState(false), [humanError, setHumanError] = R.useState("");
    const submitting = R.useRef(false);
    const base = session?.sessionId ? `/api/sessions/${encodeURIComponent(session.sessionId)}/human-actions` : null;
    R.useEffect(() => {
      let alive = true, timer;
      setHuman({ session: session?.sessionId, actions: [] });setHumanError("");setBusy(false);
      async function refresh() {
        try {
          const data = await deps.request(base);
          if (alive) setHuman({ session: session.sessionId, actions: data.actions ?? [] });
        } catch { /* Keep an existing waiting card across temporary network loss. */ }
        finally { if (alive) timer = setTimeout(refresh, 2500); }
      }
      if (base && session?.agentId === "test_agent") refresh();
      return () => { alive = false; clearTimeout(timer); };
    }, [base, session?.agentId]);
    const actions = human.session === session?.sessionId ? human.actions : [];
    async function answer(action, decision) {
      if (submitting.current) return;
      submitting.current = true;setBusy(true);setHumanError("");
      try {
        const result = await deps.request(base, { method: "POST", body: { run_id: action.run_id, action_id: action.action_id, decision } });
        if(decision !== "wait") setHuman(previous => ({ ...previous, actions: previous.actions.map(item => item.action_id === action.action_id ? { ...item, status: result.status, decision } : item) }));
      } catch { setHumanError("暂时无法续接原任务。请稍后刷新查看，未重新派发或重放操作。"); }
      finally { submitting.current = false;setBusy(false); }
    }
    const groups = useGroups(),
      group = qaProjectForSession(groups.projects, groups.bindings, session);
    const outcome = qaLastOutcome(items);
    const state = qaTaskStatus(session, {
      status,
      pending,
      error,
      stopReason: outcome,
      humanWaiting: actions.length > 0,
    });
    return h(R.Fragment, null, h(
      "div",
      { className: "qa-session-context" },
      h(
        "button",
        { className: "qa-back", onClick: onBack },
        h(Icon, { name: "back", size: 14 }),
        "返回",
      ),
      h(
        "span",
        { className: "qa-breadcrumb", title: group?.name || "任务" },
        group?.name || "任务",
        " /",
      ),
      h(
        "span",
        { className: `qa-status ${state.kind}`, role: "status" },
        h("span", { className: `qa-dot ${state.kind}` }),
        state.label,
      ),
    ), ...actions.map(action => {
      const available = ["waiting_human", "not_sent"].includes(action.status);
      return h("section", { className: "qa-human-card", key: action.action_id, "aria-label": "人工操作", role: "region" },
        h("strong", null, available ? "需要你完成操作" : action.status === "accepted" ? (action.decision === "cancel" ? "正在结束原任务" : "已确认，正在续接原任务") : "正在核对续接状态"),
        h("p", null, action.question),
        h("p", { className: "qa-human-note" }, "原任务和浏览器已保留，尚未完成测试。"),
        h("div", { className: "qa-human-buttons" },
          h("button", { type: "button", className: "qa-button qa-primary", disabled: busy || !available, onClick: () => answer(action, "continue") }, ["access", "captcha", "mfa"].includes(action.kind) ? "已完成登录，继续测试" : "已完成操作，继续"),
          h("button", { type: "button", className: "qa-button", disabled: busy || !available, onClick: () => answer(action, "wait") }, "继续等待"),
          h("button", { type: "button", className: "qa-button", disabled: busy || !available, onClick: () => answer(action, "cancel") }, "取消任务")),
        humanError && h("p", { role: "alert" }, humanError));
    }));
  }
  const SectionPage = createSectionsUI({ ...deps, Icon, h });
  return { Sidebar, Hero, SessionContext, SectionPage, BrandLogo, ConversationNav };
}
function relativeTime(value) {
  const ms = Date.now() - Date.parse(value);
  if (!Number.isFinite(ms)) return "";
  if (ms < 60000) return "刚刚";
  if (ms < 3600000) return `${Math.floor(ms / 60000)} 分钟`;
  if (ms < 86400000) return `${Math.floor(ms / 3600000)} 小时`;
  return `${Math.floor(ms / 86400000)} 天`;
}

export function qaScheduleContent(item) {
  const match = /^【定时任务：([^\n]+)】\n\n/.exec(item.prompt || "");
  return {
    title: match?.[1] || item.name,
    prompt: match ? item.prompt.slice(match[0].length) : item.prompt || "",
  };
}
export function qaScheduleBody(form, original, now = Date.now()) {
  if (!form.title.trim() || /[\n\r】]/.test(form.title))
    throw Error("请输入有效的任务名称");
  if (!form.prompt.trim()) throw Error("请输入任务提示词");
  const start = new Date(form.startAt);
  if (!Number.isFinite(start.getTime())) throw Error("请选择开始日期和时间");
  if (!original && start.getTime() <= now)
    throw Error("开始时间必须晚于当前时间");
  const period = form.repeat === "custom" ? form.period.trim() : form.repeat;
  if (
    period &&
    (!/^\d+[mhd]$/.test(period) ||
      parseFloat(period) *
        { m: 60000, h: 3600000, d: 86400000 }[period.slice(-1)] <
        300000)
  )
    throw Error("重复间隔至少 5 分钟，例如 30m、12h、7d");
  const end = form.endAt ? new Date(form.endAt) : null;
  if (end && (!Number.isFinite(end.getTime()) || end <= start))
    throw Error("有效期结束时间必须晚于开始时间");
  return {
    enabled: form.enabled,
    prompt: `【定时任务：${form.title.trim()}】\n\n${form.prompt.trim()}`,
    startAt: start.toISOString(),
    ...(period ? { period } : {}),
    ...(end ? { endAt: end.toISOString() } : {}),
    ...(form.workspace ? { workspace: form.workspace } : {}),
    ...(form.model ? JSON.parse(form.model) : {}),
    ...(original?.sessionId ? { sessionId: original.sessionId } : {}),
  };
}
function createSectionsUI(deps) {
  const {
    React: R,
    h,
    Icon,
    useProject,
    useAuth,
    useSessions,
    useNavigate,
    request,
    Modal,
    FolderPicker,
    Markdown,
    notify,
  } = deps;
  const enc = encodeURIComponent;
  const localTime = (value) => {
    const d = new Date(value);
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000)
      .toISOString()
      .slice(0, 16);
  };
  const dateText = (value) =>
    value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "—";
  const sizeText = (n) =>
    n < 1024
      ? `${n} B`
      : n < 1048576
        ? `${(n / 1024).toFixed(1)} KB`
        : `${(n / 1048576).toFixed(1)} MB`;
  const button = (label, onClick, primary = false, props = {}) =>
    h(
      "button",
      {
        type: "button",
        className: `qa-button ${primary ? "qa-primary" : ""}`,
        onClick,
        ...props,
      },
      label,
    );
  function useLoad(url) {
    const [state, set] = R.useState({ loading: true, data: null, error: "" }),
      [version, bump] = R.useReducer((n) => n + 1, 0);
    R.useEffect(() => {
      let alive = true;
      set({ loading: true, data: null, error: "" });
      if (!url) return;
      request(url)
        .then((data) => alive && set({ data, loading: false, error: "" }))
        .catch(
          (e) => alive && set({ data: null, loading: false, error: e.message }),
        );
      return () => {
        alive = false;
      };
    }, [url, version]);
    return { ...state, reload: bump };
  }
  const errorBox = (error) =>
    error && h("p", { role: "alert", className: "qa-page-error" }, error);
  function SectionPage({ view }) {
    const { currentProject } = useProject(),
      { user } = useAuth();
    R.useEffect(() => {
      document.title = `${view === "schedules" ? "定时任务" : "项目资料"} · AITestHarness`;
    }, [view]);
    if (!currentProject)
      return h("div", { className: "qa-page-empty" }, "正在加载工作空间…");
    return h(view === "schedules" ? Schedules : Library, {
      key: `${currentProject.projectId}:${user?.userId}:${view}`,
      projectId: currentProject.projectId,
    });
  }
  const templates = [
    [
      "每日冒烟测试",
      "每天检查核心业务链路，记录通过情况和异常。",
      "对指定测试环境执行核心业务冒烟测试，核对登录、查询与主要业务操作，输出结果和失败证据。",
      "1d",
    ],
    [
      "接口自动化回归",
      "重复验证接口契约、关键参数与错误响应。",
      "根据工作文件夹中的接口用例执行回归，汇总通过率、异常响应及复现步骤。",
      "1d",
    ],
    [
      "Web 页面巡检",
      "检查页面可用性、导航及关键交互。",
      "巡检指定 Web 测试环境，验证页面导航与核心交互，保存异常截图并输出报告。",
      "1d",
    ],
    [
      "每周测试周报",
      "汇总测试进展、缺陷与下一步安排。",
      "汇总本周测试记录，列出执行情况、未解决缺陷、风险和下周测试建议。",
      "7d",
    ],
    [
      "缺陷复测提醒",
      "整理待复测缺陷及验证步骤。",
      "根据已有缺陷记录整理待复测清单，逐项核对修复结果与证据。",
      "1d",
    ],
    [
      "版本发布检查",
      "在指定时间核对发布前测试结果。",
      "检查当前版本的测试报告和未关闭缺陷，整理发布前检查清单及阻断项。",
      "",
    ],
  ];
  function Schedules({ projectId }) {
    const { agents, currentAgent } = useProject();
    const [agent, setAgent] = R.useState(
      agents.find((a) => a.agentId === "test_agent")?.agentId ||
        currentAgent?.agentId ||
        agents[0]?.agentId ||
        "test_agent",
    );
    const base = `/api/projects/${enc(projectId)}/agents/${enc(agent)}/schedules`;
    const list = useLoad(base),
      models = useLoad(`/api/projects/${enc(projectId)}/models`);
    const [edit, setEdit] = R.useState(null),
      [remove, setRemove] = R.useState(null),
      [busy, setBusy] = R.useState(false),
      [error, setError] = R.useState("");
    async function change(item, method) {
      setBusy(true);
      setError("");
      try {
        await request(`${base}/${enc(item.name)}`, {
          method,
          ...(method === "PUT"
            ? { body: { ...item, enabled: !item.enabled } }
            : {}),
        });
        setRemove(null);
        list.reload();
        notify(
          method === "DELETE"
            ? "定时任务已删除"
            : item.enabled
              ? "定时任务已暂停"
              : "定时任务已启用",
        );
      } catch (e) {
        setError(e.message);
      } finally {
        setBusy(false);
      }
    }
    return h(
      "section",
      { className: "qa-section-page qa-schedules" },
      h(
        "header",
        { className: "qa-page-header" },
        h(
          "div",
          null,
          h("h1", null, "定时任务"),
          h("p", null, "按计划执行测试，持续关注质量变化"),
        ),
        h(
          "div",
          { className: "qa-header-actions" },
          h(
            "select",
            {
              "aria-label": "查看智能体的定时任务",
              value: agent,
              onChange: (e) => {
                setAgent(e.target.value);
                setError("");
              },
            },
            ...agents.map((a) =>
              h(
                "option",
                { value: a.agentId, key: a.agentId },
                a.name || a.agentId,
              ),
            ),
          ),
          button("刷新", list.reload),
          button("+ 新建", () => setEdit({}), true),
        ),
      ),
      errorBox(error || list.error),
      list.loading
        ? h("div", { className: "qa-page-empty" }, "正在加载定时任务…")
        : list.error
          ? button("重新加载", list.reload)
          : list.data?.schedules?.length
            ? h(
                "div",
                { className: "qa-schedule-list" },
                ...list.data.schedules.map((item) =>
                  h(
                    "article",
                    { className: "qa-schedule-card", key: item.name },
                    h(
                      "div",
                      { className: "qa-schedule-icon" },
                      h(Icon, { name: "clock", size: 24 }),
                    ),
                    h(
                      "div",
                      { className: "qa-schedule-info" },
                      h("h2", null, qaScheduleContent(item).title),
                      h("p", null, qaScheduleContent(item).prompt),
                      h(
                        "div",
                        { className: "qa-meta" },
                        h(
                          "span",
                          null,
                          {
                            active: "已启用",
                            disabled: "已暂停",
                            done: "已执行",
                            missed: "已错过",
                            expired: "已过期",
                            invalid: "配置异常",
                          }[item.status] || item.status,
                        ),
                        h(
                          "span",
                          null,
                          item.period ? `每 ${item.period}` : "仅一次",
                        ),
                        h(
                          "span",
                          null,
                          `下次执行：${dateText(item.nextFireAt)}`,
                        ),
                      ),
                      item.invalidReason && errorBox(item.invalidReason),
                    ),
                    h(
                      "div",
                      { className: "qa-row-actions" },
                      button("编辑", () => setEdit(item)),
                      button(
                        item.enabled ? "暂停" : "启用",
                        () => change(item, "PUT"),
                        false,
                        {
                          disabled:
                            busy ||
                            ["done", "expired", "missed", "invalid"].includes(
                              item.status,
                            ),
                        },
                      ),
                      button("删除", () => setRemove(item), false, {
                        disabled: busy,
                      }),
                    ),
                  ),
                ),
              )
            : h(
                "div",
                { className: "qa-page-empty" },
                h(Icon, { name: "clock", size: 58 }),
                h("p", null, "暂无定时任务"),
                h("span", null, "创建一个计划，让测试按时开始"),
              ),
      list.data?.invalidFiles?.length > 0 &&
        errorBox(
          `另有 ${list.data.invalidFiles.length} 个配置文件无法读取，请在智能体配置中检查。`,
        ),
      h(
        "div",
        { className: "qa-template-section" },
        h("h2", null, "试试这些常用测试任务"),
        h(
          "div",
          { className: "qa-template-grid" },
          ...templates.map(([title, description, prompt, period], i) =>
            h(
              "button",
              {
                className: "qa-template-card",
                "aria-label": title,
                key: title,
                onClick: () =>
                  setEdit({ template: true, title, prompt, period }),
              },
              h(Icon, {
                name: ["bolt", "plug", "globe", "book", "refresh", "box"][i],
                size: 22,
              }),
              h(
                "div",
                null,
                h("strong", null, title),
                h("p", null, description),
              ),
            ),
          ),
        ),
      ),
      h(
        "p",
        { className: "qa-page-note" },
        "定时任务在客户端服务运行时执行；时间按本机时区显示。",
      ),
      edit &&
        h(ScheduleEditor, {
          item: edit,
          base,
          projectId,
          models: models.data?.models || [],
          onClose: () => setEdit(null),
          onSaved: () => {
            setEdit(null);
            list.reload();
          },
        }),
      h(
        Modal,
        {
          open: !!remove,
          onClose: () => !busy && setRemove(null),
          title: "删除定时任务",
          widthClass: "qa-project-modal",
          footer: h(
            "div",
            { className: "qa-modal-actions" },
            button("取消", () => setRemove(null), false, { disabled: busy }),
            button(
              busy ? "正在删除…" : "删除",
              () => change(remove, "DELETE"),
              true,
              { disabled: busy },
            ),
          ),
        },
        h(
          "p",
          null,
          `删除「${remove ? qaScheduleContent(remove).title : ""}」后将不再自动执行，已有任务记录保留。`,
        ),
        errorBox(error),
      ),
    );
  }
  function ScheduleEditor({ item, base, projectId, models, onClose, onSaved }) {
    const original = item.name ? item : null,
      parts = original ? qaScheduleContent(item) : item;
    const [form, set] = R.useState({
      title: parts.title || "",
      prompt: parts.prompt || "",
      enabled: item.enabled ?? true,
      startAt: localTime(item.startAt || Date.now() + 3600000),
      repeat: ["", "1d", "7d"].includes(item.period || "")
        ? item.period || ""
        : "custom",
      period: item.period || "30m",
      endAt: item.endAt ? localTime(item.endAt) : "",
      workspace: item.workspace || "",
      model: item.modelId
        ? JSON.stringify({ provider: item.provider, modelId: item.modelId })
        : "",
    });
    const [busy, setBusy] = R.useState(false),
      [error, setError] = R.useState("");
    const update = (key, value) => set((f) => ({ ...f, [key]: value }));
    async function save() {
      setError("");
      try {
        const body = qaScheduleBody(form, original);
        setBusy(true);
        await request(original ? `${base}/${enc(item.name)}` : base, {
          method: original ? "PUT" : "POST",
          body: original
            ? body
            : { ...body, name: `qa-${crypto.randomUUID()}` },
        });
        notify("定时任务已保存");
        onSaved();
      } catch (e) {
        setError(e.message);
      } finally {
        setBusy(false);
      }
    }
    const field = (label, control) =>
      h(
        "label",
        { className: "qa-field" },
        h("span", null, label),
        R.cloneElement(control, {
          "aria-label": control.props["aria-label"] || label,
        }),
      );
    return h(
      Modal,
      {
        open: true,
        title: original ? "编辑定时任务" : "新建定时任务",
        widthClass: "qa-schedule-modal",
        onClose: () => !busy && onClose(),
        footer: h(
          "div",
          { className: "qa-modal-actions" },
          button("取消", onClose, false, { disabled: busy }),
          button(busy ? "正在保存…" : "确定", save, true, {
            disabled: busy || !form.title.trim() || !form.prompt.trim(),
          }),
        ),
      },
      h(
        "div",
        { className: "qa-schedule-form" },
        field(
          "任务名称",
          h("input", {
            "aria-label": "任务名称",
            placeholder: "输入任务名称",
            value: form.title,
            maxLength: 80,
            onChange: (e) => update("title", e.target.value),
            autoFocus: true,
          }),
        ),
        h(
          "div",
          { className: "qa-prompt-box" },
          h("textarea", {
            "aria-label": "任务提示词",
            placeholder: "描述测试目标、环境、执行范围及预期产物…",
            value: form.prompt,
            onChange: (e) => update("prompt", e.target.value),
          }),
          h(
            "div",
            { className: "qa-prompt-footer" },
            h(FolderPicker, {
              projectId,
              workspace: form.workspace,
              onChange: (v) => update("workspace", v),
              trigger: (open, toggle) =>
                button(form.workspace || "选择工作文件夹", toggle, false, {
                  "aria-expanded": open,
                  title: form.workspace,
                }),
            }),
            h(
              "select",
              {
                "aria-label": "执行模型",
                value: form.model,
                onChange: (e) => update("model", e.target.value),
              },
              h("option", { value: "" }, "使用智能体默认模型"),
              ...models.map((m) =>
                h(
                  "option",
                  {
                    key: m.provider + ":" + m.modelId,
                    value: JSON.stringify({
                      provider: m.provider,
                      modelId: m.modelId,
                    }),
                  },
                  m.displayName || m.modelId,
                ),
              ),
            ),
          ),
        ),
        h(
          "div",
          { className: "qa-form-columns" },
          field(
            "重复",
            h(
              "select",
              {
                value: form.repeat,
                onChange: (e) => update("repeat", e.target.value),
              },
              ...[
                ["", "仅一次"],
                ["1d", "每天"],
                ["7d", "每周"],
                ["custom", "自定义间隔"],
              ].map(([v, t]) => h("option", { value: v, key: v }, t)),
            ),
          ),
          field(
            "开始时间",
            h("input", {
              type: "datetime-local",
              value: form.startAt,
              onChange: (e) => update("startAt", e.target.value),
            }),
          ),
          field(
            "有效期",
            h("input", {
              type: "datetime-local",
              value: form.endAt,
              onChange: (e) => update("endAt", e.target.value),
              "aria-label": "有效期结束时间",
            }),
          ),
        ),
        form.repeat === "custom" &&
          field(
            "重复间隔",
            h("input", {
              value: form.period,
              placeholder: "30m / 12h / 7d",
              onChange: (e) => update("period", e.target.value),
            }),
          ),
        h(
          "div",
          { className: "qa-form-bottom" },
          h(
            "label",
            null,
            h("input", {
              type: "checkbox",
              checked: form.enabled,
              onChange: (e) => update("enabled", e.target.checked),
            }),
            " 保存后启用",
          ),
          h(
            "span",
            null,
            "有效期留空为长期有效 · " +
              Intl.DateTimeFormat().resolvedOptions().timeZone,
          ),
        ),
        errorBox(error),
      ),
    );
  }
  function Library({ projectId }) {
    const { agents } = useProject(),
      { sessions } = useSessions(),
      navigate = useNavigate();
    const location = deps.useLocation?.();
    const section = new URLSearchParams(location?.search || "").get("section") || "mine";
    const validView = value => ["mine", "recent", "search", "artifacts", "knowledge_documents", "knowledge_candidates", "knowledge_rules"].includes(value) ? value : "mine";
    const agent =
      agents.find((a) => a.agentId === "test_agent")?.agentId ||
      agents[0]?.agentId ||
      "test_agent";
    const base = `/api/projects/${enc(projectId)}/agents/${enc(agent)}/memory/library`;
    const list = useLoad(base),
      [view, setView] = R.useState(validView(section)),
      [knowledgeDocumentId, setKnowledgeDocumentId] = R.useState(undefined),
      [folder, setFolder] = R.useState(null),
      [selected, setSelected] = R.useState(null),
      [edit, setEdit] = R.useState(null),
      [menu, setMenu] = R.useState(false),
      [search, setSearch] = R.useState(""),
      [error, setError] = R.useState(""),
      [busy, setBusy] = R.useState(false),
      [remove, setRemove] = R.useState(null);
    const fileInput = R.useRef(null),
      selectionSeq = R.useRef(0);
    const rows = list.data?.entries || [];
    R.useEffect(() => {setView(validView(section));}, [section]);
    const knowledgeViews = {
      knowledge_documents: { tab: "documents", label: "项目参考资料", icon: "book" },
      knowledge_candidates: { tab: "candidates", label: "待确认知识", icon: "clock" },
      knowledge_rules: { tab: "rules", label: "正式规则", icon: "book" },
    };
    const knowledgeView = deps.ProjectKnowledgePanel ? knowledgeViews[view] : null;
    async function open(row) {
      nav("mine");
      const seq = ++selectionSeq.current;
      setError("");
      if (row.kind === "folder") {
        setFolder(row.id);
        setSearch("");
        setSelected(null);
        setView("mine");
        return;
      }
      setSelected(null);
      setBusy(true);
      try {
        const doc = await request(`${base}/${row.id}`);
        if (seq === selectionSeq.current) {
          setSelected(doc);
          setFolder(doc.parentId || null);
        }
      } catch (e) {
        if (seq === selectionSeq.current) setError(e.message);
      } finally {
        if (seq === selectionSeq.current) setBusy(false);
      }
    }
    async function upload(e) {
      const files = Array.from(e.target.files || []);
      e.target.value = "";
      setBusy(true);
      setError("");
      try {
        for (const file of files) {
          if (file.size > 10 * 1024 * 1024)
            throw Error(`${file.name} 超过 10 MB，未导入`);
          const content = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result).split(",")[1]);
            reader.onerror = () => reject(Error("文件读取失败"));
            reader.readAsDataURL(file);
          });
          await request(base, {
            method: "POST",
            body: {
              name: file.name,
              kind: "file",
              parentId: folder,
              encoding: "base64",
              content,
            },
          });
        }
        notify(`已导入 ${files.length} 个文件`);
      } catch (e) {
        setError(e.message);
      } finally {
        setBusy(false);
        list.reload();
      }
    }
    async function deleteSelected() {
      setBusy(true);
      setError("");
      try {
        await request(`${base}/${remove.id}`, {
          method: "DELETE",
          body: { revision: remove.revision },
        });
        if (selected?.id === remove.id) setSelected(null);
        setRemove(null);
        list.reload();
        notify("资料已删除");
      } catch (e) {
        setError(e.message);
      } finally {
        setBusy(false);
      }
    }
    function nav(mode) {
      selectionSeq.current++;
      setBusy(false);
      setView(mode);
      setSelected(null);
      setSearch("");
      setFolder(null);
      setError("");
      setMenu(false);
      setKnowledgeDocumentId(undefined);
      navigate(`/qa/library?section=${encodeURIComponent(mode)}`, {replace:true});
    }
    function openReference(documentId) {
      nav("knowledge_documents");
      setKnowledgeDocumentId(documentId);
    }
    const visible = rows.filter((row) =>
      search
        ? row.name.toLowerCase().includes(search.toLowerCase())
        : view === "recent"
          ? row.kind !== "folder"
          : row.parentId === folder,
    );
    const ancestors = [];
    let parent = rows.find((r) => r.id === folder);
    while (parent && ancestors.length < 40) {
      ancestors.unshift(parent);
      parent = rows.find((r) => r.id === parent.parentId);
    }
    return h(
      "section",
      { className: `qa-library ${deps.ProjectKnowledgePanel ? "qa-library-integrated" : ""}` },
      h(
        "aside",
        { className: "qa-library-sidebar" },
        h(
          "div",
          { className: "qa-library-title" },
          h("h1", null, "项目资料"),
          !knowledgeView && button("刷新", list.reload),
        ),
        h(
          "div",
          { className: "qa-library-nav" },
          ...[
            ["search", "搜索", "book"],
            ["recent", "最近", "clock"],
            ["artifacts", "本地产物", "folder"],
          ].map(([v, label, icon]) =>
            h(
              "button",
              {
                key: v,
                className: view === v ? "is-active" : "",
                onClick: () => nav(v),
              },
              h(Icon, { name: icon }),
              label,
            ),
          ),
        ),
        h(
          "div",
          { className: "qa-library-group" },
          h("button", { onClick: () => nav("mine") }, "我的资料"),
          h(
            "button",
            {
              "aria-label": "新建资料",
              "aria-expanded": menu,
              onClick: () => setMenu(!menu),
            },
            h(Icon, { name: "plus" }),
          ),
        ),
        menu &&
          h(
            "div",
            { className: "qa-library-create", role: "menu" },
            ...[
              ["文档 (.md)", "file", "未命名文档.md"],
              ["表格 (.csv)", "file", "未命名表格.csv"],
              ["文件夹", "folder", "新建文件夹"],
              ["链接", "link", "新链接"],
            ].map(([label, kind, name]) =>
              h(
                "button",
                {
                  role: "menuitem",
                  key: label,
                  onClick: () => {
                    setEdit({
                      kind,
                      name,
                      parentId: folder,
                      content:
                        kind === "file" && name.endsWith(".csv")
                          ? "字段1,字段2\n"
                          : "",
                    });
                    setMenu(false);
                  },
                },
                `新建${label}`,
              ),
            ),
            h(
              "button",
              {
                role: "menuitem",
                onClick: () => {
                  setMenu(false);
                  fileInput.current?.click();
                },
              },
              "上传和导入",
            ),
          ),
        h("input", {
          type: "file",
          multiple: true,
          hidden: true,
          ref: fileInput,
          onChange: upload,
          "aria-label": "导入资料文件",
        }),
        h(
          "div",
          { className: "qa-library-tree" },
          ...rows
            .filter((r) => !r.parentId)
            .map((row) =>
              h(
                "button",
                {
                  key: row.id,
                  className:
                    !knowledgeView && (selected?.id === row.id || folder === row.id)
                      ? "is-active"
                      : "",
                  onClick: () => open(row),
                  title: row.name,
                },
                h(
                  "span",
                  { className: `qa-file-icon ${row.kind}` },
                  row.kind === "folder"
                    ? "▰"
                    : row.kind === "link"
                      ? "↗"
                      : row.name.split(".").pop().slice(0, 3).toUpperCase(),
                ),
                h("span", null, row.name),
              ),
            ),
        ),
        h(
          "div",
          { className: "qa-library-knowledge-section" },
          deps.ProjectKnowledgePanel && h("div", { className: "qa-library-group" }, "项目知识"),
          deps.ProjectKnowledgePanel && h("nav", { className: "qa-library-nav", "aria-label": "项目知识分类" },
            ...Object.entries(knowledgeViews).map(([key, entry]) => h("button", {
              key, className: view === key ? "is-active" : "", "aria-current": view === key ? "page" : undefined,
              onClick: () => nav(key),
            }, h(Icon, { name: entry.icon }), entry.label)),
          ),
        ),
        h(
          "div",
          { className: "qa-library-storage" },
          "我的资料：本机保存 · 仅当前账号",
          h(
            "div",
            null,
            `已用 ${sizeText(list.data?.usedBytes || 0)} / 100 MB`,
          ),
          deps.ProjectKnowledgePanel && h("div", { className: "qa-library-storage-note" }, "项目参考资料按项目权限使用，纳入前确认"),
        ),
      ),
      h(
        "div",
        { className: "qa-library-main" },
        h(
          "header",
          { className: "qa-library-toolbar" },
          h(
            "div",
            { className: "qa-library-crumb" },
            knowledgeView
              ? h("span", null, `项目资料 / ${knowledgeView.label}`)
              : h("button", { onClick: () => nav("mine") }, "我的资料"),
            ...(!knowledgeView ? ancestors : []).map((r) =>
              h(
                "button",
                {
                  key: r.id,
                  onClick: () => {
                    setFolder(r.id);
                    setSelected(null);
                  },
                },
                " / " + r.name,
              ),
            ),
            !knowledgeView && selected && h("span", null, " / " + selected.name),
          ),
          !knowledgeView && selected &&
            h(
              "div",
              { className: "qa-row-actions" },
              selected.kind === "file" &&
                button("下载", () => downloadDoc(selected)),
              (selected.kind === "link" || isText(selected.name)) &&
                button("编辑", () =>
                  setEdit({
                    ...selected,
                    content: textDoc(selected),
                    encoding: "utf8",
                  }),
                ),
              button("删除", () => setRemove(selected)),
            ),
        ),
        !knowledgeView && selected && deps.PersonalReferenceActions && h(deps.PersonalReferenceActions, {projectId, document:selected, onOpen:openReference}),
        !knowledgeView && errorBox(error || list.error),
        !knowledgeView && list.error && button("重新加载", list.reload),
        knowledgeView
          ? h(deps.ProjectKnowledgePanel, { tab: knowledgeView.tab, documentId:knowledgeDocumentId })
          : list.loading || busy
          ? h("div", { className: "qa-page-empty" }, "正在加载资料…")
          : selected
            ? h(DocumentView, { doc: selected })
            : view === "artifacts"
              ? h(ArtifactBrowser, { sessions, navigate })
              : h(
                  "div",
                  { className: "qa-library-content" },
                  h(
                    "div",
                    { className: "qa-library-heading" },
                    h(
                      "h2",
                      null,
                      view === "recent"
                        ? "最近更新"
                        : view === "search"
                          ? "搜索资料"
                          : ancestors.at(-1)?.name || "我的资料",
                    ),
                    button("+ 新建", () => setMenu(!menu), true),
                  ),
                  h("input", {
                    className: "qa-library-search",
                    value: search,
                    onChange: (e) => setSearch(e.target.value),
                    placeholder: "搜索资料名称…",
                    "aria-label": "搜索资料",
                    autoFocus: view === "search",
                  }),
                  view === "search" && deps.ProjectReferenceSearch && h(deps.ProjectReferenceSearch, {projectId, query:search, onOpen:openReference}),
                  !visible.length
                    ? h(
                        "div",
                        { className: "qa-page-empty" },
                        h(Icon, { name: "book", size: 48 }),
                        h("p", null, search ? "没有匹配的资料" : "还没有资料"),
                        h("span", null, "新建文档或导入需求、用例与测试报告"),
                      )
                    : h(
                        "div",
                        { className: "qa-library-files" },
                        ...visible.map((row) =>
                          h(
                            "div",
                            { className: "qa-library-file", key: row.id },
                            h(
                              "button",
                              { onClick: () => open(row) },
                              h(
                                "span",
                                { className: `qa-file-icon ${row.kind}` },
                                row.kind === "folder"
                                  ? "▰"
                                  : row.kind === "link"
                                    ? "↗"
                                    : row.name
                                        .split(".")
                                        .pop()
                                        .slice(0, 3)
                                        .toUpperCase(),
                              ),
                              h(
                                "span",
                                null,
                                h("strong", null, row.name),
                                h(
                                  "small",
                                  null,
                                  `${dateText(row.updatedAt)} · ${row.kind === "folder" ? "文件夹" : sizeText(row.size)}`,
                                ),
                              ),
                            ),
                            button("删除", () => setRemove(row), false, {
                              "aria-label": `删除 ${row.name}`,
                            }),
                          ),
                        ),
                      ),
                ),
      ),
      edit &&
        h(LibraryEditor, {
          doc: edit,
          base,
          onClose: () => setEdit(null),
          onSaved: (doc) => {
            setEdit(null);
            list.reload();
            if (doc.kind !== "folder") setSelected(doc);
          },
        }),
      h(
        Modal,
        {
          open: !!remove,
          title: "删除资料",
          widthClass: "qa-project-modal",
          onClose: () => !busy && setRemove(null),
          footer: h(
            "div",
            { className: "qa-modal-actions" },
            button("取消", () => setRemove(null), false, { disabled: busy }),
            button(busy ? "正在删除…" : "删除", deleteSelected, true, {
              disabled: busy,
            }),
          ),
        },
        h("p", null, `确认删除「${remove?.name || ""}」？此操作不可撤销。已纳入的项目参考版本及历史任务记录仍会保留；可在项目参考资料中另行归档。`),
        errorBox(error),
      ),
    );
  }
  const isText = (name) =>
    /\.(md|txt|csv|json|html?|xml|ya?ml|log)$/i.test(name);
  function textDoc(doc) {
    if (doc.encoding !== "base64") return doc.content;
    return new TextDecoder().decode(
      Uint8Array.from(atob(doc.content), (c) => c.charCodeAt(0)),
    );
  }
  function docBlob(doc) {
    return new Blob(
      [
        doc.encoding === "base64"
          ? Uint8Array.from(atob(doc.content), (c) => c.charCodeAt(0))
          : doc.content,
      ],
      {
        type: /\.pdf$/i.test(doc.name)
          ? "application/pdf"
          : "application/octet-stream",
      },
    );
  }
  function downloadDoc(doc) {
    const url = URL.createObjectURL(docBlob(doc)),
      a = document.createElement("a");
    a.href = url;
    a.download = doc.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
  function DocumentView({ doc }) {
    const [source, setSource] = R.useState(false);
    R.useEffect(() => setSource(false), [doc.id, doc.revision]);
    if (doc.kind === "link")
      return h(
        "article",
        { className: "qa-document" },
        h("h1", null, doc.name),
        h(
          "a",
          { href: doc.content, target: "_blank", rel: "noopener noreferrer" },
          doc.content,
        ),
      );
    if (!isText(doc.name))
      return h(
        "div",
        { className: "qa-page-empty" },
        h(Icon, { name: "book", size: 48 }),
        h("h2", null, doc.name),
        h("p", null, `${sizeText(doc.size)} · 下载后使用本机应用打开`),
        button("下载文件", () => downloadDoc(doc), true),
      );
    const text = textDoc(doc);
    return h(
      "article",
      { className: "qa-document" },
      h(
        "div",
        { className: "qa-document-heading" },
        h("h1", null, doc.name),
        button(source ? "阅读" : "源码", () => setSource(!source)),
      ),
      source
        ? h("pre", null, text)
        : /\.md$/i.test(doc.name)
          ? h("div", { className: "md-body" }, h(Markdown, { text }))
          : /\.html?$/i.test(doc.name)
            ? h("iframe", {
                title: doc.name,
                sandbox: "",
                referrerPolicy: "no-referrer",
                srcDoc:
                  "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'; img-src data:\">" +
                  text,
              })
            : h("pre", null, text),
    );
  }
  function LibraryEditor({ doc, base, onClose, onSaved }) {
    const [name, setName] = R.useState(doc.name),
      [content, setContent] = R.useState(doc.content || ""),
      [error, setError] = R.useState(""),
      [busy, setBusy] = R.useState(false);
    const dirty = name !== doc.name || content !== (doc.content || "");
    R.useEffect(() => {
      if (!dirty) return;
      const warn = (e) => {
        e.preventDefault();
        e.returnValue = "";
      };
      window.addEventListener("beforeunload", warn);
      return () => window.removeEventListener("beforeunload", warn);
    }, [dirty]);
    function close() {
      if (!busy && (!dirty || window.confirm("放弃尚未保存的修改？")))
        onClose();
    }
    async function save() {
      setBusy(true);
      setError("");
      try {
        const saved = await request(doc.id ? `${base}/${doc.id}` : base, {
          method: doc.id ? "PUT" : "POST",
          body: { ...doc, name, content, encoding: "utf8" },
        });
        notify("资料已保存");
        onSaved(saved);
      } catch (e) {
        setError(e.message);
      } finally {
        setBusy(false);
      }
    }
    return h(
      Modal,
      {
        open: true,
        title: doc.id
          ? "编辑资料"
          : doc.kind === "folder"
            ? "新建文件夹"
            : doc.kind === "link"
              ? "添加链接"
              : "新建资料",
        widthClass:
          doc.kind === "file" ? "qa-document-modal" : "qa-project-modal",
        onClose: close,
        footer: h(
          "div",
          { className: "qa-modal-actions" },
          button("取消", close, false, { disabled: busy }),
          button(busy ? "正在保存…" : "保存", save, true, {
            disabled: busy || !name.trim(),
          }),
        ),
      },
      h(
        "div",
        { className: "qa-document-form" },
        h(
          "label",
          null,
          "名称",
          h("input", {
            "aria-label": "资料名称",
            value: name,
            maxLength: 160,
            onChange: (e) => setName(e.target.value),
            autoFocus: true,
          }),
        ),
        doc.kind !== "folder" &&
          h(
            "label",
            null,
            doc.kind === "link" ? "链接地址" : "内容",
            h(doc.kind === "link" ? "input" : "textarea", {
              "aria-label": "资料内容",
              value: content,
              onChange: (e) => setContent(e.target.value),
              placeholder:
                doc.kind === "link" ? "https://example.com" : "输入资料内容…",
            }),
          ),
        errorBox(error),
      ),
    );
  }
  // Artifact browser: task batches as tree roots, lazily expanded type/other directories,
  // filtered with the parent chain of every hit kept visible. Reads only — nothing here moves
  // or uploads workspace files.
  const ART_TYPE_RULES = [
    ["报告", /\.(html?)$/i],
    ["数据表", /\.(xlsx|xls|csv)$/i],
    ["截图", /\.(png|jpe?g|gif|webp|bmp|svg)$/i],
    ["录像", /\.(mp4|webm|mov|avi|mkv)$/i],
    ["日志", /\.(log|txt)$/i],
    ["抓包", /\.(har|pcap|pcapng)$/i],
  ];
  const ART_TYPE_LABELS = ART_TYPE_RULES.map(([label]) => label);
  const artKindOf = (name) => {
    for (const [label, re] of ART_TYPE_RULES) if (re.test(name)) return label;
    return "文件";
  };
  const artIsText = (name) =>
    /\.(md|markdown|txt|log|json|csv|xml|ya?ml|har|html?|js|ts|css|ini|cfg)$/i.test(name);
  const ART_PREVIEW_LIMIT = 512 * 1024;
  function ArtifactBrowser({ sessions, navigate }) {
    const active = sessions.filter(
      (s) => !s.origin?.length && s.workspace && !s.archived,
    );
    const [expanded, setExpanded] = R.useState(() => new Set()),
      [dirs, setDirs] = R.useState({}),
      [sel, setSel] = R.useState(null),
      [query, setQuery] = R.useState(""),
      [kind, setKind] = R.useState(""),
      [preview, setPreview] = R.useState(null);
    const loadedDirs = R.useRef(new Set()),
      previewSeq = R.useRef(0);
    const keyOf = (sessionId, path) => `${sessionId}:${path}`;
    const rootLabel = (session) =>
      `${String(session.lastActiveAt || "").slice(0, 10) || "任务"}_${session.title || session.sessionId}`;

    function ensureDir(session, path, key) {
      if (loadedDirs.current.has(key)) return;
      loadedDirs.current.add(key);
      setDirs((current) => ({ ...current, [key]: { loading: true, error: "", entries: null } }));
      request(`/api/sessions/${enc(session.sessionId)}/files?path=${enc(path)}`)
        .then((data) =>
          setDirs((current) => ({
            ...current,
            [key]: { loading: false, error: "", entries: data?.entries || [] },
          })),
        )
        .catch((e) => {
          loadedDirs.current.delete(key);
          setDirs((current) => ({
            ...current,
            [key]: { loading: false, error: e.message, entries: null },
          }));
        });
    }
    function rescan() {
      const byId = new Map(active.map((s) => [s.sessionId, s]));
      loadedDirs.current = new Set();
      setDirs({});
      for (const key of expanded) {
        const splitAt = key.indexOf(":");
        const session = byId.get(key.slice(0, splitAt));
        if (session) ensureDir(session, key.slice(splitAt + 1), key);
      }
    }
    function clickNode(session, path, entry, isRoot = false) {
      previewSeq.current++;
      setPreview(null);
      if (entry.kind === "dir") {
        path = isRoot ? "" : path ? `${path}/${entry.name}` : entry.name;
        const key = keyOf(session.sessionId, path);
        setSel({ session, path, name: entry.name, kind: "dir", sizeBytes: entry.sizeBytes, mtime: entry.mtime });
        setExpanded((current) => {
          const next = new Set(current);
          if (next.has(key)) next.delete(key);
          else next.add(key);
          return next;
        });
        ensureDir(session, path, key);
      } else {
        setSel({ session, path, name: entry.name, kind: "file", sizeBytes: entry.sizeBytes, mtime: entry.mtime });
      }
    }
    // Text preview of the selected file, read with the page's own same-origin cookie; larger
    // and binary files fall back to the download action instead of being read into the page.
    R.useEffect(() => {
      const seq = ++previewSeq.current;
      if (!sel || sel.kind !== "file" || !artIsText(sel.name) || (sel.sizeBytes || 0) > ART_PREVIEW_LIMIT) {
        setPreview(null);
        return;
      }
      const controller = new AbortController();
      setPreview({ loading: true, text: "", error: "" });
      const filePath = sel.path ? `${sel.path}/${sel.name}` : sel.name;
      fetch(
        `/api/sessions/${enc(sel.session.sessionId)}/files/content?path=${enc(filePath)}`,
        { credentials: "same-origin", signal: controller.signal },
      )
        .then((res) => {
          if (!res.ok) throw Error(`读取失败（${res.status}）`);
          return res.text();
        })
        .then((text) => {
          if (seq === previewSeq.current) setPreview({ loading: false, text, error: "" });
        })
        .catch((e) => {
          if (seq === previewSeq.current) setPreview({ loading: false, text: "", error: e.message });
        });
      return () => {
        previewSeq.current++;
        controller.abort();
      };
    }, [sel]);

    const q = query.trim().toLowerCase();
    const filtering = !!(q || kind);
    const matchFile = (name) =>
      (!q || name.toLowerCase().includes(q)) && (!kind || artKindOf(name) === kind);
    // Search and the type filter run over the directories already loaded: a hit keeps its full
    // parent chain visible, and unloaded directories survive only when their own name matches.
    function filterLoaded(entries, session, path) {
      const out = [];
      for (const entry of entries) {
        if (entry.kind === "file") {
          if (matchFile(entry.name)) out.push(entry);
          continue;
        }
        const childPath = path ? `${path}/${entry.name}` : entry.name;
        const state = dirs[keyOf(session.sessionId, childPath)];
        const selfName = !q || entry.name.toLowerCase().includes(q);
        if (!state?.entries) {
          if (selfName && !kind) out.push(entry);
          continue;
        }
        const kids = filterLoaded(state.entries, session, childPath);
        if (kids.length || (selfName && !kind)) out.push({ ...entry, filtered: kids });
      }
      return out;
    }
    function renderNodes(entries, session, path, depth, out) {
      for (const entry of entries) {
        const childPath = path ? `${path}/${entry.name}` : entry.name;
        const key = keyOf(session.sessionId, childPath);
        const isOpen = expanded.has(key);
        if (entry.kind === "dir") {
          const state = dirs[key];
          const kids = entry.filtered ?? state?.entries ?? [];
          const count =
            entry.filtered !== undefined
              ? entry.filtered.length
              : state?.entries
                ? state.entries.length
                : null;
          out.push(
            h(
              "button",
              {
                key,
                className: `qa-art-tnode${sel?.kind === "dir" && sel.path === childPath && sel.session.sessionId === session.sessionId ? " sel" : ""}`,
                style: { paddingLeft: 8 + depth * 16 },
                onClick: () => clickNode(session, path, entry),
                title: entry.name,
              },
              h("span", { className: `qa-art-tw ${isOpen ? "open" : ""}` }, "▶"),
              h("span", { className: "qa-art-ic" }, isOpen ? "📂" : "📁"),
              h("span", { className: "qa-art-nm" }, entry.name),
              h("span", { className: "qa-art-sz" }, count === null ? "…" : `${count} 个文件`),
            ),
          );
          if ((isOpen || (filtering && kids.length)) && kids.length)
            renderNodes(kids, session, childPath, depth + 1, out);
        } else {
          out.push(
            h(
              "button",
              {
                key,
                className: `qa-art-tnode${sel?.kind === "file" && sel.path === path && sel.name === entry.name && sel.session.sessionId === session.sessionId ? " sel" : ""}`,
                style: { paddingLeft: 8 + depth * 16 },
                onClick: () => clickNode(session, path, entry),
                title: entry.name,
              },
              h("span", { className: "qa-art-tw leaf" }, "▶"),
              h("span", { className: "qa-art-ic" }, "📄"),
              h("span", { className: "qa-art-nm" }, entry.name),
              h("span", { className: "qa-art-ttag" }, artKindOf(entry.name)),
              h("span", { className: "qa-art-sz" }, sizeText(entry.sizeBytes || 0)),
            ),
          );
        }
      }
    }
    const roots = active.map((session) => ({
      session,
      name: rootLabel(session),
    }));
    const rows = [];
    for (const root of roots) {
      const key = keyOf(root.session.sessionId, "");
      const state = dirs[key];
      const rootMatch = !q || root.name.toLowerCase().includes(q);
      let kids = null;
      if (state?.entries) kids = filtering ? filterLoaded(state.entries, root.session, "") : state.entries;
      if (filtering && !rootMatch && (!kids || !kids.length)) continue;
      const isOpen = expanded.has(key);
      rows.push(
        h(
          "button",
          {
            key,
            className: `qa-art-tnode${sel?.kind === "dir" && sel.path === "" && sel.session.sessionId === root.session.sessionId ? " sel" : ""}`,
            style: { paddingLeft: 8 },
            onClick: () => clickNode(root.session, "", { name: root.name, kind: "dir" }, true),
            title: root.name,
          },
          h("span", { className: `qa-art-tw ${isOpen ? "open" : ""}` }, "▶"),
          h("span", { className: "qa-art-ic" }, isOpen ? "📂" : "📁"),
          h("span", { className: "qa-art-nm" }, root.name),
          h(
            "span",
            { className: "qa-art-sz" },
            state?.entries ? `${state.entries.length} 个文件` : state?.loading ? "…" : "",
          ),
        ),
      );
      if ((isOpen || (filtering && kids?.length)) && kids?.length)
        renderNodes(kids, root.session, "", 1, rows);
    }
    let totalFiles = 0,
      totalBytes = 0;
    for (const state of Object.values(dirs))
      for (const entry of state.entries || [])
        if (entry.kind === "file") {
          totalFiles++;
          totalBytes += entry.sizeBytes || 0;
        }
    const rootError =
      roots.map((r) => dirs[keyOf(r.session.sessionId, "")]?.error).find(Boolean) || "";
    const selError =
      sel && sel.kind === "dir" ? dirs[keyOf(sel.session.sessionId, sel.path)]?.error || "" : "";
    const crumbs = [];
    if (sel) {
      const parts = [rootLabel(sel.session), ...(sel.path ? sel.path.split("/") : [])];
      if (sel.kind === "file") parts.push(sel.name);
      parts.forEach((part, i) =>
        crumbs.push(
          h(
            "span",
            { key: `seg${i}`, className: `qa-art-seg${i === parts.length - 1 ? " cur" : ""}` },
            part,
          ),
          i < parts.length - 1 &&
            h("span", { key: `sep${i}`, className: "qa-art-sep" }, "›"),
        ),
      );
    }
    const selDirEntries =
      sel && sel.kind === "dir" ? dirs[keyOf(sel.session.sessionId, sel.path)]?.entries : null;
    const selIsImage = /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(sel?.name || "");
    const selIsVideo = /\.(mp4|webm|mov|avi|mkv)$/i.test(sel?.name || "");
    const detail = sel && h(
      "div",
      { className: "qa-art-detail" },
      h("div", { className: "qa-art-crumbs" }, ...crumbs),
      sel.kind === "dir"
        ? [
            h(
              "div",
              { className: "qa-library-heading", key: "head" },
              h("h2", { key: "t" }, `📁 ${sel.name}`),
              sel.path &&
                h(
                  "div",
                  { className: "qa-header-actions", key: "acts" },
                  button("打开所属任务", () => navigate(`/chat/${enc(sel.session.sessionId)}`)),
                ),
            ),
            h(
              "p",
              { className: "qa-page-note", key: "note" },
              selDirEntries
                ? `此目录共 ${selDirEntries.filter((e) => e.kind === "file").length} 个文件，点击条目继续进入或查看。`
                : "正在读取目录内容…",
            ),
            selDirEntries
              ? h(
                  "div",
                  { key: "list" },
                  ...selDirEntries.map((entry) =>
                    h(
                      "button",
                      {
                        key: entry.name,
                        className: "qa-art-tnode",
                        style: { paddingLeft: 0 },
                        onClick: () => clickNode(sel.session, sel.path, entry),
                        title: entry.name,
                      },
                      h("span", { className: "qa-art-ic" }, entry.kind === "dir" ? "📁" : "📄"),
                      h("span", { className: "qa-art-nm" }, entry.name),
                      entry.kind === "file" &&
                        h("span", { className: "qa-art-ttag" }, artKindOf(entry.name)),
                      h(
                        "span",
                        { className: "qa-art-sz" },
                        entry.kind === "file" ? sizeText(entry.sizeBytes || 0) : "",
                      ),
                    ),
                  ),
                )
              : null,
          ]
        : [
            h(
              "div",
              { className: "qa-library-heading", key: "head" },
              h("h2", { key: "t" }, sel.name),
              h(
                "div",
                { className: "qa-header-actions", key: "acts" },
                h(
                  "a",
                  {
                    className: "qa-button",
                    href: `/api/sessions/${enc(sel.session.sessionId)}/files/content?download=1&path=${enc(sel.path ? `${sel.path}/${sel.name}` : sel.name)}`,
                    download: sel.name,
                  },
                  "下载",
                ),
                button("打开所属任务", () => navigate(`/chat/${enc(sel.session.sessionId)}`)),
              ),
            ),
            h(
              "div",
              { className: "qa-art-meta-grid", key: "meta" },
              h("div", { key: "time" }, h("span", null, "生成时间"), h("b", null, sel.mtime ? dateText(sel.mtime) : "—")),
              h("div", { key: "task" }, h("span", null, "来源任务"), h("b", null, sel.session.title || sel.session.sessionId)),
              h("div", { key: "by" }, h("span", null, "生成者"), h("b", null, sel.session.agentId || "—")),
              h("div", { key: "kind" }, h("span", null, "类型"), h("b", null, artKindOf(sel.name))),
              h("div", { key: "size" }, h("span", null, "大小"), h("b", null, sizeText(sel.sizeBytes || 0))),
            ),
            h("div", { className: "qa-k-sec-title", key: "pt" }, "内容预览"),
            selIsImage || selIsVideo
              ? h(
                  "div",
                  { className: "qa-art-ph", key: "ph" },
                  h("span", { key: "ic" }, selIsVideo ? "🎬" : "🖼"),
                  h("span", { key: "tx" }, `${artKindOf(sel.name)}预览区：内嵌渲染暂未开放，可下载后在本地查看。`),
                )
              : preview?.loading
                ? h("p", { key: "pl", className: "qa-page-note" }, "正在读取文件内容…")
                : preview?.error
                  ? h("p", { key: "pe", role: "alert", className: "qa-page-error" }, preview.error)
                  : preview
                    ? h("pre", { key: "pv", className: "qa-k-prov qa-art-preview" }, preview.text || "（空文件）")
                    : h(
                        "p",
                        { key: "pb", className: "qa-page-note" },
                        "该文件类型暂不支持内嵌预览，可下载后在本地查看。",
                      ),
          ],
    );
    return h(
      "div",
      { className: "qa-library-content qa-art" },
      h(
        "div",
        { className: "qa-library-heading" },
        h("h2", null, "本地产物"),
        h(
          "div",
          { className: "qa-header-actions" },
          sel && button("打开所属任务", () => navigate(`/chat/${enc(sel.session.sessionId)}`)),
          button("⟳ 重新扫描", rescan),
        ),
      ),
      h(
        "p",
        { className: "qa-page-note" },
        "浏览各任务在工作文件夹中生成的产物文件，按任务批次与目录层级归档；资料保留在原位置。",
      ),
      !active.length
        ? h(
            "div",
            { className: "qa-page-empty" },
            h("p", null, "还没有可浏览的任务产物"),
            h("span", null, "完成任务后，其工作文件夹中的产物会出现在这里"),
          )
        : [
            h(
              "div",
              { className: "qa-art-toolbar", key: "tb" },
              h("input", {
                className: "qa-k-search",
                value: query,
                onChange: (e) => setQuery(e.target.value),
                placeholder: "搜索文件或目录名…",
                "aria-label": "搜索产物",
              }),
              h(
                "select",
                {
                  className: "qa-k-select",
                  "aria-label": "产物类型",
                  value: kind,
                  onChange: (e) => setKind(e.target.value),
                },
                h("option", { value: "" }, "全部类型"),
                ...ART_TYPE_LABELS.map((label) => h("option", { value: label, key: label }, label)),
              ),
              h(
                "span",
                { className: "qa-k-total" },
                `已加载 ${totalFiles} 个文件 · ${sizeText(totalBytes)} · ${roots.length} 个任务批次`,
              ),
              filtering &&
                h(
                  "span",
                  { className: "qa-k-total", key: "hint" },
                  "搜索与筛选覆盖已加载（展开过）的目录",
                ),
            ),
            errorBox(rootError || selError),
            h(
              "div",
              { className: "qa-art-split", key: "split" },
              h(
                "div",
                { className: "qa-art-tree-card" },
                rows.length
                  ? rows
                  : h(
                      "p",
                      { className: "qa-k-empty-list" },
                      "没有匹配的产物。搜索与筛选仅覆盖已加载的目录，可先展开目录再筛选。",
                    ),
              ),
              sel
                ? detail
                : h(
                    "div",
                    { className: "qa-art-detail" },
                    h(
                      "div",
                      { className: "qa-k-empty" },
                      h("span", null, "📁"),
                      h("span", null, "从左侧目录树选择一个文件或目录查看详情"),
                    ),
                  ),
            ),
          ],
    );
  }
  return SectionPage;
}
