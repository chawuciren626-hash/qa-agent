import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { AccountCenter } from "./account-center";

/** The central UI is an account surface beside the full application, never a replacement for it. */
export function IntegratedAccountPage({ login = false, fallback }: { login?: boolean; fallback?: ReactNode }) {
  const [state, setState] = useState<{enabled: boolean; registration: boolean} | null>(null);
  const [failed,setFailed] = useState(false);
  useEffect(() => {
    let active=true;
    void (async()=>{
      const response=await fetch("/api/account-client/config",{signal:AbortSignal.timeout(6000)});
      if (!response.ok) throw Error("configuration unavailable");
      const config=await response.json() as {enabled:boolean};
      let registration=false;
      if (config.enabled) {
        try { const r=await fetch("/api/account-client/api/auth/registration",{signal:AbortSignal.timeout(6000)}); if(r.ok) registration=(await r.json()).enabled===true; } catch { /* Login still reports the center's connection error. */ }
      }
      if(active)setState({enabled:config.enabled,registration});
    })().catch(()=>{if(active)setFailed(true);});
    return()=>{active=false;};
  },[]);
  if(failed) return <main className="p-8"><h1>暂时无法读取账号配置</h1><p>请检查本机服务后重试。</p><button onClick={()=>location.reload()}>重新连接</button></main>;
  if(!state) return <p className="p-8" role="status">正在连接账号服务…</p>;
  if(!state.enabled) return <>{fallback ?? <p className="p-8">未配置中央账号服务。<a href="/chat">返回工作台</a></p>}</>;
  return <AccountCenter integrated registrationEnabled={state.registration} apiBase="/api/account-client" onSignedIn={()=>location.assign("/user/chat")}/>;
}
