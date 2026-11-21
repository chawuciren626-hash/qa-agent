import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { AccountCenter } from "./account-center";
import { ServiceStatus } from "./service-status";

export function accountSurface(config: { enabled: boolean; required?: boolean }) {
  return config.enabled ? "server" : config.required ? "unconfigured" : "legacy";
}

/** The central UI is an account surface beside the full application, never a replacement for it. */
export function IntegratedAccountPage({ fallback }: { login?: boolean; fallback?: ReactNode }) {
  const [state, setState] = useState<{enabled: boolean; required?: boolean} | null>(null);
  const [failed,setFailed] = useState(false);
  useEffect(() => {
    let active=true;
    void (async()=>{
      const response=await fetch("/api/account-client/config",{signal:AbortSignal.timeout(6000)});
      if (!response.ok) throw Error("configuration unavailable");
      const config=await response.json() as {enabled:boolean; required?:boolean};
      if(active)setState(config);
    })().catch(()=>{if(active)setFailed(true);});
    return()=>{active=false;};
  },[]);
  if(failed) return <main className="p-8"><h1>暂时无法读取账号配置</h1><p>请检查本机服务后重试。</p><button onClick={()=>location.reload()}>重新连接</button></main>;
  if(!state) return <p className="p-8" role="status">正在连接账号服务…</p>;
  if(accountSurface(state)==="unconfigured") return <main className="p-8" role="alert"><h1>尚未配置服务端连接</h1><p>请联系管理员配置正式服务端地址后重新连接。</p><button onClick={()=>location.reload()}>重新连接</button></main>;
  if(!state.enabled) return <>{fallback ?? <p className="p-8">未配置内置账号服务。<a href="/chat">返回工作台</a></p>}</>;
  return <><ServiceStatus /><AccountCenter integrated registrationEnabled={false} apiBase="/api/account-client" onSignedIn={()=>location.assign("/user/qa/projects")}/></>;
}
