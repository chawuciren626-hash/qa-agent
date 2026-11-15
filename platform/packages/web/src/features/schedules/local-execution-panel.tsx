import { useEffect, useState } from 'react';
import { apiFetch } from '../../api/client';
import { Button } from '@prismshadow/penguin-ui';

type Run = {runId: string; name: string; status: string; reasonCode?: string; agentId: string};
type Binding = {id: string; projectId: string; agentId: string; enabled: boolean; origin: string; active?: {state: string; reason?: string}};
const states: Record<string, string> = {queued:'排队', claimed:'已领取', running:'运行中', unknown:'结果待核实', needs_approval:'等待确认', blocked:'已阻止', succeeded:'流程完成', failed:'失败', cancelled:'已取消', expired:'已过期', preparing:'准备中', dispatching:'派发中'};
export function LocalExecutionPanel({projectId, agentId, names}: {projectId: string; agentId: string; names: string[]}) {
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const [runs, setRuns] = useState<Run[]>([]); const [bindings, setBindings] = useState<Binding[]>([]);
  const [boundNames, setBoundNames] = useState<string[]>([]);
  const base = `/api/projects/${encodeURIComponent(projectId)}/unattended`;
  const load = async () => {
    const [r, b, s] = await Promise.all([apiFetch<{runs:Run[]}>(`${base}/runs`), apiFetch<{bindings:Binding[]}>('/api/local-exchange/v1/bindings'), apiFetch<{bindings:{name:string}[]}>(`${base}/bind/${encodeURIComponent(agentId)}`)]);
    setRuns(r.runs.filter(item => item.agentId === agentId)); setBindings(b.bindings.filter(item => item.projectId === projectId && item.agentId === agentId)); setBoundNames(s.bindings.map(item => item.name));
  };
  useEffect(() => { void load().catch(e => setError(e.message)); }, [projectId, agentId]);
  const act = async (fn: () => Promise<unknown>) => { setBusy(true); setError(''); try { await fn(); await load(); } catch(e) { setError(e instanceof Error ? e.message : '操作失败'); } finally { setBusy(false); } };
  return <details className="my-4 rounded-lg border p-4">
    <summary className="cursor-pointer font-medium">本机无人值守授权与外部任务</summary>
    <p className="my-2 text-sm opacity-70">电脑和 AITestHarness 需要保持运行。定时任务必须显式授权；断线或重启后结果不明的任务不会自动重跑。</p>
    {error && <p role="alert" className="text-red-600">{error}</p>}
    <form className="my-3 flex flex-wrap items-center gap-2" onSubmit={event => {
      event.preventDefault(); const data = new FormData(event.currentTarget); const name = String(data.get('name'));
      void act(() => apiFetch(`${base}/bind/${encodeURIComponent(agentId)}/${encodeURIComponent(name)}`, {method:'PUT', body:{
        grantExpiresAt: new Date(String(data.get('expires'))).toISOString(),
        permissionCeiling:{allowedOperations:['schedule.dispatch'], unattendedApproval:data.get('allowAll') ? 'allow-all' : 'default', defaultRunDeadlineMs:3600000},
      }}));
    }}>
      <select className="rounded border p-2" name="name" aria-label="授权的定时任务" required>{names.map(name => <option key={name}>{name}</option>)}</select>
      <label className="text-sm">授权截止 <input className="rounded border p-2" type="datetime-local" name="expires" required/></label>
      <label className="text-sm"><input type="checkbox" name="allowAll"/>允许该任务免逐次确认执行操作</label>
      <Button type="submit" disabled={busy || !names.length}>授权此本机任务</Button>
    </form>
    <p className="text-sm opacity-70">单次运行最长 1 小时；未勾选免确认时，任务沿用受限审批方式。</p>
    {boundNames.map(name => <div className="my-2 flex items-center gap-3" key={name}><span className="text-sm">{name} · 已绑定</span><Button disabled={busy} onClick={() => void act(() => apiFetch(`${base}/bind/${encodeURIComponent(agentId)}/${encodeURIComponent(name)}`, {method:'DELETE'}))}>撤销绑定</Button></div>)}
    <Button disabled={busy} onClick={() => void act(load)}>刷新状态</Button>
    {runs.slice(0, 10).map(run => <div className="my-2 flex flex-wrap items-center gap-3 text-sm" key={run.runId}>
      <span>{run.name} · {states[run.status] ?? run.status}{run.reasonCode ? ` · ${run.reasonCode}` : ''}</span>
      {['queued','claimed','running','needs_approval'].includes(run.status) && <Button disabled={busy} onClick={() => void act(() => apiFetch(`${base}/runs/${encodeURIComponent(run.runId)}/cancel`, {method:'POST', body:{}}))}>取消运行</Button>}
    </div>)}
    <h3 className="mt-5 font-medium">绑定服务端外部任务</h3>
    <p className="my-2 text-sm opacity-70">在服务端注册设备后填写以下信息。任务由本机主动领取，浏览器在本机执行；默认只读，不自动上传工程文件。</p>
    <form className="grid gap-2 sm:grid-cols-2" onSubmit={event => {
      event.preventDefault(); const form = event.currentTarget; const data = new FormData(form);
      void act(async () => { await apiFetch('/api/local-exchange/v1/bindings', {method:'POST', body:{origin:data.get('origin'), deviceId:data.get('deviceId'), deviceToken:data.get('deviceToken'), projectRef:data.get('projectRef'), projectId, agentId}}); form.reset(); });
    }}>
      <input className="rounded border p-2" name="origin" aria-label="服务端地址" placeholder="服务端 HTTPS 地址" type="url" required/>
      <input className="rounded border p-2" name="deviceId" aria-label="设备标识" placeholder="服务端设备标识" required/>
      <input className="rounded border p-2" name="deviceToken" aria-label="设备令牌" placeholder="设备令牌" type="password" autoComplete="new-password" required/>
      <input className="rounded border p-2" name="projectRef" aria-label="服务端项目标识" placeholder="服务端项目标识" required/>
      <Button type="submit" disabled={busy}>绑定当前项目与 Agent</Button>
    </form>
    {bindings.map(binding => <div className="my-3 flex flex-wrap items-center gap-3 text-sm" key={binding.id}>
      <span>{binding.origin} · {binding.enabled ? '已启用' : '已停用'} · {binding.active ? states[binding.active.state] ?? binding.active.state : '等待任务'}</span>
      {binding.enabled && <Button disabled={busy} onClick={() => void act(() => apiFetch(`/api/local-exchange/v1/bindings/${binding.id}`, {method:'DELETE'}))}>停用并取消本机执行</Button>}
    </div>)}
  </details>;
}
