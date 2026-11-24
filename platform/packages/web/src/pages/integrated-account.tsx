import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { useAuth } from "../state/auth";
import { AccountCenter } from "./account-center";
import { ServiceStatus } from "./service-status";

export function accountSurface(config: { enabled: boolean; required?: boolean }) {
  return config.enabled ? "server" : config.required ? "unconfigured" : "legacy";
}

/**
 * 登录专用页面（客户端主链路）。
 * - UI 复用账号中心的登录表单；登录请求仍走本地 account-client 代理（代理目标 = 服务端账号中心）。
 * - 登录成功后不再进入账号中心仪表盘：onSignedIn 触发 useAuth.refresh()（本地会话已生效），
 *   本组件只渲染"进入中"提示；路由守卫（LoginRoute）看到新会话后 Navigate /qa/projects，
 *   无整页跳转、无账号中心中转页。
 * - 登录成功后的账号管理职责收敛到管理后台 /admin/users（AccountCenter 的仪表盘形态仅保留给该处）。
 */
export function IntegratedAccountPage({ fallback }: { login?: boolean; fallback?: ReactNode }) {
  const [state, setState] = useState<{enabled: boolean; required?: boolean} | null>(null);
  const [failed,setFailed] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  const { refresh } = useAuth();
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
  if(failed) return <main className="p-6"><h1>暂时无法读取账号配置</h1><p>请检查本机服务后重试。</p><button onClick={()=>location.reload()}>重新连接</button></main>;
  if(!state) return <p className="p-6" role="status">正在连接账号服务…</p>;
  if(accountSurface(state)==="unconfigured") return <main className="p-6" role="alert"><h1>尚未配置服务端连接</h1><p>请联系管理员配置正式服务端地址后重新连接。</p><button onClick={()=>location.reload()}>重新连接</button></main>;
  if(!state.enabled) return <>{fallback ?? <p className="p-6">未配置内置账号服务。<a href="/chat">返回工作台</a></p>}</>;
  // 登录成功：刷新会话状态（路由守卫按新会话导航到 /qa/projects），表单收起等待跳转。
  if(signedIn) return <p className="p-6" role="status">登录成功，正在进入工作台…</p>;
  return <><ServiceStatus /><AccountCenter integrated registrationEnabled={false} apiBase="/api/account-client" onSignedIn={()=>{ setSignedIn(true); void refresh(); }}/></>;
}
