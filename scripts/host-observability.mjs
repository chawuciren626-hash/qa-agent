import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { directoryContext } from './directory-context.mjs';
import { protectedInputs } from './protected-inputs.mjs';

const engine=resolve(import.meta.dirname,'..'),processId=randomUUID(),epoch=performance.now();

function workspaceOwner(workspace) {
  if(!workspace || !existsSync(resolve(workspace,'.qa-session.json'))) return null;
  const context=directoryContext(engine,{QA_DIRECTORY_CONTEXT:readFileSync(resolve(workspace,'.qa-session.json'),'utf8')});
  if(context.session_root!==resolve(workspace)) throw new Error('Host workspace binding mismatch');
  return context.session_id;
}

export function protectHostInput(workspace,input) {
  const owner=workspaceOwner(workspace);
  return owner?protectedInputs().protect(owner,input):input;
}

// Buffer a bounded tool unit before any head/tail archive: a credential can span chunks.
export async function* protectHostToolStream(gen,workspace,{store=protectedInputs,limit=16*1024*1024}={}) {
  const owner=workspaceOwner(workspace);
  if(!owner) return yield* gen;
  let pending='',overflow=false;
  const clean=value=>store().protect(owner,value);
  try {
    for(;;) {
      const step=await gen.next();
      if(step.done) {
        if(pending || overflow) yield {type:'model_msg',payload:{type:'partial_tool_call_output',event_type:'delta',output:overflow?'[Output withheld: protected stream limit]':clean(pending)}};
        return step.value?clean(step.value):step.value;
      }
      const out=step.value,p=out?.payload;
      if(out?.origin?.length) {yield out;continue;}
      if(p?.type==='partial_tool_call_output' && p.event_type==='delta' && typeof p.output==='string') {
        if(!overflow) {if(pending.length+p.output.length>limit) {pending='';overflow=true;} else pending+=p.output;}
      } else if(p?.type==='tool_call_output') {
        pending='';overflow=false;out.payload=clean(p);yield out;
      } else yield out;
    }
  } catch {throw new Error('Protected tool output unavailable; original error text withheld');}
  finally {await gen.return?.();}
}

export function createHostBoundary(workspace,sessionId,{store=protectedInputs,clock=()=>performance.now()-epoch,processIdentity=processId}={}) {
  const owner=workspaceOwner(workspace);
  if(!owner) return {record:msg=>msg};
  let request=null;const tools=new Map();
  return {record(msg) {
    if(!msg || (msg.origin?.length ?? 0)>0) return msg;
    const offset=clock(),p=msg.payload ?? {};
    // Protect the same message instance before execution, not only its disk copy.
    if(msg.type==='model_msg') Object.assign(p,store().protect(owner,p));
    const timing={version:1,process_id:processIdentity,owner_session_id:owner,session_id:sessionId,offset_ms:offset};
    if(p.type==='request_begin') {request={id:randomUUID(),start:offset};timing.request_id=request.id;}
    else if(p.type==='request_end') {
      if(request) {timing.request_id=request.id;timing.model_request_ms=Math.max(0,offset-request.start);}
      request=null;
    } else if(request) timing.request_id=request.id;
    if(p.type==='tool_call' && typeof p.tool_call_id==='string') tools.set(p.tool_call_id,{received:offset,ready:null});
    if(p.type==='approval_decision' && tools.has(p.tool_call_id)) {
      const tool=tools.get(p.tool_call_id);tool.ready=offset;
      timing.tool_preparation_ms=Math.max(0,offset-tool.received);
    }
    if(p.type==='tool_call_output' && tools.has(p.tool_call_id)) {
      const tool=tools.get(p.tool_call_id);
      timing.tool_total_ms=Math.max(0,offset-tool.received);
      timing.tool_execution_ms=tool.ready===null?null:Math.max(0,offset-tool.ready);
      tools.delete(p.tool_call_id);
    }
    msg.qa_timing=timing;return msg;
  }};
}

export function patchHostObservability(source,moduleUrl) {
  let next=source;
  const replace=(before,after)=>{if(next.split(before).length!==2) throw new Error('Unsupported host privacy/timing anchor: '+before.slice(0,65));next=next.replace(before,after);};
  replace('  constructor(opts) {\n    this.tracesDir = opts.tracesDir;', '  constructor(opts) {\n    this.qaBoundary = qaCreateHostBoundary(opts.qaWorkspace, opts.sessionId);\n    this.tracesDir = opts.tracesDir;');
  replace('    if (!isRecordable(msg2)) return;\n    return this.enqueue(async () => {','    if (!isRecordable(msg2)) return;\n    this.qaBoundary.record(msg2);\n    return this.enqueue(async () => {');
  replace('      tracesDir: tracesDir(this.state.root, this.state.projectId, this.state.agentId),\n      sessionId\n    });','      tracesDir: tracesDir(this.state.root, this.state.projectId, this.state.agentId),\n      qaWorkspace: spec.workspaceDir,\n      sessionId\n    });');
  replace('      tracesDir: dir,\n      sessionId,\n      dateDir: located.dateDir,','      tracesDir: dir,\n      qaWorkspace: spec.workspaceDir,\n      sessionId,\n      dateDir: located.dateDir,');
  replace('        session = manager.spawn({ cmd, cwd: workdir });','        session = manager.spawn({ cmd, cwd: workdir, qaToolCallId: toolCallId });');
  replace('        ...this.controlEnv?.() ?? {},\n        ...HARDENED_ENV','        ...this.controlEnv?.() ?? {},\n        QA_HOST_TOOL_CALL_ID: typeof opts.qaToolCallId === "string" ? opts.qaToolCallId : "",\n        ...HARDENED_ENV');
  replace('    const gen = tool.execute(args2, {','    const gen = qaProtectToolStream(tool.execute(args2, {');
  replace('      ...request.approve ? { approve: request.approve } : {}\n    });\n    try {','      ...request.approve ? { approve: request.approve } : {}\n    }), this.workspaceDir);\n    try {');
  replace('      const entry = await this.ensureEntry(sessionId);\n      if (isHumanInput(input))', '      const entry = await this.ensureEntry(sessionId);\n      input = qaProtectHostInput(entry.session.metaMessage?.payload?.workspace, input);\n      if (opts?.recall) opts = {...opts, recall: qaProtectHostInput(entry.session.metaMessage?.payload?.workspace, opts.recall)};\n      if (isHumanInput(input))');
  replace('    const capture = !this.titleMaterialFrozen;', '    newMessages = qaProtectHostInput(this.metaMessage?.payload?.workspace, newMessages);\n    const capture = !this.titleMaterialFrozen;');
  return `import { createHostBoundary as qaCreateHostBoundary, protectHostToolStream as qaProtectToolStream, protectHostInput as qaProtectHostInput } from ${JSON.stringify(moduleUrl)};\n`+next;
}

export const hostPatchAnchors=[
  '  constructor(opts) {\n    this.tracesDir = opts.tracesDir;',
  '    if (!isRecordable(msg2)) return;\n    return this.enqueue(async () => {',
  '      tracesDir: tracesDir(this.state.root, this.state.projectId, this.state.agentId),\n      sessionId\n    });',
  '      tracesDir: dir,\n      sessionId,\n      dateDir: located.dateDir,',
  '        session = manager.spawn({ cmd, cwd: workdir });',
  '        ...this.controlEnv?.() ?? {},\n        ...HARDENED_ENV',
  '    const gen = tool.execute(args2, {',
  '      ...request.approve ? { approve: request.approve } : {}\n    });\n    try {',
  '      const entry = await this.ensureEntry(sessionId);\n      if (isHumanInput(input))',
  '    const capture = !this.titleMaterialFrozen;'
];
