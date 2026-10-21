// Recipes inspected against the signed Windows v0.2.16 release.
// Each anchor must occur exactly once; no fuzzy rewriting of unknown builds.
const replace = (source, before, after) => {
  if (source.split(before).length !== 2) throw new Error(`Unsupported PenguinHarness 0.2.16 UI anchor: ${before.slice(0,100)}`);
  return source.replace(before, after);
};
const qaAgents = '["test_agent","requirement_analysis_agent","test_point_agent","test_case_agent","automation_execution_agent","defect_analysis_agent","test_report_agent"]';

export function patchDeliveryBundle216(source, revision='1') {
  if(!/^[a-f0-9]+$/.test(revision)) throw new Error('Invalid UI revision');
  const pairs = [
    ['function NC({item:e,ctx:t,last:n=!1}){', 'const QaDeliveryMessage=createDeliveryUI({React:f,jsx:s.jsx,jsxs:s.jsxs,Markdown:Dd,Icon:xe,fileIcon:G.file});function NC({item:e,ctx:t,last:n=!1}){'],
    ['case"assistant_text":return s.jsxs(bwe,', 'case"assistant_text":if(t.qaPresentation)return s.jsx(QaDeliveryMessage,{item:e,ctx:t});return s.jsxs(bwe,'],
    ['function x$e({items:e,ctx:t}){const n=[];', 'function x$e({items:e,ctx:t}){const n=t.qaPresentation?groupDeliveryItems(e):[];'],
    ['for(const b of e)$Re(b)?r.push(b):(a(),n.push({type:"single",item:b}));a();', 'for(const b of t.qaPresentation?[]:e)$Re(b)?r.push(b):(a(),n.push({type:"single",item:b}));a();'],
    ['return s.jsx(zh,{...r,rows:e.map(a=>({key:a.id,content:s.jsx(NC,{item:a,ctx:t})}))})', 'return s.jsx(zh,{...r,...t.qaPresentation?{qaCollapsed:!0,title:r.state==="running"?"正在处理 · 执行详情":"执行详情"}:{},rows:e.map(a=>({key:a.id,content:s.jsx(NC,{item:a,ctx:t})}))})'],
    ['durationMs:h,pending:p=!1,rows:g,children:y}){const v=lN(t)', 'durationMs:h,pending:p=!1,rows:g,children:y,qaCollapsed:qa=!1}){const v=lN(t)'],
    ['[S,j]=f.useState(b),T=f.useRef(!1),C=f.useRef(!1)', '[S,j]=f.useState(qa?!1:b),T=f.useRef(!1),C=f.useRef(!1)'],
    ['f.useEffect(()=>{T.current||j(b)},[b]);', 'f.useEffect(()=>{T.current||j(qa?!1:b)},[b,qa]);'],
    ['t.origin.length===0&&t.onOpenFile&&t.statFiles&&e.assistantText.trim()!==""&&s.jsx(A_', '!t.qaPresentation&&t.origin.length===0&&t.onOpenFile&&t.statFiles&&e.assistantText.trim()!==""&&s.jsx(A_'],
    ['workspace:pe?.workspace??null,statFiles:jo,onFork:la,a2uiActions:Ma}', `workspace:pe?.workspace??null,sessionId:pe?.sessionId??null,qaPresentation:${qaAgents}.includes(pe?.agentId),statFiles:jo,onFork:la,a2uiActions:Ma}`],
  ];
  for(const [before,after] of pairs) source=replace(source,before,after);
  return `import { createDeliveryUI, groupDeliveryItems } from "./qa-delivery-ui.js?v=${revision}";\n`+source;
}

// Reuse the host's navigation rows, badges, permissions, pin preferences and fold
// animation without mounting its legacy workspace/session sidebar a second time.
export const sidebarTools216 = `function QaSidebarTools({onNavigate}) {
  const {user}=Kn(), location=aa(), notices=cm();
  const [collapsed,setCollapsed]=f.useState(BCe), [pins,setPins]=f.useState(qCe);
  const toggleRef=f.useRef(null);
  const allowed=wJ(user?.isAdmin===true).filter(key=>["plugins","machines","usage","benchmark"].includes(key));
  const groups=zCe(allowed,pins);
  const row=key=>{
    const href="/"+key, label=l.nav[key], note=WJ(notices,href), pinned=q5(key,pins);
    return s.jsx(P4e,{label,glyph:ka[key],href,active:m8(href,location.pathname),renderLink:h8,
      className:"qa-tool-link",onClick:()=>onNavigate?.(),
      pin:{pinned,label:pinned?l.nav.unpinEntry:l.nav.pinEntry,tooltip:pinned?l.nav.unpinEntry:l.nav.pinEntry,
        onToggle:()=>{const next=FCe(pins,key,!pinned);VCe(next);setPins(next);requestAnimationFrame(()=>toggleRef.current?.focus())}},
      ...note!==null?{ariaLabel:label+" · "+note,tooltip:note,badge:s.jsx(xd,{size:"inline",position:"right-2.5 top-1/2 -translate-y-1/2"})}:{}
    },key);
  };
  return s.jsx(D4e,{collapsed,onToggle:()=>{HCe(!collapsed);setCollapsed(!collapsed)},
    expandLabel:l.nav.expandGroup,collapseLabel:l.nav.collapseGroup,toggleRef,
    pinned:groups.pinned.length?s.jsx(ED,{children:groups.pinned.map(row)}):undefined,
    foldable:groups.collapsible.length>0,children:groups.collapsible.map(row)});
}`;
const factory = sidebarTools216 + `let qaClientInstance;function qaClient(){return qaClientInstance??=createWorkspaceUI({React:f,useProject:On,useSessions:So,useAuth:Kn,useNavigate:Cr,useLocation:aa,FolderPicker:dm,Modal:pn,AccountMenu:Bse,SidebarTools:QaSidebarTools,notify:kt,reportError:Pe,request:ge,Markdown:Dd})}function PF(props){return s.jsx(qaClient().Sidebar,props)}function QaHero(props){return s.jsx(qaClient().Hero,props)}function QaSessionContext(props){return s.jsx(qaClient().SessionContext,props)}function vqe(){const view=new URLSearchParams(aa().search).get("view");return view==="schedules"||view==="library"?s.jsx(qaClient().SectionPage,{view}):s.jsx(QaNativeChat,{})}`;

export function patchClientBundle216(source) {
  const pairs = [
    ['function PF({onNavigate:e,onCollapse:t,initialSearchOpen:n=!1}){', 'function QaLegacySidebar({onNavigate:e,onCollapse:t,initialSearchOpen:n=!1}){'],
    ['function vqe(){', 'function QaNativeChat(){'],
    ['function MFe({projectId:e,models:t,draftId:n,composerRef:r,onWorkspaceChange:a,onAgentChange:o}){', factory+'function MFe({projectId:e,models:t,draftId:n,composerRef:r,onWorkspaceChange:a,onAgentChange:o}){'],
    ['f.useEffect(()=>{S&&i("/chat/new",{replace:!0})},[S,i]);', 'const[qaScene,setQaScene]=f.useState(j.qaScene??0),qaProjectId=c.state?.qaProjectId===undefined?j.qaProjectId:c.state.qaProjectId;f.useEffect(()=>{S&&i("/chat/new",{replace:!0})},[S,i]);'],
    ['const[T,C]=f.useState(j.agentId??null),[A,I]=f.useState(j.workspace??"")', 'const T=d.some(agent=>agent.agentId==="test_agent")?"test_agent":null,C=()=>{},[A,I]=f.useState(j.workspace??"")'],
    ['const pe={text:_.current,workspace:A,approvalMode:H};', 'const pe={text:_.current,workspace:A,approvalMode:H,qaProjectId,qaScene};'],
    ['[Ke,k,e,n,T,A,N,H,V,q]),Lt=f.useRef(mt)', '[Ke,k,e,n,T,A,N,H,V,q,qaProjectId,qaScene]),Lt=f.useRef(mt)'],
    ['typeof t.workspace=="string"&&(n.workspace=t.workspace),typeof t.machineId', 'typeof t.workspace=="string"&&(n.workspace=t.workspace),(t.qaProjectId===null||typeof t.qaProjectId=="string")&&(n.qaProjectId=t.qaProjectId),Number.isInteger(t.qaScene)&&t.qaScene>=0&&t.qaScene<3&&(n.qaScene=t.qaScene),typeof t.machineId'],
    ['rn=f.useCallback(async(pe,Yt=null)=>{if(!T||un.current)return!1;', 'rn=f.useCallback(async(pe,Yt=null)=>{if(!T){Pe("软件测试智能体尚未就绪，请刷新后重试");return!1}if(un.current)return!1;'],
    ['await yh(wn,{input:pe,...Yt?{goal:Yt}:{}})', 'await yh(wn,{input:qaScenesEnabled?[{type:"text",text:"测试场景："+qaScenes[qaScene].name},...pe]:pe,...Yt?{goal:Yt}:{}})'],
    ['b(de?.session??{...at.session,sessionId:Pt.sessionId}),ft(),Xee(Pt.sessionId)', 'b(de?.session??{...at.session,sessionId:Pt.sessionId}),qaCompleteFirstRun(e,k),(()=>{try{qaBindProject(e,k,qaProjectId,Pt.sessionId)}catch{Pe("任务已发起，但项目归属保存失败；可在任务列表中继续")}})(),ft(),Xee(Pt.sessionId)'],
    ['[e,T,H,V,q,A,N,b,ft,i]),Re=f.useRef(null)', '[e,T,H,V,q,A,N,b,ft,i,qaProjectId,qaScene,k]),Re=f.useRef(null)'],
    ['s.jsxs("div",{className:"mt-2 flex flex-wrap items-center gap-2",children:[s.jsx(Q_e,{agents:R,selected:Ct,onSelect:cn,empty:J_e(L,y)}),s.jsx(dm,{projectId:e,workspace:A,machineId:N,onChange:Dn,chooseMachine:!0,...T?{agentId:T}:{}}),s.jsx(TFe,{available:A.trim()!==""})]})', 'null'],
    ['className:"anim-fade flex min-h-0 flex-1 flex-col overflow-y-auto px-3 py-6 md:px-4"', 'className:"qa-welcome anim-fade flex min-h-0 flex-1 flex-col overflow-y-auto px-3 py-6 md:px-4"'],
    ['s.jsx(eFe,{projectId:e,composer:Nn,skillsLoaded:$e,fill:vt,readComposerText:Be})', 's.jsxs(s.Fragment,{children:[s.jsx(QaHero,{controlRef:He,scene:qaScene,onSceneChange:setQaScene,groupId:qaProjectId,workspace:A,onWorkspaceChange:Dn,onProjectChange:group=>{const workspace=group?.folders[0]??"";Dn(workspace,null);i(c.pathname+c.search,{replace:!0,state:{...c.state,qaProjectId:group?.id??null,workspace,machineId:null}})}}),s.jsx("div",{className:"qa-composer",children:Nn})]})'],
    ['pe&&s.jsxs("div",{className:"flex shrink-0 items-center gap-2 border-b border-gray-200 px-3 py-2 md:px-4 dark:border-gray-800",children:[s.jsxs("div",', 'pe&&s.jsxs("div",{className:"qa-session-topbar flex shrink-0 items-center gap-2 border-b border-gray-200 px-3 py-2 md:px-4 dark:border-gray-800",children:[s.jsx(QaSessionContext,{session:pe,status:Fe.taskState,pending:Fe.pendingApprovals.size,error:Fe.error,items:zt,onBack:()=>e("/chat/new")}),s.jsxs("div",'],
    ['const Ax="/penguin-logo.svg";', 'const Ax=qaBrandLogo;'],
    ['appName:"PenguinHarness",nav:{chat:"对话",newChat:"新建对话"', 'appName:"AITestHarness",nav:{chat:"任务",newChat:"新建任务"'],
  ];
  for(const [before,after] of pairs) source=replace(source,before,after);
  return 'import { createWorkspaceUI, qaBindProject, qaCompleteFirstRun, qaScenes, qaScenesEnabled, qaBrandLogo } from "./qa-delivery-ui.js";\n'+source;
}
