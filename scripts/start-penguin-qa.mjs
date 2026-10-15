import { existsSync, realpathSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const [appPath, mode, ...extra]=process.argv.slice(2);
if (!appPath || extra.length || (mode && mode!=='--check')) throw new Error('Usage: node scripts/start-penguin-qa.mjs <installed PenguinHarness.exe> [--check]');
if (process.platform!=='win32') throw new Error('This launcher is for Windows');
const app=realpathSync(appPath);
if (basename(app).toLowerCase()!=='penguinharness.exe') throw new Error('Expected the installed PenguinHarness.exe');
const shell=resolve(process.env.SystemRoot ?? 'C:/Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
if (!existsSync(shell)) throw new Error('Native Windows PowerShell missing');
if (mode==='--check') {
  console.log(JSON.stringify({app,shell,launched:false,python_encoding:'utf-8'}));
} else {
  const check=spawnSync(shell,['-NoProfile','-Command',"if (Get-Process -Name PenguinHarness -ErrorAction SilentlyContinue) { exit 1 }"],{windowsHide:true,encoding:'utf8'});
  if (check.error || check.status!==0) throw new Error('Close PenguinHarness normally first; launcher will not kill it or reuse its old environment');
  const child=spawn(app,[],{detached:true,windowsHide:true,stdio:'ignore',env:{...process.env,PENGUIN_SHELL:shell,PYTHONUTF8:'1',PYTHONIOENCODING:'utf-8'}});
  await new Promise((done,reject)=>{child.once('spawn',done);child.once('error',reject);});
  child.unref();console.log(JSON.stringify({launched:true,pid:child.pid,shell}));
}
