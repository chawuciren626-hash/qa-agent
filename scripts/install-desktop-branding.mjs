import { readFileSync, writeFileSync, existsSync, renameSync, unlinkSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, dirname, basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const digest = bytes => bytes === null ? null : createHash('sha256').update(bytes).digest('hex');
const read = path => existsSync(path) ? readFileSync(path) : null;
const ps = (source, env = {}) => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from('$ErrorActionPreference="Stop";$ProgressPreference="SilentlyContinue";[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new();\n'+source, 'utf16le').toString('base64')], { env: { ...process.env, ...env }, encoding: 'utf8', windowsHide: true, timeout: 20000 }).trim();
function write(path, bytes) {
  if (bytes === null) { if (existsSync(path)) unlinkSync(path); return; }
  const temp = path + '.qa-brand-' + randomUUID();
  try { writeFileSync(temp, bytes, { flag: 'wx' }); renameSync(temp, path); }
  finally { if (existsSync(temp)) unlinkSync(temp); }
}
function replaceOnce(source, anchor, replacement) {
  if (source.split(anchor).length !== 2) throw new Error('Unsupported desktop shell anchor: ' + anchor);
  return source.replace(anchor, replacement);
}
export function patchDesktopBranding(source, version='0.2.13') {
  const replace = (text, before, after) => {
    if(version==='0.2.16') {
      before=before.replaceAll('app5','app6').replaceAll('path9','path27');
      after=after.replaceAll('app5','app6').replaceAll('path9','path27');
    }
    return replaceOnce(text,before,after);
  };
  // Keep the original application identity for storage and taskbar grouping.
  // Only the visible name changes; existing sessions/preferences remain in place.
  source = replace(source, 'app5.setName(identity.name);', `app5.setName(identity.name);
var qaOriginalUserData = app5.getPath("userData");
var qaOriginalSessionData = app5.getPath("sessionData");
identity.name = "AITestHarness";
app5.setName(identity.name);
app5.setPath("userData", qaOriginalUserData);
app5.setPath("sessionData", qaOriginalSessionData);`);
  return replace(source, '  win.once("ready-to-show", () => win?.show());', `  if (process.platform === "win32") win.setAppDetails({
    appId: identity.appUserModelId,
    appIconPath: path9.join(app5.getAppPath(), "dist", "aith-icon.ico"),
    appIconIndex: 0,
    relaunchCommand: '"' + process.execPath + '"',
    relaunchDisplayName: "AITestHarness"
  });
  win.once("ready-to-show", () => win?.show());`);
}

const discoverShortcuts = `
$ws=New-Object -ComObject WScript.Shell
$roots=@([Environment]::GetFolderPath('Desktop'),[Environment]::GetFolderPath('CommonDesktopDirectory'),[Environment]::GetFolderPath('StartMenu'),[Environment]::GetFolderPath('CommonStartMenu'),"$env:APPDATA/Microsoft/Internet Explorer/Quick Launch/User Pinned/TaskBar")
$items=@(foreach($root in $roots) {
  if (Test-Path -LiteralPath $root) {
    foreach($file in Get-ChildItem -LiteralPath $root -Filter '*.lnk' -Recurse) {
      $link=$ws.CreateShortcut($file.FullName)
      if($link.TargetPath -eq $env:QA_BRAND_EXE) {
        $destination=$file.DirectoryName
        [pscustomobject]@{path=$file.FullName; next=(Join-Path $destination 'AITestHarness.lnk'); icon=$link.IconLocation; description=$link.Description}
      }
    }
  }
})
ConvertTo-Json -InputObject $items -Compress`;

export function installDesktopBranding(app, root, mode='check') {
  if(process.platform!=='win32') throw new Error('Windows desktop branding requires Windows');
  if(!['check','apply'].includes(mode)) throw new Error('Use --check or --apply');
  app=resolve(app); root=resolve(root);
  const version=JSON.parse(readFileSync(join(app,'package.json'),'utf8')).version;
  if(!['0.2.13','0.2.16'].includes(version)) throw new Error('Only inspected desktop versions 0.2.13 and 0.2.16 supported');
  const exe=resolve(app,'../../PenguinHarness.exe');
  if(!existsSync(exe)) throw new Error('Installed executable missing');
  const recordPath=join(app,'qa-desktop-branding.json');
  let record=existsSync(recordPath)?JSON.parse(readFileSync(recordPath,'utf8')):null;
  if(record?.version===1 && record.state==='pending' && mode==='apply') {
    const running=ps('Get-Process | Where-Object { $_.ProcessName -eq "PenguinHarness" } | Select-Object -ExpandProperty Id');
    if(running) throw new Error('Exit PenguinHarness before recovering desktop branding');
    for(const file of record.files) {
      const current=digest(read(file.path));
      const original=file.before===null?null:Buffer.from(file.before,'base64');
      if(current!==digest(original) && current!==file.installed) throw new Error('Unknown file changes during recovery: '+file.path);
    }
    for(const file of [...record.files].reverse()) {
      const original=file.before===null?null:Buffer.from(file.before,'base64');
      if(digest(read(file.path))!==digest(original)) write(file.path,original);
    }
    record=record.previousRecord??null;
    write(recordPath,record===null?null:Buffer.from(JSON.stringify(record,null,2)));
  }
  if(record && (record.version!==1 || record.state!=='installed')) throw new Error('Incomplete desktop branding installation; restore from recorded pre-images before retrying');
  for(const file of record?.files??[]) if(digest(read(file.path))!==file.installed) throw new Error('Desktop branding file changed externally: '+file.path);
  const mainPath=join(app,'dist/main.js');
  const savedMain=record?.files.find(file=>file.path===mainPath);
  const originalMain=savedMain?Buffer.from(savedMain.before,'base64'):read(mainPath);
  const desired=new Map([[mainPath,Buffer.from(patchDesktopBranding(originalMain.toString('utf8'),version))]]);
  for(const [target,source] of [['dist/icon.png','aith-icon.png'],['dist/tray/tray.png','aith-tray.png'],['dist/tray/tray@2x.png','aith-tray@2x.png'],['dist/aith-icon.ico','aith-icon.ico']]) desired.set(join(app,target),readFileSync(join(root,'penguin/ui',source)));
  const shortcuts=JSON.parse(ps(discoverShortcuts,{QA_BRAND_EXE:exe}));
  const icon=join(app,'dist/aith-icon.ico')+',0';
  const links=shortcuts.filter(link=>basename(link.path)!=='AITestHarness.lnk'||link.icon!==icon||link.description!=='AITestHarness');
  for(const link of links) {
    const next=link.next;
    if(next!==link.path && existsSync(next)) throw new Error('Shortcut name already exists: '+next);
  }
  const changed=[...desired].some(([path,bytes])=>digest(read(path))!==digest(bytes))||links.length>0;
  if(mode==='check') return {status:changed?'update_available':'installed',changed,shortcuts:shortcuts.map(link=>link.path),restart_required:changed};
  const running=ps('Get-Process | Where-Object { $_.ProcessName -eq "PenguinHarness" } | Select-Object -ExpandProperty Id');
  if(running) throw new Error('PenguinHarness is running; exit from the tray before installing desktop branding');
  if(!changed) return {status:'installed',changed:false};
  // Stage shortcut bytes before editing any installed file. Copying preserves arguments,
  // working directory and the existing Windows AppUserModelID property store.
  const staging=mkdtempSync(join(tmpdir(),'qa-brand-'));
  try {
    for(const [i,link] of links.entries()) {
      const staged=join(staging,i+'.lnk');
      ps(`Copy-Item -LiteralPath $env:QA_BRAND_SOURCE -Destination $env:QA_BRAND_STAGE
$ws=New-Object -ComObject WScript.Shell
$link=$ws.CreateShortcut($env:QA_BRAND_STAGE)
$link.IconLocation=$env:QA_BRAND_ICON
$link.Description='AITestHarness'
$link.Save()`,{QA_BRAND_SOURCE:link.path,QA_BRAND_STAGE:staged,QA_BRAND_ICON:icon});
      const next=link.next;
      desired.set(next,readFileSync(staged));
      if(next!==link.path) desired.set(link.path,null);
    }
    const changes=[...desired].filter(([path,bytes])=>digest(read(path))!==digest(bytes));
    const before=new Map(changes.map(([path])=>[path,read(path)]));
    const owned=new Map((record?.files??[]).map(file=>[file.path,file]));
    for(const [path,bytes] of changes) owned.set(path,{path,before:owned.has(path)?owned.get(path).before:(before.get(path)?.toString('base64')??null),installed:digest(bytes)});
    const nextRecord={version:1,state:'pending',files:[...owned.values()],previousRecord:record};
    const recordBefore=read(recordPath);
    write(recordPath,Buffer.from(JSON.stringify(nextRecord,null,2)));
    try {
      for(const [path,bytes] of changes) write(path,bytes);
      nextRecord.state='installed';
      delete nextRecord.previousRecord;
      write(recordPath,Buffer.from(JSON.stringify(nextRecord,null,2)));
    } catch(error) {
      for(const [path,bytes] of [...before].reverse()) if(digest(read(path))!==digest(bytes)) write(path,bytes);
      write(recordPath,recordBefore);
      throw error;
    }
    // Ask Explorer to re-read shortcut/icon metadata without restarting Explorer.
    ps(`Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class QaBrandNotify { [DllImport("shell32.dll")] public static extern void SHChangeNotify(uint e, uint f, IntPtr a, IntPtr b); }'
[QaBrandNotify]::SHChangeNotify(0x08000000,0,[IntPtr]::Zero,[IntPtr]::Zero)`);
    return {status:'installed',changed:true,shortcuts:links.length,restart_required:true};
  } finally { rmSync(staging,{recursive:true,force:true}); }
}

if(process.argv[1] && pathToFileURL(resolve(process.argv[1])).href===import.meta.url) {
  const [app,flag='--check',...extra]=process.argv.slice(2);
  if(!app||extra.length||!['--check','--apply'].includes(flag)) throw new Error('Usage: node scripts/install-desktop-branding.mjs <resources/app> [--check|--apply]');
  console.log(JSON.stringify(installDesktopBranding(app,resolve(import.meta.dirname,'..'),flag.slice(2))));
}
