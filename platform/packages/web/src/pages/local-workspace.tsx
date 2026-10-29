import { useEffect, useState } from "react";
import { useAuth } from "../state/auth";
import { discoverLocalWorkspace, localWorkspaceUrl, rememberedWorkspace, rememberWorkspace } from "../lib/local-workspace";
import { SettingsDialog } from "../features/settings/settings-dialog";
import "./local-workspace.css";

/** The central entry automatically hands off to the running local workbench. */
export function LocalWorkspacePage() {
  const { user } = useAuth();
  const [waiting, setWaiting] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const preferred = localWorkspaceUrl(new URLSearchParams(location.search).get("local")) ?? rememberedWorkspace();
    const detect = async () => {
      const url = await discoverLocalWorkspace(location.origin, preferred, controller.signal);
      if (controller.signal.aborted) return;
      if (url) {
        rememberWorkspace(url);
        window.location.replace(url);
        return;
      }
      setWaiting(true);
      timer = setTimeout(() => void detect(), 2500);
    };
    void detect();
    return () => { controller.abort(); clearTimeout(timer); };
  }, []);
  return <main className="local-workspace"><header><strong>AITestHarness</strong><nav>{user?.isAdmin && <a href="/admin/overview">管理员视图</a>}{user && <button onClick={() => setSettingsOpen(true)}>设置</button>}</nav></header>
    <section role="status" aria-live="polite"><span className="local-workspace-spinner" aria-hidden="true"/><h1>{waiting ? "正在等待本机服务" : "正在进入用户视图…"}</h1>
      {waiting && <><p>本机服务运行后会自动进入用户视图，无需打开桌面窗口。</p><small>首次使用请安装 AITestHarness 本机组件。若浏览器询问本地网络访问权限，请允许访问。</small></>}
    </section>{user && <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} accountCenter />}</main>;
}
