import { useEffect, useRef, useState } from 'react';
import { Button, Modal } from '@prismshadow/penguin-ui';
import { apiFetch } from '../../api/client';
import { useAuth } from '../../state/auth';
import { useProject } from '../../state/project';
import { canEditKnowledge, type DocumentView } from './project-knowledge-model';

type Preview = {
  source:{itemId:string; name:string; revision:string; contentHash:string; byteSize:number};
  reference:{documentId:string; revision:number; status:string; sameSourceRevision:boolean; matchesSource:boolean}|null;
  notice:string;
};
export function PersonalReferenceActions({projectId, document, onOpen}: {projectId:string; document:{id:string; name:string; kind:string; revision:string}; onOpen:(id:string)=>void}) {
  const {user}=useAuth(); const {currentProject}=useProject();
  const [preview,setPreview]=useState<Preview|null>(null), [error,setError]=useState(''), [confirm,setConfirm]=useState(false), [busy,setBusy]=useState(false);
  const endpoint=`/api/projects/${encodeURIComponent(projectId)}/agents/qa/knowledge/library/${encodeURIComponent(document.id)}`;
  const supported=document.kind==='file' && /\.(md|markdown|txt|json|csv|html?|ya?ml)$/i.test(document.name);
  useEffect(()=>{let alive=true;setPreview(null);setError('');setConfirm(false);
    if(supported) void apiFetch<Preview>(endpoint).then(v=>{if(alive)setPreview(v);}).catch(e=>{if(alive)setError(e.message);});
    return ()=>{alive=false;};
  },[endpoint,document.revision,supported]);
  if(!supported) return <p className="px-6 py-3 text-sm opacity-70">该资料可继续保存和查看；纳入项目参考资料目前支持文本文件，不会自动抓取链接或解析其他格式。</p>;
  const owner=canEditKnowledge(currentProject,user?.userId);
  const action=preview?.reference ? '更新项目引用版本' : '用于项目任务';
  async function commit() {
    if(!preview || busy)return;setBusy(true);setError('');
    try {
      const result=await apiFetch<{document:{document:{documentId:string}}}>(endpoint,{method:'POST',body:{confirmed:true,sourceRevision:preview.source.revision,contentHash:preview.source.contentHash,expectedDocumentRevision:preview.reference?.revision??null}});
      setConfirm(false);onOpen(result.document.document.documentId);
    } catch(e) {setError(e instanceof Error?e.message:'纳入失败');setConfirm(false);try{setPreview(await apiFetch<Preview>(endpoint));}catch{setPreview(null);}}
    finally{setBusy(false);}
  }
  return <div className="border-b px-6 py-3" style={{borderColor:'var(--qa-border)'}}>
    <div className="flex flex-wrap items-center gap-3 text-sm">
      <span>{preview?.reference ? `已关联项目参考资料 · 修订 ${preview.reference.revision}${preview.reference.status==='archived'?' · 已归档':preview.reference.sameSourceRevision&&preview.reference.matchesSource?' · 与当前资料一致':' · 版本存在差异'}` : '个人资料保留在本机，确认后可供项目任务引用。'}</span>
      {preview?.reference && <Button size="sm" onClick={()=>onOpen(preview.reference!.documentId)}>查看项目参考资料</Button>}
      {owner && <Button size="sm" disabled={busy || !preview || preview.reference?.status==='archived'} onClick={()=>setConfirm(true)}>{action}</Button>}
      {!owner && <span className="opacity-70">纳入项目参考资料需要项目所有者确认。</span>}
    </div>
    {error && <p role="alert" className="mt-2 text-sm text-red-600">{error}</p>}
    <Modal open={confirm} title={action} onClose={()=>{if(!busy)setConfirm(false);}}
      footer={<><Button disabled={busy} onClick={()=>setConfirm(false)}>取消</Button><Button variant="primary" disabled={busy||!preview} onClick={()=>void commit()}>确认纳入当前版本</Button></>}>
      <div className="space-y-3 text-sm"><p>{preview?.source.name} · {preview?.source.byteSize} 字节</p><p>{preview?.notice}</p>
        {preview?.reference && <p>将更新已关联的同一份项目参考资料，保留旧修订。参考资料中的独立编辑也会被本次文本替换，请核对后确认。</p>}
      </div>
    </Modal>
  </div>;
}

export function ProjectReferenceSearch({projectId,query,onOpen}: {projectId:string;query:string;onOpen:(id:string)=>void}) {
  const [rows,setRows]=useState<DocumentView[]>([]),[error,setError]=useState(''),[loading,setLoading]=useState(false),[more,setMore]=useState<string|null>(null);
  const base=`/api/projects/${encodeURIComponent(projectId)}/agents/qa/documents?q=${encodeURIComponent(query.trim())}&status=active&limit=50`;
  const activeBase=useRef(base);
  activeBase.current=base;
  useEffect(()=>{let alive=true;setRows([]);setError('');setMore(null);setLoading(!!query.trim());
    const timer=setTimeout(()=>{if(query.trim())void apiFetch<{documents:DocumentView[];nextCursor:string|null}>(base).then(r=>{if(alive){setRows(r.documents);setMore(r.nextCursor);}}).catch(e=>{if(alive)setError(e.message);}).finally(()=>{if(alive)setLoading(false);});},200);
    return ()=>{alive=false;clearTimeout(timer);};
  },[base,query]);
  async function loadMore(){if(!more||loading)return;setLoading(true);try{const r=await apiFetch<{documents:DocumentView[];nextCursor:string|null}>(`${base}&cursor=${encodeURIComponent(more)}`);if(activeBase.current!==base)return;setRows(old=>[...old,...r.documents]);setMore(r.nextCursor);}catch(e){if(activeBase.current===base)setError(e instanceof Error?e.message:'查询失败');}finally{if(activeBase.current===base)setLoading(false);}}
  return <section className="my-5 rounded border p-4" style={{borderColor:'var(--qa-border)'}}><h3 className="mb-3 font-medium">项目参考资料</h3>
    {!query.trim()?<p className="text-sm opacity-70">输入关键词，同时查找我的资料名称与项目参考资料标题、正文。</p>:loading&&!rows.length?<p>正在检索…</p>:!rows.length?<p className="text-sm opacity-70">没有匹配的项目参考资料。</p>:rows.map(row=><button key={row.documentId} className="block w-full rounded p-2 text-left text-sm hover:bg-gray-100" onClick={()=>onOpen(row.documentId)}>{row.title} · 修订 {row.revision}</button>)}
    {more&&<Button size="sm" disabled={loading} onClick={()=>void loadMore()}>加载更多参考资料</Button>}
    {error&&<p role="alert" className="text-sm text-red-600">{error}</p>}
  </section>;
}
