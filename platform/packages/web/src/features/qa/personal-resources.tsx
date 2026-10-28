import { useEffect, useRef, useState } from 'react';
import { Button, Modal } from '@prismshadow/penguin-ui';
import { apiFetch } from '../../api/client';
import { useProject, agentDisplayName } from '../../state/project';

type Resource = {id:string; name:string; kind:string; createdAt:string; skills:string[]; appliedAgents:string[]};
type Listing = {resources:Resource[]; canApply:boolean};
export function QaPersonalResources({query = ''}: {query?: string}) {
  const {currentProject, agents} = useProject();
  const projectId=currentProject?.projectId;
  const base='/api/projects/'+encodeURIComponent(projectId??'')+'/agents/qa/personal-resources';
  const [data,setData]=useState<Listing|null>(null);
  const [error,setError]=useState('');
  const [notice,setNotice]=useState('');
  const [kind,setKind]=useState('skill');
  const [agentId,setAgentId]=useState('test_agent');
  const [busy,setBusy]=useState(false);
  const [revision,setRevision]=useState(0);
  const [open,setOpen]=useState(false);
  const [file,setFile]=useState<File|null>(null);
  const [uploadError,setUploadError]=useState('');
  const [dragging,setDragging]=useState(false);
  const input=useRef<HTMLInputElement>(null);
  useEffect(()=>{let alive=true; setError('');
    if(projectId) apiFetch<Listing>(base).then(d=>{if(alive)setData(d);}).catch(e=>{if(alive)setError(e.message);});
    return ()=>{alive=false;};
  },[base,projectId,revision]);
  const act=async (fn:()=>Promise<void>)=>{setBusy(true);setError('');setNotice('');try{await fn();}catch(e){setError(e instanceof Error?e.message:'操作失败');}finally{setBusy(false);}};
  const pick=(next:File|undefined)=>{
    setUploadError('');setFile(null);
    if(!next)return;
    if(!/\.(zip|skill)$/i.test(next.name)){setUploadError('请选择 .zip 或 .skill 文件。');return;}
    if(next.size>14*1024*1024){setUploadError('文件不能超过 14 MB。');return;}
    if(!next.size){setUploadError('文件为空，请重新选择。');return;}
    setFile(next);
  };
  const upload=async()=>{
    if(!file||busy)return;
    setBusy(true);setUploadError('');
    try {
      const dataBase64=await new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onerror=()=>reject(new Error('文件读取失败'));reader.onload=()=>resolve(String(reader.result).split(',')[1]!);reader.readAsDataURL(file);});
      await apiFetch(base,{method:'POST',body:{kind,dataBase64}});
      setRevision(n=>n+1);setOpen(false);setFile(null);setNotice('导入成功，可选择智能体应用此资源。');
    } catch(e) {setUploadError(e instanceof Error?e.message:'上传失败，请重试');}
    finally {setBusy(false);}
  };
  const resources=data?.resources.filter(r=>(r.name+' '+r.skills.join(' ')).toLowerCase().includes(query.trim().toLowerCase()))??[];
  return <section className="qm-personal" aria-label="我的技能与插件">
    <div className="qm-personal-head"><div><h2 className="qm-subtitle">我的技能与插件 <small>{data?.resources.length??0}</small></h2><p>导入个人技能，为智能体添加补充能力。</p></div><Button size="sm" variant="primary" onClick={()=>{setFile(null);setUploadError('');setOpen(true);}}>＋ 上传技能</Button></div>
    {error&&<p role="alert" className="my-2 text-red-600">{error}<button onClick={()=>setRevision(n=>n+1)}> 重试</button></p>}{notice&&<p role="status" className="my-2 text-sm">{notice}</p>}
    {!data&&!error&&<p>正在读取个人资源…</p>}
    {!!data?.resources.length&&<label className="qm-agent">应用到智能体 <select aria-label="应用到智能体" value={agentId} disabled={busy||!data.canApply} onChange={e=>setAgentId(e.target.value)}>{agents.map(a=><option key={a.agentId} value={a.agentId}>{agentDisplayName(a)}</option>)}</select></label>}
    {data&&!resources.length&&<p className="qm-empty">{query?'没有匹配的个人资源。':'尚未导入技能，点击“上传技能”添加。'}</p>}
    <div className="qm-resource-grid">{resources.map(r=><article key={r.id} className="qm-resource">
      <div className="qm-resource-icon">{r.kind==='skill'?'◇':'▧'}</div><strong>{r.name}</strong><p>{r.skills.join('、')}</p><small>{r.kind==='skill'?'技能':'资源插件'} · {r.appliedAgents.length} 个智能体在用</small>
      <div className="qm-resource-actions"><Button size="sm" disabled={busy||!data?.canApply||!agents.some(a=>a.agentId===agentId)} onClick={()=>void act(async()=>{await apiFetch(base+'/'+r.id+'/apply',{method:'POST',body:{agentId}});setNotice('已应用到所选智能体。');setRevision(n=>n+1);})}>应用</Button>
      {r.appliedAgents.map(a=><Button size="sm" key={a} disabled={busy||!data?.canApply} onClick={()=>{if(window.confirm('移除 '+a+' 中的个人能力副本？'))void act(async()=>{await apiFetch(base+'/'+r.id+'/remove',{method:'POST',body:{agentId:a}});setRevision(n=>n+1);});}}>移除 {a} 中的副本</Button>)}
      <Button size="sm" disabled={busy||r.appliedAgents.length>0} onClick={()=>{if(window.confirm('删除此个人资源？'))void act(async()=>{await apiFetch(base+'/'+r.id,{method:'DELETE'});setRevision(n=>n+1);});}}>删除收藏</Button></div>
    </article>)}</div>
    <Modal open={open} title="上传技能" onClose={()=>{if(!busy)setOpen(false);}}>
      <div className="qm-upload">
        <label className="qm-agent">资源类型 <select aria-label="个人资源类型" value={kind} disabled={busy} onChange={e=>setKind(e.target.value)}><option value="skill">技能</option><option value="plugin">Skill 资源插件</option></select></label>
        <input ref={input} type="file" accept=".zip,.skill" hidden disabled={busy} aria-label="选择技能文件" onChange={e=>{pick(e.target.files?.[0]);e.target.value='';}} />
        <button type="button" className={`qm-dropzone ${dragging?'is-dragging':''}`} disabled={busy} onClick={()=>input.current?.click()} onDragOver={e=>{e.preventDefault();if(!busy)setDragging(true);}} onDragLeave={()=>setDragging(false)} onDrop={e=>{e.preventDefault();setDragging(false);if(!busy){if(e.dataTransfer.files.length>1){setUploadError('每次请选择一个文件。');setFile(null);}else pick(e.dataTransfer.files[0]);}}}>
          <span className="qm-upload-icon">⇧</span><strong>{file?file.name:<>拖放文件到此处，或 <em>点击上传</em></>}</strong><small>{file?`${(file.size/1024).toFixed(1)} KB · 点击重新选择`:'支持 .zip / .skill · ≤ 14 MB'}</small>
        </button>
        <ul className="qm-upload-notes"><li>技能包需包含 SKILL.md；.skill 文件须为 ZIP 格式。</li><li>资源插件仅支持 package.json 和 skills/ 等技能资源；含服务模块、依赖脚本、Hooks 或 MCP 的插件请由管理员维护。</li><li>资源按账号与项目保存。项目所有者可应用到空闲智能体，应用后当前项目成员可使用。</li><li>个人技能作为补充能力，不覆盖内置流程技能。</li></ul>
        {uploadError&&<p role="alert" className="my-2 text-sm text-red-600">{uploadError}</p>}
        <div className="qm-upload-footer"><Button disabled={busy} onClick={()=>setOpen(false)}>取消</Button><Button variant="primary" disabled={busy||!file||!projectId} onClick={()=>void upload()}>{busy?'正在导入…':'导入'}</Button></div>
      </div>
    </Modal>
  </section>;
}
