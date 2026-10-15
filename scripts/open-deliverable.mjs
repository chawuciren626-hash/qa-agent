import { realpathSync,statSync,openSync,readSync,closeSync } from 'node:fs';
import { extname } from 'node:path';
import { spawn } from 'node:child_process';

export function validateNativeDocument(file) {
  const path=realpathSync(file),ext=extname(path).toLowerCase();
  if(!['.xlsx','.docx','.xmind','.pdf'].includes(ext) || !statSync(path).isFile()) throw new Error('Unsupported delivery document');
  const descriptor=openSync(path,'r'),header=Buffer.alloc(5);
  try {readSync(descriptor,header,0,5,0);} finally {closeSync(descriptor);}
  if(ext==='.pdf'?!header.equals(Buffer.from('%PDF-')):header.readUInt32LE(0)!==0x04034b50) throw new Error('Invalid delivery document header');
  return path;
}

export async function openDeliverable(file,{run=spawn,platform=process.platform,timeoutMs=10000}={}) {
  if(!Number.isInteger(timeoutMs) || timeoutMs<1 || timeoutMs>60000) throw new Error('Invalid document launch timeout');
  const path=validateNativeDocument(file);
  const command=platform==='win32'?'powershell.exe':platform==='darwin'?'open':'xdg-open';
  const args=platform==='win32'?['-NoProfile','-NonInteractive','-Command','$ErrorActionPreference="Stop"; Start-Process -FilePath $env:QA_DELIVERY_OPEN_PATH']:[path];
  await new Promise((done,reject)=>{
    const child=run(command,args,{env:{...process.env,QA_DELIVERY_OPEN_PATH:path},windowsHide:true,stdio:'ignore',shell:false});
    let settled=false;
    const finish=error=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(error):done();};
    const timer=setTimeout(()=>{
      const error=new Error('Document application launch timed out; check whether it already opened before retrying');
      error.code='QA_DOCUMENT_OPEN_TIMEOUT';
      finish(error);
      // Stop only this launcher, never the document application or its process tree.
      try {child.kill();} catch {}
      child.unref?.();
    },timeoutMs);
    child.once('error',finish);child.once('exit',code=>finish(code===0?null:new Error('Document application could not be opened')));
  });
}
