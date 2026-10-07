import { createAcceptanceServer } from '../acceptance/server.mjs';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const prefix = process.argv.find(arg => arg.startsWith('--prefix='))?.slice(9) ?? `run-acceptance-${Date.now()}`;
if (!/^run-[A-Za-z0-9-]+$/.test(prefix)) throw new Error('Invalid prefix');
const server = createAcceptanceServer();
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const execute = (script, args) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [script, ...args], {cwd:root, windowsHide:true});
  let output='';
  child.stdout.on('data', data => { output += data; process.stdout.write(data); });
  child.stderr.on('data', data => { output += data; process.stderr.write(data); });
  const timer = setTimeout(() => child.kill(), 180000);
  child.on('error', error => {clearTimeout(timer);reject(error);});
  child.on('close', code => {clearTimeout(timer);resolve({code,output});});
});
const checks=[];
try {
  for (const scenario of ['healthy','defect','unavailable']) {
    const runId=`${prefix}-${scenario}`;
    const prepared=await execute('scripts/prepare-acceptance.mjs',[`--run-id=${runId}`,`--scenario=${scenario}`,`--port=${port}`]);
    if (prepared.code !== 0) throw new Error('Acceptance preparation failed');
    const execution=await execute('scripts/run-ui-tests.mjs',[`--run-id=${runId}`]);
    writeFileSync(resolve(root,'output/runs',runId,'execution/runner.log'),execution.output);
    const verified=await execute('scripts/verify-acceptance.mjs',[`--run-id=${runId}`]);
    const evidence=await execute('scripts/assess-execution-evidence.mjs',[`--run-id=${runId}`]);
    checks.push({run_id:runId,scenario,execution_exit:execution.code,verified:verified.code===0,evidence_exit:evidence.code});
  }
} finally { await new Promise(resolve=>server.close(resolve)); }
mkdirSync(resolve(root,'output/acceptance'),{recursive:true});
const result={prefix,finished_at:new Date().toISOString(),scope:'reference browser regression, no agent-generated design or approval claims',checks,passed:checks.length===3&&checks.every(item=>item.verified&&item.evidence_exit===0)};
writeFileSync(resolve(root,'output/acceptance',`${prefix}.json`),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result,null,2));
process.exitCode=result.passed?0:1;
