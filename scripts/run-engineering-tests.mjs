import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync, readdirSync, createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { within } from './application-data.mjs';
import { probePython } from './command-runtime.mjs';
import { packageMetadata } from './runtime-dependencies.mjs';

export function prepareTestWorkspace(engine) {
  const parent=realpathSync(tmpdir());
  const base=realpathSync(mkdtempSync(resolve(parent,'qa-engineering-')));
  const root=resolve(base,'engine');mkdirSync(root);
  // Copy source, never copy business output, credentials, or the installed application's data.
  const directories=['scripts','schemas','skills','penguin','acceptance','benchmarks','tests/acceptance','.github'];
  for(const name of directories) cpSync(resolve(engine,name),resolve(root,name),{recursive:true,filter:path=>{
    if(lstatSync(path).isSymbolicLink()) throw new Error('Test source may not contain links');
    return !path.split(/[\\/]/).includes('__pycache__');
  }});
  mkdirSync(resolve(root,'config'));
  for(const name of ['test-delivery-template.json','project.json','orchestration-workflow.json','quality-governance.json','test-selection-policy.json','session-workspaces.json','test-assets.example.json','test-env.example.json','test-environments.example.json']) cpSync(resolve(engine,'config',name),resolve(root,'config',name));
  cpSync(resolve(engine,'config/test-assets.example.json'),resolve(root,'config/test-assets.json'));
  for(const file of ['package.json','package-lock.json','README.md','.gitignore','playwright.config.ts','tsconfig.playwright.json','requirements-ci.txt']) cpSync(resolve(engine,file),resolve(root,file));
  for(const name of ['inputs','output','tests/generated']) mkdirSync(resolve(root,name),{recursive:true});
  for(const name of ['temp','app-data','workspaces','agents']) mkdirSync(resolve(base,name));
  const settings=JSON.parse(readFileSync(resolve(root,'config/session-workspaces.json'),'utf8'));
  settings.default_workspace=resolve(base,'workspaces');
  writeFileSync(resolve(root,'config/session-workspaces.json'),JSON.stringify(settings,null,2));
  symlinkSync(realpathSync(resolve(engine,'node_modules')),resolve(root,'node_modules'),'junction');
  const env={...process.env,TEMP:resolve(base,'temp'),TMP:resolve(base,'temp'),TMPDIR:resolve(base,'temp'),QA_APP_DATA_ROOT:resolve(base,'app-data'),PENGUIN_AGENT_ROOT:resolve(base,'agents'),PYTHONDONTWRITEBYTECODE:'1'};
  delete env.QA_DIRECTORY_CONTEXT;
  delete env.NODE_TEST_CONTEXT;
  for(const key of ['QA_BASE_URL','QA_RUN_DIR','QA_TEST_DIR','QA_CONTROLLER_SESSION','QA_CONFIRMATION_SOURCE_JSON','QA_TASK_COMMAND_ID','QA_EXECUTION_COMMAND_ID']) delete env[key];
  return {base,root,env,cleanup(){
    if(!within(parent,base) || base===parent || realpathSync(base)!==base || !base.startsWith(resolve(parent,'qa-engineering-'))) throw new Error('Refusing cleanup outside generated test workspace');
    // Node removes a junction itself, not its target. Only the generated base is removed.
    rmSync(base,{recursive:true,force:true,maxRetries:3,retryDelay:250});
  }};
}

export function selectEngineeringTests(engine, args) {
  const available=readdirSync(resolve(engine,'tests/acceptance')).filter(name=>/^[a-z0-9-]+\.test\.mjs$/.test(name)).sort().map(name=>`tests/acceptance/${name}`);
  let suite=null,list=false,coverage=false;const explicit=[];
  for(const arg of args) {
    if(arg==='--list' && !list) list=true;
    else if(arg==='--coverage' && !coverage) coverage=true;
    else if(arg.startsWith('--suite=') && suite===null) suite=arg.slice(8);
    else if(available.includes(arg) && !explicit.includes(arg)) explicit.push(arg);
    else throw new Error(`Unknown, duplicate or unavailable test argument: ${arg}`);
  }
  if(suite!==null && (!['all','core','browser'].includes(suite) || explicit.length)) throw new Error('Use one suite (all/core/browser) OR explicit test files');
  suite ??= explicit.length?'selected':'all';
  const browser=file=>['tests/acceptance/browser-task.test.mjs','tests/acceptance/browser-ui-assertions.test.mjs','tests/acceptance/browser-worker-exit.test.mjs','tests/acceptance/independent-task.test.mjs'].includes(file);
  const files=explicit.length?explicit:available.filter(file=>suite==='all' || (suite==='browser'?browser(file):!browser(file)));
  if(!files.length) throw new Error('Selected suite has no tests');
  return {suite,files,list,coverage};
}

export function engineeringEnvironment(engine, files, env=process.env) {
  const [major,minor]=process.versions.node.split('.').map(Number);
  if(major<20 || (major===20 && minor<11)) throw new Error('Engineering tests require Node.js >=20.11');
  const require=createRequire(resolve(engine,'package.json'));
  const packages=Object.fromEntries(['@playwright/test','ajv','xlsx','xmind'].map(name=>[name,packageMetadata(engine,name).version]));
  const git=spawnSync('git',['--version'],{encoding:'utf8',windowsHide:true,timeout:10000});
  if(git.status!==0) throw new Error('Git is required by engineering fixtures');
  const python=probePython(env);
  if(python.status!=='ready') throw new Error(python.reason);
  const childEnv={...env,QA_PYTHON:python.executable,PYTHONUTF8:'1'};
  let securityPython=null;
  if(files.includes('tests/acceptance/credential-protection.test.mjs')) {
    securityPython=env.QA_SECURITY_PYTHON || python.executable;
    const check=spawnSync(securityPython,['-c','import tomllib; import sys; print(sys.version.split()[0])'],{encoding:'utf8',windowsHide:true,timeout:15000});
    if(check.status!==0) throw new Error('Credential tests require Python 3.11+ with tomllib; set QA_SECURITY_PYTHON for this test process');
    childEnv.QA_SECURITY_PYTHON=securityPython;
  }
  return {env:childEnv,metadata:{node:process.version,platform:process.platform,packages,git:git.stdout.trim(),python:python.executable,security_python:securityPython}};
}

export async function runEngineeringTests(engine,args) {
  const selection=selectEngineeringTests(engine,args);
  if(selection.list) {console.log(JSON.stringify(selection,null,2));return 0;}
  const report=resolve(engine,'output/engineering-tests',`${new Date().toISOString().replace(/[:.]/g,'-')}-${randomUUID()}`);
  mkdirSync(report,{recursive:true});
  const summary={version:1,suite:selection.suite,files:selection.files,coverage_requested:selection.coverage,started_at:new Date().toISOString(),status:'preparing',exit_code:1,report_dir:report};
  let sandbox;
  try {
    const runtime=engineeringEnvironment(engine,selection.files);summary.runtime=runtime.metadata;
    sandbox=prepareTestWorkspace(engine);
    Object.assign(sandbox.env,{QA_PYTHON:runtime.env.QA_PYTHON,PYTHONUTF8:'1',...(runtime.env.QA_SECURITY_PYTHON?{QA_SECURITY_PYTHON:runtime.env.QA_SECURITY_PYTHON}:{})});
    console.log(JSON.stringify({test_workspace:sandbox.root,business_data_writes:false,report_dir:report}));
    summary.status='running';writeFileSync(resolve(report,'summary.json'),JSON.stringify(summary,null,2));
    const tap=createWriteStream(resolve(report,'results.tap'));
    const stderr=createWriteStream(resolve(report,'stderr.log'));
    let logError;
    const logs=[tap,stderr].map(stream=>new Promise(done=>{stream.once('finish',done);stream.on('error',error=>{logError=error;done();});}));
    const child=spawn(process.execPath,['--test',...(selection.coverage?['--experimental-test-coverage']:[]),'--test-concurrency=2','--test-reporter=tap','--test-reporter-destination=stdout','--test-reporter=junit',`--test-reporter-destination=${resolve(report,'results.xml')}`,...selection.files],{cwd:sandbox.root,env:sandbox.env,stdio:['ignore','pipe','pipe'],windowsHide:true});
    child.stdout.on('data',data=>{process.stdout.write(data);tap.write(data);});
    child.stderr.on('data',data=>{process.stderr.write(data);stderr.write(data);});
    try { summary.exit_code=await new Promise((done,reject)=>{child.once('error',reject);child.once('close',(code)=>done(code ?? 1));}); }
    finally {tap.end();stderr.end();await Promise.all(logs);}
    if(logError) throw logError;
    summary.status=summary.exit_code===0?'passed':'failed';
  } catch(error) {summary.status='error';summary.error=error.message;summary.exit_code=1;}
  finally {
    if(sandbox) {
      try {sandbox.cleanup();summary.workspace_removed=true;}
      catch(error) {summary.status='error';summary.cleanup_error=error.message;summary.exit_code=1;}
    }
    summary.finished_at=new Date().toISOString();
    writeFileSync(resolve(report,'summary.json'),JSON.stringify(summary,null,2));
    console.log(JSON.stringify(summary));
  }
  return summary.exit_code;
}

if(process.argv[1] && pathToFileURL(resolve(process.argv[1])).href===import.meta.url) {
  try {process.exitCode=await runEngineeringTests(resolve(import.meta.dirname,'..'),process.argv.slice(2));}
  catch(error) {console.error(error.message);process.exitCode=1;}
}
