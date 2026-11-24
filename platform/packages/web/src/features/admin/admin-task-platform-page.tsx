/**
 * 管理后台 · 系统管理 → 任务平台对接（配置/连接测试/手动同步/接收人指定）。
 *
 * 数据面：/api/admin/task-platform/*（settings/ping/sync-now/status/reset-cursor/recipients/demo）。
 * 接收人口径：同步项目 owner 与任务归属（单测试人员场景=默认 admin；多用户时指定承接人）。
 */
import { useCallback, useEffect, useState } from "react";
import { PageFrame, PageHeader } from "@prismshadow/penguin-ui";

import { controlRequest } from "../../api/control";

interface SettingsView {
  enabled: boolean;
  baseUrl: string;
  apiKeyMasked: string;
  pollIntervalMs: number;
  batchSize: number;
  recipientUserId: string;
}

interface Recipient {
  userId: string;
  displayName: string;
  isAdmin: boolean;
}

interface StatusView {
  settings: SettingsView;
  lastRunAt: string | null;
  lastError: string | null;
}

const num = (value: string, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export function AdminTaskPlatformPage() {
  const [settings, setSettings] = useState<SettingsView | null>(null);
  const [status, setStatus] = useState<StatusView | null>(null);
  const [recipients, setRecipients] = useState<Recipient[]>([]);
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [pollSeconds, setPollSeconds] = useState("60");
  const [recipient, setRecipient] = useState("");
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  const refresh = useCallback(async () => {
    try {
      const current = await controlRequest("/api/admin/task-platform/settings") as { settings: SettingsView };
      setSettings(current.settings);
      setBaseUrl(current.settings.baseUrl);
      setPollSeconds(String(Math.round(current.settings.pollIntervalMs / 1000)));
      setRecipient(current.settings.recipientUserId);
      setEnabled(current.settings.enabled);
      setStatus(await controlRequest("/api/admin/task-platform/status") as StatusView);
      const r = await controlRequest("/api/admin/task-platform/recipients") as { recipients: Recipient[] };
      setRecipients(r.recipients);
    } catch (error) {
      setMessage({ kind: "error", text: error instanceof Error ? error.message : String(error) });
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const save = async (nextEnabled?: boolean): Promise<void> => {
    setBusy(true);
    setMessage(null);
    try {
      const result = await controlRequest("/api/admin/task-platform/settings", "PUT", {
        enabled: nextEnabled ?? enabled,
        baseUrl,
        // Key 留空 = 保留服务端已存值（脱敏显示时的更新语义）
        apiKey: apiKey.trim(),
        pollIntervalMs: num(pollSeconds, 60) * 1000,
        batchSize: 50,
        recipientUserId: recipient,
      }) as { settings: SettingsView };
      setSettings(result.settings);
      setApiKey("");
      setEnabled(result.settings.enabled);
      setMessage({ kind: "ok", text: `配置已保存（enabled=${result.settings.enabled}，接收人=${result.settings.recipientUserId || "admin"}）` });
      await refresh();
    } catch (error) {
      setMessage({ kind: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  };

  const runAction = async (path: string, label: string): Promise<void> => {
    setBusy(true);
    setMessage(null);
    try {
      const result = await controlRequest(`/api/admin/task-platform${path}`, "POST") as { ok?: boolean; subCode?: string; message?: string };
      const text = result.message ?? (result.ok === true ? `${label}成功` : `${label}失败：${result.subCode ?? "未知"}`);
      setMessage({ kind: result.ok === false ? "error" : "ok", text: `${label}：${text}` });
      await refresh();
    } catch (error) {
      setMessage({ kind: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  };

  if (!settings) {
    return <PageFrame><p className="atp-loading">正在加载任务平台对接配置…{message ? <span className="atp-error-inline">{message.text}</span> : null}</p></PageFrame>;
  }

  return (
    <PageFrame>
      <PageHeader title="任务平台对接" description="任务平台（sbkj-taskassignment）交接包拉取与结果回传的连接配置" />
      <div className="atp-page">
        <section className="atp-card">
          <h3>连接配置</h3>
          <label className="atp-field">
            <span>任务平台地址</span>
            <input value={baseUrl} onChange={e => setBaseUrl(e.target.value)} placeholder="http://192.168.60.186:8000" />
          </label>
          <label className="atp-field">
            <span>API Key {settings.apiKeyMasked && <small className="atp-muted">（已配置 {settings.apiKeyMasked}，留空保留）</small>}</span>
            <input type="password" value={apiKey} onChange={e => setApiKey(e.target.value)} placeholder="留空保留现有 Key" />
          </label>
          <label className="atp-field">
            <span>轮询间隔（秒，10~3600）</span>
            <input type="number" min={10} max={3600} value={pollSeconds} onChange={e => setPollSeconds(e.target.value)} />
          </label>
          <label className="atp-field">
            <span>推送接收人（同步项目归属与任务承接用户）</span>
            <select value={recipient} onChange={e => setRecipient(e.target.value)}>
              <option value="">admin（默认）</option>
              {recipients.filter(r => r.userId !== "admin").map(r => (
                <option key={r.userId} value={r.userId}>{r.displayName}（{r.userId}）{r.isAdmin ? " · 管理员" : ""}</option>
              ))}
            </select>
          </label>
          <label className="atp-switch">
            <input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} />
            <span>启用对接（关闭时定时拉取停止、接口返回未启用）</span>
          </label>
          <div className="atp-actions">
            <button type="button" disabled={busy} onClick={() => void save()}>保存配置</button>
            <button type="button" disabled={busy} onClick={() => void runAction("/ping", "连接测试")}>连接测试</button>
            <button type="button" disabled={busy} onClick={() => void runAction("/sync-now", "手动同步")}>手动同步</button>
            <button type="button" disabled={busy} className="atp-danger" onClick={() => void runAction("/reset-cursor", "游标重建")}>重建游标</button>
          </div>
          {message && <p className={message.kind === "ok" ? "atp-msg-ok" : "atp-msg-error"}>{message.text}</p>}
        </section>

        <section className="atp-card">
          <h3>运行状态</h3>
          <dl className="atp-status">
            <div><dt>启用</dt><dd>{settings.enabled ? "是" : "否"}</dd></div>
            <div><dt>最近拉取</dt><dd>{status?.lastRunAt ?? "—"}</dd></div>
            <div><dt>最近错误</dt><dd>{status?.lastError ?? "—"}</dd></div>
            <div><dt>事件游标</dt><dd className="atp-mono">由拉取器维护；重建后从最早事件重放（已入库内容幂等保护）</dd></div>
          </dl>
        </section>

        <section className="atp-card">
          <h3>说明</h3>
          <ul className="atp-notes">
            <li>数据方向：AITestHarness 定时拉取（默认 60 秒）；任务平台不主动推送。</li>
            <li>接收人：同步项目将以该用户为 owner 创建；平台任务在该项目下展示与承接。</li>
            <li>附件：文本类附件自动进入任务附件（分析输入）；截图等二进制原件保留在任务平台，详情可跳转查看。</li>
            <li>演示数据：项目下 <code>source_system=demo</code> 的种子任务在真实数据到达后可通过接口清除（DELETE /demo/:projectId）。</li>
          </ul>
        </section>
      </div>
    </PageFrame>
  );
}
