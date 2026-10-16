// Exact anchors deliberately reject unknown host builds before writing installation files.
const factory = `let qaClientInstance;function qaClient(){return qaClientInstance??=createWorkspaceUI({React:f,useProject:rn,useSessions:jo,useAuth:vn,useNavigate:Yn,useLocation:Xa,FolderPicker:b0,Modal:Kt,AccountMenu:eL,LegacySidebar:QaLegacySidebar,notify:ft,reportError:ze,request:je,Markdown:pl})}function c9(props){return r.jsx(qaClient().Sidebar,props)}function QaHero(props){return r.jsx(qaClient().Hero,props)}function QaSessionContext(props){return r.jsx(qaClient().SessionContext,props)}function upe(){const view=new URLSearchParams(Xa().search).get("view");return view==="schedules"||view==="library"?r.jsx(qaClient().SectionPage,{view}):r.jsx(QaNativeChat,{})}`;
export const clientPatchPairs = [
  ["function upe(){", "function QaNativeChat(){"],
  [
    "function c9({onNavigate:e,onCollapse:t}){",
    "function QaLegacySidebar({onNavigate:e,onCollapse:t}){",
  ],
  [
    "function Pde({projectId:e,models:t,draftId:n}){",
    factory + "function Pde({projectId:e,models:t,draftId:n}){",
  ],
  [
    'f.useEffect(()=>{g&&a("/chat/new",{replace:!0})},[g,a]);',
    'const[qaScene,setQaScene]=f.useState(x.qaScene??0),qaProjectId=s.state?.qaProjectId===undefined?x.qaProjectId:s.state.qaProjectId;f.useEffect(()=>{g&&a("/chat/new",{replace:!0})},[g,a]);',
  ],
  [
    "const Be={text:L.current,workspace:k,approvalMode:j};",
    "const Be={text:L.current,workspace:k,approvalMode:j,qaProjectId,qaScene};",
  ],
  [
    "[Me,p,e,n,v,k,j,T,x.source]),Ve=f.useRef(_e)",
    "[Me,p,e,n,v,k,j,T,x.source,qaProjectId,qaScene]),Ve=f.useRef(_e)",
  ],
  [
    'typeof t.workspace=="string"&&(n.workspace=t.workspace);',
    'typeof t.workspace=="string"&&(n.workspace=t.workspace);typeof t.qaProjectId=="string"&&(n.qaProjectId=t.qaProjectId);Number.isInteger(t.qaScene)&&t.qaScene>=0&&t.qaScene<3&&(n.qaScene=t.qaScene);',
  ],
  [
    "await Rm(J,{input:Be,...tt?{goal:tt}:{}})",
    'await Rm(J,{input:[{type:"text",text:"测试场景："+qaScenes[qaScene].name},...Be],...tt?{goal:tt}:{}})',
  ],
  [
    "m(wt?.session??Ae.session),Ze(),GO(Ke.sessionId)",
    'm(wt?.session??Ae.session),(()=>{try{qaBindProject(e,p,qaProjectId,Ke.sessionId)}catch{ze("任务已发起，但项目归属保存失败；可在任务列表中继续")}})(),Ze(),GO(Ke.sessionId)',
  ],
  [
    "[e,v,j,T,k,x.source,m,Ze,a]),rt=f.useRef(null)",
    "[e,v,j,T,k,x.source,m,Ze,a,qaProjectId,qaScene,p]),rt=f.useRef(null)",
  ],
  [
    'className:"anim-fade flex min-h-0 flex-1 flex-col overflow-y-auto px-3 py-6 md:px-4"',
    'className:"qa-welcome anim-fade flex min-h-0 flex-1 flex-col overflow-y-auto px-3 py-6 md:px-4"',
  ],
  [
    'r.jsxs("div",{className:"mb-10 text-center",children:[r.jsx(PO,{className:"mx-auto mb-1 h-36 w-36 rounded-3xl"}),r.jsx("h1",{className:"text-3xl font-semibold tracking-tight text-gray-900 dark:text-gray-100",children:c.appName}),r.jsx("p",{className:"mt-2 text-base text-gray-400 dark:text-gray-500",children:c.chat.draftSubtitle}),r.jsx(Ude,{})]})',
    "r.jsx(QaHero,{controlRef:rt,scene:qaScene,onSceneChange:setQaScene,groupId:qaProjectId,workspace:k,onWorkspaceChange:pe})",
  ],
  [
    'className:"mt-6 space-y-1",children:[d4.map',
    'className:"qa-old-examples mt-6 space-y-1",children:[d4.map',
  ],
  [
    'className:"relative",ref:Ae,children:[Ve===',
    'className:"qa-composer relative",ref:Ae,children:[Ve===',
  ],
  [
    'return r.jsxs("div",{className:"flex h-full",children:[r.jsx("aside"',
    'return r.jsxs("div",{className:"qa-shell flex h-full",children:[r.jsx("aside"',
  ],
  [
    'className:"flex shrink-0 items-center gap-2.5 border-b border-gray-200 px-3 py-2 md:px-4 dark:border-gray-800",children:[r.jsxs("div",',
    'className:"qa-session-topbar flex shrink-0 items-center gap-2.5 border-b border-gray-200 px-3 py-2 md:px-4 dark:border-gray-800",children:[r.jsx(QaSessionContext,{session:pe,status:me.taskState,pending:me.pendingApprovals.size,error:me.error,items:Xe,onBack:aa}),r.jsxs("div",',
  ],
  [
    "max-w-[88%] rounded-lg bg-gray-100 px-4 py-2.5 md:max-w-[75%] dark:bg-gray-800",
    "qa-user-bubble max-w-[88%] rounded-lg bg-gray-100 px-4 py-2.5 md:max-w-[75%] dark:bg-gray-800",
  ],
  [
    'appName:"PenguinHarness",nav:{chat:"对话",newChat:"新对话"',
    'appName:"AITestHarness",nav:{chat:"任务",newChat:"新建任务"',
  ],
];
export function patchClientBundle(source) {
  let result = source;
  for (const [before, after] of clientPatchPairs) {
    if (result.split(before).length !== 2)
      throw new Error(
        `Unsupported client build: UI anchor not unique (${before.slice(0, 90)})`,
      );
    result = result.replace(before, after);
  }
  return (
    'import { createWorkspaceUI, qaBindProject, qaScenes } from "./qa-delivery-ui.js";\n' +
    result
  );
}
export function clientModule(delivery, workspace, css) {
  return `${delivery}\n${workspace}\nconst qaClientStyles = ${JSON.stringify(css)};\n`;
}
