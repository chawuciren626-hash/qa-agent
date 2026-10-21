import {readdirSync,lstatSync,readFileSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {loadProductLayout} from './product-layout.mjs';

try {
  if(process.argv.length!==3)throw Error('Installation configuration required');
  const layout=loadProductLayout(resolve(process.argv[2]));
  if(existsSync(resolve(layout.root,'.product-upgrade/active.json')))throw Error('安装事务尚未完成，请重新运行安装包恢复后再卸载。');
  if(layout.layout!=='unified'||layout.paths.engine!==resolve(import.meta.dirname,'..'))throw Error('Installation location differs; automatic removal refused');
  const manifest=JSON.parse(readFileSync(resolve(layout.root,'product-payload.json'),'utf8'));
  if(manifest.version!==1||!manifest.files?.['AITestHarness.exe'])throw Error('Missing product ownership manifest');
  function verify(dir){if(lstatSync(dir).isSymbolicLink())throw Error('Linked program path; removal refused');for(const entry of readdirSync(dir,{withFileTypes:true})){const p=resolve(dir,entry.name);if(lstatSync(p).isSymbolicLink())throw Error('Linked program entry; removal refused');if(entry.isDirectory())verify(p);}}
  verify(resolve(layout.root,'app'));verify(resolve(layout.root,'runtime'));
  if(existsSync(resolve(layout.root,'licenses')))verify(resolve(layout.root,'licenses'));
  const shell=resolve(process.env.SystemRoot??'C:/Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
  const code='$ErrorActionPreference="Stop"; $root=[IO.Path]::GetFullPath($env:QA_REMOVE_ROOT).TrimEnd("\\")+"\\"; @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($root,[StringComparison]::OrdinalIgnoreCase) -and $_.ProcessId -ne [int]$env:QA_REMOVE_SELF -and $_.ProcessId -ne [int]$env:QA_REMOVE_PARENT }).Count';
  const count=execFileSync(shell,['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(code,'utf16le').toString('base64')],{env:{...process.env,QA_REMOVE_ROOT:layout.root,QA_REMOVE_SELF:String(process.pid),QA_REMOVE_PARENT:String(process.ppid)},encoding:'utf8',windowsHide:true,timeout:15000}).trim();
  if(count!=='0')throw Error('应用或工作进程仍在运行，请正常退出后再卸载。');
  console.log('Program directories verified. User data and workspaces must be retained.');
}catch(error){console.error(error.message);process.exitCode=1;}
