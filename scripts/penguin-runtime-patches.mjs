import { patchDeliveryBundle216 } from './penguin-ui-0.2.16.mjs';

export function relocatedPatch(current, original, adapter) {
  const line=current.slice(0,current.indexOf('\n'));
  const prefix='import { applies as qaWorkspaceApplies, bindWorkspace as qaWorkspaceBind, workspaceEnv as qaWorkspaceEnv } from ';
  if (!line.startsWith(prefix) || !line.endsWith(';')) throw new Error('Unknown adapter import');
  const previous=JSON.parse(line.slice(prefix.length,-1));
  if (patchServer(original,previous)!==current) throw new Error('Installed patch recipe differs; refusing relocation');
  return {previous,next:patchServer(original,adapter)};
}

export function patchServer(source,adapter) {
  if(source.includes('qaWorkspaceBind')) throw new Error('Adapter already present; check installation record');
  let patched=source;
  const replace=(before,after)=>{
    if(patched.split(before).length!==2) throw new Error('Installed runtime is incompatible: patch anchor not unique');
    patched=patched.replace(before,after);
  };
  replace('    let workspaceDir2;\n    if (opts.workspaceDir) {','    let workspaceDir2;\n    if (qaWorkspaceApplies(this.state, opts)) {\n      workspaceDir2 = opts.workspaceDir;\n    } else if (opts.workspaceDir) {');
  replace('    const sessionId = formatSessionId();\n    const spec = {','    const sessionId = formatSessionId();\n    workspaceDir2 = qaWorkspaceBind(this.state, opts, sessionId, workspaceDir2);\n    const spec = {');
  replace('        controlEnv: () => this.controlEnv({\n          projectId: this.state.projectId,\n          agentId: this.state.agentId,\n          sessionId\n        })\n      } : {},',
    '        controlEnv: () => ({...this.controlEnv({\n          projectId: this.state.projectId,\n          agentId: this.state.agentId,\n          sessionId\n        }), ...qaWorkspaceEnv(workspaceDir2, sessionId, spec.source)})\n      } : {controlEnv: () => qaWorkspaceEnv(workspaceDir2, sessionId, spec.source)},');
  return `import { applies as qaWorkspaceApplies, bindWorkspace as qaWorkspaceBind, workspaceEnv as qaWorkspaceEnv } from ${JSON.stringify(adapter)};\n`+patched;
}

function replaceOnce(source,before,after) {
  if(source.split(before).length!==2) throw new Error(`Unsupported PenguinHarness build: anchor not unique (${before.slice(0,60)})`);
  return source.replace(before,after);
}

export function patchDeliveryBundle(source,revision='1') {
  if(source.includes('function NC({item:e,ctx:t,last:n=!1}){')) return patchDeliveryBundle216(source,revision);
  if(!/^[a-f0-9]+$/.test(revision)) throw new Error('Invalid UI revision');
  let next=source;
  next=replaceOnce(next,'function lO({item:e,ctx:t}){',
    'const QaDeliveryMessage=createDeliveryUI({React:f,jsx:r.jsx,jsxs:r.jsxs,Markdown:pl,Icon:Ie,fileIcon:tx});function lO({item:e,ctx:t}){');
  next=replaceOnce(next,'case"assistant_text":return r.jsxs("div",{className:"md-body anim-msg my-3',
    'case"assistant_text":if(t.qaPresentation)return r.jsx(QaDeliveryMessage,{item:e,ctx:t});return r.jsxs("div",{className:"md-body anim-msg my-3');
  next=replaceOnce(next,'function Ale({items:e,ctx:t}){const n=[];','function Ale({items:e,ctx:t}){const n=t.qaPresentation?groupDeliveryItems(e):[];');
  next=replaceOnce(next,'for(const p of e)Cle(p)?a.push(p):(s(),n.push({type:"single",item:p}));s();',
    'for(const p of t.qaPresentation?[]:e)Cle(p)?a.push(p):(s(),n.push({type:"single",item:p}));s();');
  next=replaceOnce(next,'o=Tle(e,t),[l,d]=f.useState(s),m=f.useRef(!1),p=f.useRef(null);f.useEffect(()=>{m.current||d(s)},[s]);',
    'o=Tle(e,t),[l,d]=f.useState(t.qaPresentation?!1:s),m=f.useRef(!1),p=f.useRef(null);f.useEffect(()=>{m.current||d(t.qaPresentation?!1:s)},[s,t.qaPresentation]);');
  next=replaceOnce(next,'children:s?c.chat.workRunning:c.chat.workDone}),x>0',
    'children:t.qaPresentation?(s?"正在处理 · 执行详情":"执行详情"):s?c.chat.workRunning:c.chat.workDone}),x>0');
  next=replaceOnce(next,'t.origin.length===0&&t.onOpenFile&&t.statFiles&&e.assistantText.trim()!==""&&r.jsx(gN',
    '!t.qaPresentation&&t.origin.length===0&&t.onOpenFile&&t.statFiles&&e.assistantText.trim()!==""&&r.jsx(gN');
  next=replaceOnce(next,'workspace:pe?.workspace??null,statFiles:ms,onFork:io}',
    'workspace:pe?.workspace??null,sessionId:pe?.sessionId??null,qaPresentation:["test_agent","requirement_analysis_agent","test_point_agent","test_case_agent","automation_execution_agent","defect_analysis_agent","test_report_agent"].includes(pe?.agentId),statFiles:ms,onFork:io}');
  return `import { createDeliveryUI, groupDeliveryItems } from "./qa-delivery-ui.js?v=${revision}";\n`+next;
}

export function patchDeliveryServer(source,moduleUrl,version='0.2.13') {
  if(source.includes('qaOpenDeliverable')) throw new Error('Delivery adapter already present');
  const anchor=version==='0.2.16'?'  registerWorkspaceFileRoutes(app, "/:sessionId/files", deps, (c22) => resolveSession(c22).workspace);':'  app.post("/:sessionId/files/reveal", async (c7) => {';
  const route=`  app.get("/:sessionId/files/evidence", async (c7) => {
    const row = resolveSession(c7);
    const rel = c7.req.query("path") ?? "";
    let evidence;
    try { evidence = qaReadDeliveryEvidence(row.workspace, rel); }
    catch { throw new HttpError(400,"evidence_unavailable","Evidence is missing, restricted, invalid or too large."); }
    if (c7.req.query("download") === "1" && evidence.kind === "json") return new Response(evidence.text, { headers: {
      "Content-Type":"application/json; charset=utf-8", "Content-Disposition":"attachment; filename*=UTF-8''"+encodeURIComponent(rel.split("/").pop()),
      "X-Content-Type-Options":"nosniff", "Cache-Control":"no-store", "Content-Security-Policy":"sandbox"
    }});
    c7.header("Cache-Control","no-store");
    return c7.json(evidence);
  });
  app.post("/:sessionId/files/open-deliverable", async (c7) => {
    const row = resolveSession(c7);
    if (!deps.desktopMode || c7.var.sessionVia !== "desktop") throw new HttpError(403, "desktop_shell_only", "Open documents from the desktop application.");
    const rel = c7.req.query("path") ?? "";
    if (!/^output\\/runs\\/run-[a-zA-Z0-9-]+\\/(?:design|report)\\/[^/\\\\]+\\.(?:xlsx|docx|xmind|pdf)$/i.test(rel)) throw new HttpError(400,"unsupported_document","Not a supported delivery document.");
    const file = await deps.workspaceFiles.resolvePath(row.workspace, rel);
    try { await qaOpenDeliverable(file); }
    catch (error) {
      if (error.code === "QA_DOCUMENT_OPEN_TIMEOUT") throw new HttpError(504,"document_open_timeout","Opening timed out; check the desktop before trying again.");
      throw new HttpError(502,"document_open_failed","The document application could not be opened.");
    }
    return c7.body(null, 204);
  });
`;
  return `import { openDeliverable as qaOpenDeliverable, readDeliveryEvidence as qaReadDeliveryEvidence } from ${JSON.stringify(moduleUrl)};\n`+replaceOnce(source,anchor,route+anchor);
}
