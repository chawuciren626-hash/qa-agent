// Exercise the actual installed 0.2.16 server seams, without loading user data,
// contacting a model, launching commands, or starting the desktop application.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { installPenguinRuntime } from './install-penguin-runtime.mjs';

const app=process.argv[2];
if(!app || process.argv.length!==3) throw Error('Usage: node scripts/verify-penguin-host.mjs <resources/app>');
assert.equal(JSON.parse(readFileSync(resolve(app,'package.json'),'utf8')).version,'0.2.16');
assert.equal(installPenguinRuntime(app,resolve(import.meta.dirname,'..')).status,'installed');
const source=readFileSync(resolve(app,'dist/server.js'),'utf8');
function section(start,end) {
  assert.equal(source.split(start).length,2,`unique start: ${start}`);
  const from=source.indexOf(start),to=source.indexOf(end,from+start.length);
  assert.ok(to>from,`end: ${end}`);
  return source.slice(from,to);
}
const method=section('  sessionHooks(runner, installed2, spec) {','\n};');
const hook=(name,dir,command,options)=>({name,dir,command,options});
const hooks=new Function('sessionScratchpadDir','scriptPreToolUseHook','scriptStopHook','scriptUserPromptHook','remindToUpdate','userPromptTrigger',`return ({${method}}).sessionHooks;`)(()=>'/scratch',hook,hook,hook,()=>{},()=> 'every');
const owner={state:{root:'/data',projectId:'fixture',agentId:'test_case_agent'},pathPrepend:['/runtime'],confineSpawn:()=> 'confined'};
const packages=[{name:'qa-stage-boundary',dir:'/guard',version:'1',stop:[],user_prompt:[],pre_tool_use:[{command:'guard',timeout:12}]},{name:'other',dir:'/other',version:'1',stop:[{command:'stop'}],user_prompt:[{command:'prompt'}],pre_tool_use:[{command:'other'}]}];
for(const child of [{subagentDepth:1,source:'web'},{subagentDepth:0,source:'subagent'}]) {
  const result=hooks.call(owner,{},packages,{...child,sessionId:'child',workspaceDir:'/workspace'});
  assert.deepEqual(result.preToolUse.map(x=>x.name),['qa-stage-boundary']);
  assert.deepEqual(result.stop,[]);assert.deepEqual(result.userPrompt,[]);
  assert.equal(result.spawnSubagent,undefined);
  assert.equal(result.preToolUse[0].options.timeoutS,12);
  assert.equal(result.preToolUse[0].options.confineSpawn(),'confined');
  assert.equal(result.preToolUse[0].options.scope.workspaceDir,'/workspace');
  assert.deepEqual(result.preToolUse[0].options.pathPrepend,['/runtime']);
}
const parent=hooks.call(owner,{},packages,{subagentDepth:0,source:'web',sessionId:'parent',workspaceDir:'/workspace'});
assert.equal(parent.preToolUse.length,2);assert.equal(parent.stop.length,1);assert.equal(parent.userPrompt.length,1);
const selection=source.match(/^    const hookPackages = (.+);$/m)?.[1];
assert.ok(selection);
const loadHooks=new Function('child','state2','listInstalledHooks','root8','projectId','agentId',`return (async()=>(${selection}))();`);
assert.equal((await loadHooks(true,{systemConfig:{hooks:{enabled:false}}},async()=>packages)).length,2);
assert.equal((await loadHooks(false,{systemConfig:{hooks:{enabled:false}}},async()=>packages)).length,0);

const routes=section('  app.get("/:sessionId/files/evidence",','  registerWorkspaceFileRoutes(app, "/:sessionId/files",');
const registered=new Map();let opened=0,resolved=0;
class HttpError extends Error {constructor(status,code,message){super(message);this.status=status;this.code=code;}}
const deps={desktopMode:true,workspaceFiles:{resolvePath:async(workspace,path)=>{assert.equal(workspace,'/workspace');resolved++;return path;}}};
new Function('app','deps','resolveSession','HttpError','qaReadDeliveryEvidence','qaOpenDeliverable',routes)(
  {get:(path,fn)=>registered.set(path,fn),post:(path,fn)=>registered.set(path,fn)},deps,
  c=>{if(!c.allowed)throw new HttpError(404,'session_not_found');return {workspace:'/workspace'};},HttpError,
  ()=>({kind:'json',text:'{"fixture":true}'}),async()=>{opened++;}
);
const open=registered.get('/:sessionId/files/open-deliverable');
const context=(via,path,allowed=true)=>({allowed,var:{sessionVia:via},req:{query:()=>path},body:(_,status)=>status});
await assert.rejects(open(context('browser','output/runs/run-fixture/report/report.pdf')),e=>e.status===403);
await assert.rejects(open(context('desktop','../secret.pdf')),e=>e.status===400);
await assert.rejects(open(context('desktop','output/runs/run-fixture/report/report.exe')),e=>e.status===400);
await assert.rejects(open(context('desktop','output/runs/run-fixture/report/report.pdf',false)),e=>e.status===404);
assert.equal(opened,0);assert.equal(resolved,0);
assert.equal(await open(context('desktop','output/runs/run-fixture/report/report.pdf')),204);
assert.equal(opened,1);assert.equal(resolved,1);
console.log(JSON.stringify({status:'passed',version:'0.2.16',source:'installed server.js',checks:['installer hashes and idempotence','child pre-tool hook isolation','hook confinement and timeout','disabled parent hooks do not remove child boundary','session authorization','desktop-only document opening','document path and extension restrictions'],real_agent_verified:false}));
