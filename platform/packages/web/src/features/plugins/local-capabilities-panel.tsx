import { useEffect, useState } from 'react';
import { apiFetch } from '../../api/client';
import { Button } from '@prismshadow/penguin-ui';
import { useAuth } from '../../state/auth';

type Connector = { connectorId: string; name: string; kind: string; recipient: string; enabled: boolean; authorization: string; credentialSet: boolean; executionLocation: string };
type Plugin = { pluginId: string; version: string; trustState: string; executionStatus: string };
export function LocalCapabilitiesPanel() {
  const { user } = useAuth();
  const [connectors, setConnectors] = useState<Connector[]>([]);
  const [plugins, setPlugins] = useState<Plugin[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const base = '/api/local-capabilities/v1';
  const load = async () => {
    const [c, p] = await Promise.all([apiFetch<{connectors: Connector[]}>(`${base}/connectors`), apiFetch<{versions: Plugin[]}>(`${base}/plugins`)]);
    setConnectors(c.connectors); setPlugins(p.versions);
  };
  useEffect(() => { void load().catch(e => setError(String(e.message))); }, []);
  const act = async (action: () => Promise<unknown>) => {
    setBusy(true); setError('');
    try { await action(); await load(); } catch (e) { setError(e instanceof Error ? e.message : '操作失败'); }
    finally { setBusy(false); }
  };
  return <details className="my-4 rounded-lg border p-4">
    <summary className="cursor-pointer font-medium">本机连接器与受信任插件包</summary>
    <p className="my-3 text-sm opacity-70">连接器凭据保存在当前服务的加密存储中；执行位置和接收地址显示在下方。</p>
    {error && <p role="alert" className="text-red-600">{error}</p>}
    <form className="my-3 flex flex-wrap gap-2" onSubmit={event => {
      event.preventDefault(); const form = event.currentTarget; const data = new FormData(form);
      void act(async () => { await apiFetch(`${base}/connectors`, {method: 'POST', body: {name: data.get('name'), kind: 'http', recipient: data.get('recipient')}}); form.reset(); });
    }}>
      <input className="rounded border p-2" name="name" aria-label="连接器名称" placeholder="连接器名称" required maxLength={80}/>
      <input className="min-w-64 rounded border p-2" name="recipient" type="url" aria-label="连接器接收地址" placeholder="HTTPS 接收地址" required/>
      <Button type="submit" disabled={busy}>添加 HTTP 连接器</Button>
    </form>
    {connectors.map(item => <section key={item.connectorId} className="my-3 rounded border p-3">
      <p className="font-medium">{item.name} · {item.executionLocation === 'local' ? '本机执行' : '服务端执行'} · {item.enabled ? '已启用' : '未启用'}</p>
      <p className="break-all text-sm">{item.recipient} · {item.credentialSet ? '已保存凭据' : '未配置凭据'}{item.authorization === 'revoked' ? ' · 已撤销' : ''}</p>
      <form className="mt-2 flex flex-wrap gap-2" onSubmit={event => {
        event.preventDefault(); const form = event.currentTarget; const secret = new FormData(form).get('secret');
        void act(async () => { await apiFetch(`${base}/connectors/${item.connectorId}/credential`, {method: 'PUT', body: {secret}}); form.reset(); });
      }}>
        <input className="rounded border p-2" name="secret" type="password" autoComplete="new-password" aria-label={`${item.name}凭据`} placeholder="访问令牌" required/>
        <Button type="submit" disabled={busy}>保存凭据</Button>
        <Button type="button" disabled={busy || !item.credentialSet} onClick={() => void act(() => apiFetch(`${base}/connectors/${item.connectorId}`, {method: 'PUT', body: {enabled: !item.enabled}}))}>{item.enabled ? '停用' : '启用'}</Button>
        <Button type="button" disabled={busy} onClick={() => void act(() => apiFetch(`${base}/connectors/${item.connectorId}`, {method: 'DELETE'}))}>撤销授权</Button>
      </form>
    </section>)}
    <h3 className="mt-4 font-medium">插件包校验记录</h3>
    <p className="my-2 text-sm opacity-70">此处记录签名、内容和版本校验。通用可执行插件尚需运行适配器，校验通过不代表工具已启用。</p>
    {plugins.length === 0 && <p className="text-sm">暂无导入记录。</p>}
    {plugins.map(item => <p className="my-1 text-sm" key={`${item.pluginId}:${item.version}`}>{item.pluginId} · {item.version} · {item.trustState === 'verified' ? '签名已验证，待运行接入' : '发布者待验证'}</p>)}
    {user?.isAdmin && <label className="mt-3 block text-sm">导入插件 ZIP 包
      <input className="ml-3" type="file" accept=".zip" disabled={busy} onChange={event => {
        const file = event.target.files?.[0]; if (!file) return;
        void act(async () => {
          if (file.size > 25 * 1024 * 1024) throw new Error('插件包不能超过 25 MiB。');
          const bytes = new Uint8Array(await file.arrayBuffer()); let binary = '';
          for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
          const result = await apiFetch<{status: string; detail?: string}>(`${base}/plugins`, {method: 'POST', body: {archiveBase64: btoa(binary)}});
          if (['rejected', 'incompatible'].includes(result.status)) throw new Error(result.detail ?? '插件包校验未通过');
        });
      }}/>
    </label>}
  </details>;
}
