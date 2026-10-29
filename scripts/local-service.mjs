/** Per-user local runtime. The desktop is a client; its lifetime never owns the server. */
import {mkdirSync,readFileSync,writeFileSync,existsSync,unlinkSync,openSync,closeSync,lstatSync} from 'node:fs';
import {resolve,dirname,join} from 'node:path';
import {createHash,randomBytes,timingSafeEqual} from 'node:crypto';
import {createServer,connect} from 'node:net';
import {spawn,fork,execFileSync} from 'node:child_process';
import {EventEmitter} from 'node:events';
import {pathToFileURL} from 'node:url';
import {loadProductLayout,productEnvironment} from './product-layout.mjs';

const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const alive=pid=>{try{process.kill(pid,0);return true;}catch(e){if(e.code==='ESRCH')return false;throw e;}};
const read=file=>JSON.parse(readFileSync(file,'utf8'));
export function servicePaths(config) {
  const layout=loadProductLayout(config);
  const id=createHash('sha256').update(layout.paths.host_data.toLowerCase()).digest('hex').slice(0,24);
  const dir=resolve(layout.paths.qa_data,'local-service');
  return {layout,dir,id,pipe:process.platform==='win32'?`\\\\.\\pipe\\aitest-${id}`:join(dir,'service.sock'),
    state:join(dir,'connection.json'),pause:resolve(layout.root,'.local-service-paused.json')};
}
function protectDirectory(dir) {
  mkdirSync(dir,{recursive:true,mode:0o700});
  if(lstatSync(dir).isSymbolicLink())throw Error('Linked service directory refused');
  if(process.platform==='win32') {
    const sid=execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command','[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value'],{encoding:'utf8',windowsHide:true}).trim();
    if(!/^S-1-[0-9-]+$/.test(sid))throw Error('Cannot resolve local service owner');
    execFileSync('icacls.exe',[dir,'/inheritance:r','/grant:r',`*${sid}:(OI)(CI)F`,'*S-1-5-18:(OI)(CI)F'],{stdio:'pipe',windowsHide:true});
  }
}
function send(socket,message){if(!socket.destroyed)socket.write(JSON.stringify(message)+'\n');}
/** Bounded local-only protocol; never a browser-accessible HTTP management surface. */
export function readFrames(socket,receive) {
  let buffer='';socket.setEncoding('utf8');
  socket.on('data',chunk=>{
    buffer+=chunk;
    if(Buffer.byteLength(buffer)>4*1024*1024){socket.destroy();return;}
    for(let end;(end=buffer.indexOf('\n'))>=0;){
      const line=buffer.slice(0,end);buffer=buffer.slice(end+1);
      try{const message=JSON.parse(line);if(!message||typeof message!=='object')throw Error();receive(message);}catch{socket.destroy();return;}
    }
  });
}
export async function connectService(config) {
  const paths=servicePaths(config),state=read(paths.state);
  if(state.pipe!==paths.pipe||!alive(state.pid)||typeof state.secret!=='string')throw Error('Local service not running');
  const socket=connect(paths.pipe),events=new EventEmitter(),pending=new Map();let sequence=0;
  socket.on('error',()=>{});
  await new Promise((ok,fail)=>{socket.once('connect',ok);socket.once('error',fail);socket.setTimeout(4000,()=>socket.destroy(Error('Local service connection timeout')));});
  socket.setTimeout(0);
  readFrames(socket,m=>{if(m.id&&pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);clearTimeout(p.timer);m.error?p.fail(Error(m.error)):p.ok(m.result);}else if(m.event==='frame')events.emit('message',m.data);else if(m.event==='ready')events.emit('ready',m.data);});
  socket.on('close',()=>{for(const p of pending.values()){clearTimeout(p.timer);p.fail(Error('Local service disconnected'));}pending.clear();events.emit('exit');});
  const request=(method,args={})=>new Promise((ok,fail)=>{const id=String(++sequence);const timer=setTimeout(()=>{pending.delete(id);fail(Error('Local service request timed out'));},45000);pending.set(id,{ok,fail,timer});send(socket,{id,method,...args});});
  try{await request('authenticate',{secret:state.secret});}catch(e){socket.destroy();throw e;}
  return Object.assign(events,{request,postMessage:data=>send(socket,{method:'frame',data}),close:()=>socket.destroy()});
}
export async function serviceStatus(config) {
  let client;try{client=await connectService(config);return await client.request('status');}catch{return null;}finally{client?.close();}
}
export async function ensureLocalService(config) {
  config=resolve(config);const p=servicePaths(config);
  if(existsSync(p.pause)||existsSync(resolve(p.layout.root,'.source-sync.lock'))||existsSync(resolve(p.layout.root,'.product-upgrade/active.json')))throw Error('本机服务已暂停维护，请先完成更新或恢复服务。');
  let status=await serviceStatus(config);if(status?.ready)return status;
  if(!status){
    mkdirSync(p.dir,{recursive:true});
    const log=openSync(join(p.dir,'supervisor.log'),'a');
    try{const child=spawn(p.layout.paths.node,[resolve(p.layout.paths.engine,'scripts/local-service.mjs'),'run',config],{detached:true,windowsHide:true,stdio:['ignore',log,log],env:productEnvironment(p.layout)});await new Promise((ok,fail)=>{child.once('spawn',ok);child.once('error',fail);});child.unref();}finally{closeSync(log);}
  }
  for(let i=0;i<240;i++){await sleep(250);status=await serviceStatus(config);if(status?.ready)return status;if(status?.error)throw Error(status.error);}
  throw Error('本机后台服务启动超时，请检查 local-service 日志。');
}
export async function attachLocalService(config) {
  await ensureLocalService(config);
  const client=await connectService(config);
  try{const claimed=await client.request('attach');return Object.assign(client,claimed);}catch(e){client.close();throw e;}
}
export async function pauseLocalService(config) {
  const status=await serviceStatus(config);if(!status)return false;
  const client=await connectService(config);
  try{await client.request('stop');}finally{client.close();}
  for(let i=0;i<160;i++){if(!alive(status.pid))return true;await sleep(125);}
  throw Error('本机服务未完全退出，已取消程序替换；不会强制结束任务。');
}
export async function resumeLocalService(config) {
  const p=servicePaths(config);if(existsSync(p.pause))unlinkSync(p.pause);
  return ensureLocalService(config);
}
export async function withLocalServicePaused(config,operation) {
  const running=await pauseLocalService(config);
  try{return await operation();}finally{if(running)await resumeLocalService(config);}
}
function systemProxyEnvironment() {
  if(process.platform!=='win32')return {};
  try {
    const code='$proxy=[System.Net.WebRequest]::GetSystemWebProxy(); $result=@{}; foreach ($protocol in @("http","https")) { $uri=[Uri]($protocol+"://example.com"); $target=$proxy.GetProxy($uri); if ($target -and $target.AbsoluteUri -ne $uri.AbsoluteUri) { $result[$protocol.ToUpper()+"_PROXY"]=$target.AbsoluteUri } }; $result | ConvertTo-Json -Compress';
    const values=JSON.parse(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',code],{encoding:'utf8',windowsHide:true,timeout:15000}));
    return Object.fromEntries(Object.entries(values).filter(([key,value])=>!process.env[key]&&!process.env[key.toLowerCase()]&&/^https?:\/\//.test(value)));
  }catch{return {};}
}
export function registerLocalService(config,{remove=false}={}) {
  if(process.platform!=='win32')throw Error('Automatic logon registration requires Windows');
  const p=servicePaths(config),startup=resolve(process.env.APPDATA,'Microsoft/Windows/Start Menu/Programs/Startup'),file=join(startup,`AITestHarness-${p.id}.vbs`);
  if(remove){if(existsSync(file))unlinkSync(file);return file;}
  const command=`"${p.layout.paths.node}" "${resolve(p.layout.paths.engine,'scripts/local-service.mjs')}" start "${resolve(config)}"`;
  mkdirSync(startup,{recursive:true});
  writeFileSync(file,'Set shell = CreateObject("WScript.Shell")\r\nshell.Run "'+command.replaceAll('"','""')+'", 0, False\r\n','utf16le');
  // Windows Script Host expects the BOM for Unicode paths.
  writeFileSync(file,Buffer.concat([Buffer.from([0xff,0xfe]),readFileSync(file)]));
  return file;
}

async function supervise(config) {
  const p=servicePaths(config),{layout}=p;
  if(existsSync(p.pause)||existsSync(resolve(layout.root,'.source-sync.lock'))||existsSync(resolve(layout.root,'.product-upgrade/active.json')))return;
  protectDirectory(p.dir);
  if(existsSync(resolve(layout.host_app,'aitest-source-runtime.json'))){
    const {checkSourceRuntime}=await import('./source-runtime.mjs');
    checkSourceRuntime(layout.host_app,layout.paths.engine);
  }
  const secret=randomBytes(32).toString('hex'),sockets=new Set(),shells=new Set(),requests=new Map();
  let child=null,ready=false,port=0,error=null,stopping=false,failures=0;
  const control=createServer(socket=>{
    sockets.add(socket);let authenticated=false;
    socket.on('error',()=>{});socket.on('close',()=>{sockets.delete(socket);shells.delete(socket);});
    const timeout=setTimeout(()=>{if(!authenticated)socket.destroy();},4000);timeout.unref();
    readFrames(socket,m=>{void (async()=>{
      try{
        let result;
        if(m.method==='authenticate'){
          const supplied=typeof m.secret==='string'?m.secret:'';
          if(supplied.length!==secret.length||!timingSafeEqual(Buffer.from(supplied),Buffer.from(secret)))throw Error('Invalid local service credential');
          authenticated=true;clearTimeout(timeout);result={ok:true};
        } else {
          if(!authenticated)throw Error('Authentication required');
          if(m.method==='status')result={pid:process.pid,serverPid:child?.pid,ready,port,error,desktopCount:shells.size};
          else if(m.method==='attach'){
            if(stopping||!ready)throw Error('本机服务尚未就绪');
            if(shells.size&&!shells.has(socket))throw Error('桌面界面已经连接');
            shells.add(socket);
            result={origin:`http://localhost:${port}`,token:await serverRequest('claim')};
          } else if(m.method==='frame'){
            if(!shells.has(socket))throw Error('Desktop attachment required');
            if(child?.connected)child.send({type:'aitest-shell-frame',data:m.data});
            return;
          } else if(m.method==='stop'){
            if(shells.size)throw Error('请先从托盘退出桌面客户端；后台任务不会被强制停止。');
            if(stopping||!ready)throw Error('本机服务未就绪，不能安全维护');
            stopping=true;
            // Refusal leaves task admission untouched. Success closes admission atomically.
            try{await serverRequest('prepare-stop');}catch(e){stopping=false;throw e;}
            writeFileSync(p.pause,JSON.stringify({version:1,reason:'maintenance',at:new Date().toISOString()}));
            result={stopping:true};
            send(socket,{id:m.id,result});
            child.send({type:'aitest-service-request',method:'shutdown'});
            return;
          }else throw Error('Unknown service command');
        }
        send(socket,{id:m.id,result});
      }catch(e){send(socket,{id:m.id,error:e.message});}
    })();});
  });
  // The kernel's exclusive pipe listener is the startup mutex, including concurrent logon/desktop starts.
  try{await new Promise((ok,fail)=>{control.once('error',fail);control.listen(p.pipe,ok);});}catch(e){if(e.code==='EADDRINUSE')return;throw e;}
  if(existsSync(p.state))unlinkSync(p.state);
  writeFileSync(p.state,JSON.stringify({version:1,pid:process.pid,pipe:p.pipe,secret}),{flag:'wx',mode:0o600});
  function serverRequest(method){return new Promise((ok,fail)=>{if(!child?.connected){fail(Error('Server unavailable'));return;}const id=randomBytes(16).toString('hex');const timer=setTimeout(()=>{requests.delete(id);fail(Error('Server control timed out'));},20000);requests.set(id,{ok,fail,timer});child.send({type:'aitest-service-request',id,method});});}
  function finish(){for(const s of sockets)s.destroy();control.close();if(existsSync(p.state)&&read(p.state).pid===process.pid)unlinkSync(p.state);process.exit(0);}
  async function start(){
    if(stopping)return;
    const lock=join(layout.paths.host_data,'server.lock');
    if(existsSync(lock)&&alive(read(lock).pid)){error='已有服务占用本地数据，请先正常退出旧版桌面。';return;}
    ready=false;
    const portFile=join(p.dir,'server-port'),preferred=join(layout.paths.desktop_profile,'preferred-port');
    if(existsSync(portFile))unlinkSync(portFile);
    const requested=existsSync(preferred)?Number(readFileSync(preferred,'utf8')):0;
    // Reserve the established origin. If another program took it, report the conflict instead of silently changing browser storage origins.
    const log=openSync(join(p.dir,'server.log'),'a');
    child=fork(join(layout.host_app,'dist/server.js'),[],{execPath:layout.paths.node,cwd:layout.host_app,windowsHide:true,stdio:['ignore',log,log,'ipc'],env:{...productEnvironment(layout),...systemProxyEnvironment(),AITEST_INSTALLATION_CONFIG:config,AITEST_ENGINE_ROOT:layout.paths.engine,AITEST_MANAGED_RUNTIME:'1',AITEST_LOCAL_SERVICE:'1',PENGUIN_UPDATE_CHECK:'off',PENGUIN_PROFILE:'release',PENGUIN_WEB_DIST:join(layout.host_app,'web-dist'),PENGUIN_CLI_ENTRY:join(layout.host_app,'dist/penguin.js'),PENGUIN_SHELL:resolve(process.env.SystemRoot??'C:/Windows','System32/WindowsPowerShell/v1.0/powershell.exe'),PENGUIN_DESKTOP_TOKEN:randomBytes(32).toString('base64url'),PENGUIN_PORT_FILE:portFile,HOST:'127.0.0.1',PORT:String(Number.isInteger(requested)&&requested>0?requested:0)}});
    closeSync(log);
    const startedAt=Date.now(),owned=child;
    child.on('error',e=>{error=e.message;});
    child.on('message',m=>{
      if(m?.type==='aitest-service-response'&&requests.has(m.id)){const q=requests.get(m.id);requests.delete(m.id);clearTimeout(q.timer);m.error?q.fail(Error(m.error)):q.ok(m.result);}
      if(m?.type==='aitest-shell-frame')for(const s of shells)send(s,{event:'frame',data:m.data});
    });
    child.on('exit',()=>{
      ready=false;child=null;for(const q of requests.values()){clearTimeout(q.timer);q.fail(Error('Server exited'));}requests.clear();
      if(stopping){finish();return;}
      if(Date.now()-startedAt>60000)failures=0;
      failures++;error='本机服务退出，正在自动恢复';
      setTimeout(()=>void start(),Math.min(30000,1000*2**Math.min(failures,5)));
    });
    for(let i=0;i<240&&child===owned;i++){
      await sleep(250);
      if(!existsSync(portFile))continue;
      port=Number(readFileSync(portFile,'utf8').trim());
      if(!Number.isInteger(port)||port<1)continue;
      mkdirSync(layout.paths.desktop_profile,{recursive:true});writeFileSync(preferred,String(port));
      ready=true;error=null;
      for(const s of shells)send(s,{event:'ready',data:{origin:`http://localhost:${port}`}});
      return;
    }
    if(child===owned)error='服务仍在启动，请检查日志；为保护任务，不强制终止进程';
  }
  await start();
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const [command,config]=process.argv.slice(2);
  try{
    if(!config)throw Error('Usage: local-service.mjs start|run|status|pause|resume|register|unregister <installation.json>');
    if(command==='run')await supervise(resolve(config));
    else if(command==='start')console.log(JSON.stringify(await ensureLocalService(config)));
    else if(command==='status')console.log(JSON.stringify(await serviceStatus(config)));
    else if(command==='pause')console.log(JSON.stringify({stopped:await pauseLocalService(config)}));
    else if(command==='resume')console.log(JSON.stringify(await resumeLocalService(config)));
    else if(command==='register'||command==='unregister')console.log(JSON.stringify({startup:registerLocalService(config,{remove:command==='unregister'})}));
    else throw Error('Unknown command');
  }catch(e){console.error(e.message);process.exitCode=1;}
}
