import { useEffect, useState } from "react";

type SyncStatus = {
  state: "idle" | "syncing" | "current" | "update_failed" | "offline" | "closed";
  connection: "online" | "offline" | "unknown";
  publication: { setHash: string; agents: { agentId: string; version: number }[] } | null;
  update: { state: string; errorCode?: string; message?: string };
  offlineUsable: { agentId: string; version: number }[];
};

type StatusPayload = { enabled: boolean; origin: string; sync: SyncStatus };

/** Pure view model so the status labels and offline scope can be tested without a browser. */
export function serviceStatusViewModel(payload: StatusPayload) {
  const sync = payload.sync;
  const connection = sync.connection === "online" ? "服务端已连接" : sync.connection === "offline" ? "服务端不可用" : "尚未连接服务端";
  const publication = sync.publication
    ? `当前发布：${sync.publication.agents.map(agent => `${agent.agentId} v${agent.version}`).join("、")}`
    : "当前发布：尚未验证";
  const update = sync.update.state === "update_failed" || sync.update.state === "offline"
    ? `更新失败：${sync.update.message ?? sync.update.errorCode ?? "未知原因"}`
    : sync.state === "syncing" ? "正在核对发布…" : null;
  const offline = sync.update.state !== "current" && sync.offlineUsable.length
    ? `离线可用：${sync.offlineUsable.map(agent => `${agent.agentId} v${agent.version}`).join("、")}`
    : null;
  return { connection, publication, update, offline };
}

export function ServiceStatus() {
  const [payload, setPayload] = useState<StatusPayload | null>(null);
  useEffect(() => {
    let active = true;
    const timer = setInterval(() => void load(), 60_000);
    async function load() {
      try {
        const response = await fetch("/api/account-client/status", { credentials: "same-origin", signal: AbortSignal.timeout(6000) });
        if (!response.ok) { if (active) setPayload(null); return; }
        const value = await response.json() as StatusPayload;
        if (active) setPayload(value);
      } catch { if (active) setPayload(null); }
    }
    void load();
    return () => { active = false; clearInterval(timer); };
  }, []);
  if (!payload) return null;
  const view = serviceStatusViewModel(payload);
  return (
    <section className="service-status" aria-live="polite" aria-label="服务端与资源发布状态">
      <span className={`service-status-dot ${payload.sync.connection}`} aria-hidden="true" />
      <span>{view.connection}</span>
      <span>{view.publication}</span>
      {view.update ? <span className="service-status-error">{view.update}</span> : null}
      {view.offline ? <span>{view.offline}</span> : null}
    </section>
  );
}
