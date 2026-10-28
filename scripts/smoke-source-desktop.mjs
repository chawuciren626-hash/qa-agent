/** Exercises only an isolated staged desktop; smoke mode quits normally after page load. */
import {spawn} from 'node:child_process';
import {mkdirSync,writeFileSync,existsSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {loadProductLayout,productEnvironment} from './product-layout.mjs';
import {checkSourceRuntime} from './source-runtime.mjs';

const [config,resultFile]=process.argv.slice(2).map(p=>resolve(p));
if(!config||!resultFile) throw Error('Usage: smoke-source-desktop.mjs <fresh-stage/installation.json> <result.json>');
const layout=loadProductLayout(config);
checkSourceRuntime(layout.host_app,layout.paths.engine);
if(existsSync(layout.paths.host_data)||existsSync(layout.paths.desktop_profile)) throw Error('Smoke requires unused isolated data directories');
for(const key of ['host_data','qa_data','desktop_profile','workspaces']) mkdirSync(layout.paths[key],{recursive:true});
mkdirSync(dirname(resultFile),{recursive:true});
let result=null;
const child=spawn(layout.paths.host_executable,[],{cwd:dirname(layout.paths.host_executable),windowsHide:true,env:{...productEnvironment(layout),AITEST_INSTALLATION_CONFIG:config,AITEST_ENGINE_ROOT:layout.paths.engine,AITEST_MANAGED_RUNTIME:'1',PENGUIN_DESKTOP_SMOKE:'1',PENGUIN_DESKTOP_SMOKE_SHOT:resultFile+'.png'},stdio:['ignore','pipe','pipe']});
let pending='';
child.stdout.on('data',chunk=>{pending+=String(chunk); const lines=pending.split(/\r?\n/); pending=lines.pop(); for(const line of lines) if(line.startsWith('DESKTOP-SMOKE-RESULT ')) { const raw=JSON.parse(line.slice('DESKTOP-SMOKE-RESULT '.length)); result={title:raw.title,embedded:raw.embedded,origin:raw.origin,error:raw.error}; }});
// Full startup logs can include first-admin claim links; the desktop keeps those locally.
child.stderr.resume();
child.once('error',error=>{writeFileSync(resultFile,JSON.stringify({status:'failed',error:error.message}));process.exitCode=1;});
child.once('exit',code=>{const ok=code===0&&result?.embedded===true&&result?.title?.includes('AITestHarness')&&!result?.error; const report={status:ok?'passed':'failed',exit_code:code,...result};writeFileSync(resultFile,JSON.stringify(report,null,2));console.log(JSON.stringify(report));process.exitCode=ok?0:1;});
