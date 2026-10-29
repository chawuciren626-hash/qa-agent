import {readdirSync,lstatSync,readFileSync,existsSync,writeFileSync,realpathSync} from 'node:fs';
import {resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {loadProductLayout} from './product-layout.mjs';
import {pathToFileURL} from 'node:url';
import {pauseLocalService,resumeLocalService,registerLocalService} from './local-service.mjs';

function failure(code,message,legacyMessage){return Object.assign(Error(message),{code,legacyMessage});}

export function assertUninstallProcessesStopped(root,{run=execFileSync,self=process.pid,parent=process.ppid}={}){
  const shell=resolve(process.env.SystemRoot??'C:/Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
  const code='$ErrorActionPreference="Stop"; $ProgressPreference="SilentlyContinue"; $root=[IO.Path]::GetFullPath($env:QA_REMOVE_ROOT).TrimEnd("\\")+"\\"; @(Get-CimInstance Win32_Process | Where-Object { if ($_.ExecutablePath -and $_.ProcessId -ne [int]$env:QA_REMOVE_SELF -and $_.ProcessId -ne [int]$env:QA_REMOVE_PARENT) { $path=$_.ExecutablePath; $item=Get-Item -LiteralPath $path -ErrorAction SilentlyContinue; if ($item) { $path=$item.FullName }; $path.StartsWith($root,[StringComparison]::OrdinalIgnoreCase) } }).Count';
  let count;
  try{
    // CIM may retain an executable's 8.3 alias. Normalize both sides before
    // comparing so long/short spellings cannot hide a running worker.
    const canonicalRoot=existsSync(root)?realpathSync.native(root):root;
    // Explicit pipes prevent execFileSync from forwarding PowerShell's CLIXML
    // progress/error stream to nsExec. Never treat query failure as zero processes.
    count=run(shell,['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(code,'utf16le').toString('base64')],{env:{...process.env,QA_REMOVE_ROOT:canonicalRoot,QA_REMOVE_SELF:String(self),QA_REMOVE_PARENT:String(parent)},encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe'],timeout:15000}).trim();
  }catch{
    throw failure('UNINSTALL_PROCESS_QUERY_FAILED','无法检查应用进程，卸载已停止。请稍后重试；如仍失败，请联系维护者检查 Windows 进程查询服务。','Cannot check application processes. Nothing was removed. Retry or contact the maintainer.');
  }
  if(!/^\d+$/.test(count))throw failure('UNINSTALL_PROCESS_QUERY_INVALID','进程检查返回无效结果，卸载已停止，请联系维护者。','Invalid process-check response. Nothing was removed. Contact the maintainer.');
  if(!/^0+$/.test(count))throw failure('UNINSTALL_APP_RUNNING','应用或工作进程仍在运行，请等待任务结束并从托盘正常退出 AITestHarness 后再卸载。','Application or workers are still running. Wait for tasks to finish and exit AITestHarness from the system tray, then retry.');
}

export function checkProductUninstall(config,{engineRoot=resolve(import.meta.dirname,'..'),assertStopped=assertUninstallProcessesStopped}={}){
  const layout=loadProductLayout(resolve(config));
  if(existsSync(resolve(layout.root,'.product-upgrade/active.json')))throw failure('UNINSTALL_PENDING_TRANSACTION','安装事务尚未完成，请重新运行安装包恢复后再卸载。','An installation transaction is pending. Run the installer to recover before uninstalling. Do not delete recovery files.');
  if(layout.layout!=='unified'||layout.paths.engine!==resolve(engineRoot))throw Error('Installation location differs; automatic removal refused');
  const manifest=JSON.parse(readFileSync(resolve(layout.root,'product-payload.json'),'utf8'));
  if(manifest.version!==1||!manifest.files?.['AITestHarness.exe'])throw Error('Missing product ownership manifest');
  function verify(dir){if(lstatSync(dir).isSymbolicLink())throw Error('Linked program path; removal refused');for(const entry of readdirSync(dir,{withFileTypes:true})){const p=resolve(dir,entry.name);if(lstatSync(p).isSymbolicLink())throw Error('Linked program entry; removal refused');if(entry.isDirectory())verify(p);}}
  verify(resolve(layout.root,'app'));verify(resolve(layout.root,'runtime'));
  if(existsSync(resolve(layout.root,'licenses')))verify(resolve(layout.root,'licenses'));
  assertStopped(layout.root);
  return {status:'safe_to_uninstall',user_data_retained:true};
}

if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
  try{
    if(![3,4].includes(process.argv.length))throw Error('Usage: product-uninstall-check.mjs <installation.json> [error-file]');
    const stopped=await pauseLocalService(process.argv[2]);
    try {
      checkProductUninstall(process.argv[2]);
      registerLocalService(process.argv[2],{remove:true});
    } catch(error) {if(stopped)await resumeLocalService(process.argv[2]);throw error;}
    console.log('Program directories verified. User data and workspaces must be retained.');
  }catch(error){
    if(process.argv.length===4){try{writeFileSync(process.argv[3],error.message.replace(/[\r\n]+/g,' '),'utf16le');}catch{}}
    // Existing uninstall executables cannot read the Unicode error file. Keep
    // their fallback entirely ASCII so it is readable under every code page.
    console.error(`[${error.legacyMessage?error.code:'UNINSTALL_CHECK_FAILED'}] ${error.legacyMessage??'Installation validation failed. Nothing was removed. Preserve the installation folder and contact the maintainer.'}`);
    process.exitCode=1;
  }
}
