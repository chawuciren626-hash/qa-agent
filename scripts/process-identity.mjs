import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';

export function processAbsent(pid) {
  if(!Number.isSafeInteger(pid) || pid<1) return false;
  try {process.kill(pid,0);return false;} catch(error) {return error.code==='ESRCH';}
}

export function readProcessIdentity(pid) {
  if(!Number.isSafeInteger(pid) || pid<1) return null;
  try {
    if(process.platform==='win32') {
      const script=`try {$p=[System.Diagnostics.Process]::GetProcessById(${pid});[Console]::Write($p.StartTime.ToUniversalTime().Ticks.ToString())} catch {exit 1}`;
      const result=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{encoding:'utf8',windowsHide:true,timeout:3000});
      const start=result.stdout?.trim();
      return result.status===0 && /^\d{16,20}$/.test(start)?{host:hostname(),pid,platform:'win32',process_start:start}:null;
    }
    if(process.platform==='linux') {
      const raw=readFileSync(`/proc/${pid}/stat`,'utf8');
      const start=raw.slice(raw.lastIndexOf(')')+2).split(/\s+/)[19];
      const boot=readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim();
      return /^\d+$/.test(start)?{host:hostname(),pid,platform:'linux',process_start:start,boot_id:boot}:null;
    }
  } catch { /* Unknown identity is never evidence that an owner has exited. */ }
  return null;
}

let own;
export function ownProcessIdentity() {
  if(own===undefined) own=readProcessIdentity(process.pid);
  return own;
}

export function compareProcessIdentity(expected,actual) {
  if(!expected || !actual || expected.host!==hostname() || actual.host!==expected.host ||
    !Number.isSafeInteger(expected.pid) || expected.pid<1 || expected.pid!==actual.pid ||
    expected.platform!==actual.platform || !/^\d+$/.test(expected.process_start ?? '') ||
    !/^\d+$/.test(actual.process_start ?? '')) return 'unknown';
  if(expected.platform==='linux' && (!expected.boot_id || !actual.boot_id)) return 'unknown';
  return expected.process_start===actual.process_start && expected.boot_id===actual.boot_id?'same':'replaced';
}

export function ownerHasExited(pid,identity) {
  if(identity && (identity.pid!==pid || identity.host!==hostname())) return false;
  // No process at this PID is definitive even for a legacy owner record.
  if(processAbsent(pid)) return true;
  if(!identity || identity.pid!==pid || identity.host!==hostname()) return false;
  const current=pid===process.pid?ownProcessIdentity():readProcessIdentity(pid);
  return compareProcessIdentity(identity,current)==='replaced';
}
