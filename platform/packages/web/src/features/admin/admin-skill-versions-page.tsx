import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, ConfirmModal, Modal, PageHeader, toastError, toastSuccess } from "@prismshadow/penguin-ui";
import { controlRequest } from "../../api/control";
import { apiErrorText } from "../../lib/api-error";
import { CentralSkillFiles } from "../skills/central-skill-files";
import { skillPresentation } from "../skills/skill-presentation";
import "./admin-skill-versions-page.css";

type FileInfo={path:string;size:number;hash:string};
type Version={label:string;state:"draft"|"current"|"published";revision:number;changeNote:string;createdAt:string;files:FileInfo[];size:number};
type Detail={name:string;description:string;content:string;files:Record<string,string>;revision:number;changeNote:string};
type Management={skill:{name:string;description:string;content:string;categoryId:string};versions:Version[];currentLabel:string|null;agentCount:number};
type DiffFile={path:string;change:string;oldText:string|null;newText:string|null;oldHash:string|null;newHash:string|null};
type Comparison={newer:string;older:string;files:DiffFile[]};
const root="/api/control/skills/admin";

const fmtTime=(iso:string)=>{const d=new Date(iso);if(Number.isNaN(+d))return iso;const p=(n:number)=>String(n).padStart(2,"0");return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;};
const fmtSize=(n:number)=>n<1024?`${n} B`:n<1048576?`${(n/1024).toFixed(1)} KB`:`${(n/1048576).toFixed(1)} MB`;
const fileIcon=(path:string)=>path.endsWith(".md")?"📄":path.endsWith(".py")?"🐍":/\.(ya?ml|json)$/.test(path)?"⚙️":"📄";
const iconColor=(categoryId?:string)=>categoryId==="design"?"#7b61ff":categoryId==="code"?"#2ea86e":categoryId==="data"?"#b8821e":"#185fa5";
const stateTag={current:{t:"使用中",cls:"green"},published:{t:"已发布",cls:"blue"},draft:{t:"草稿",cls:"amber"}} as const;

/** 纯展示：行级 LCS diff，输入两段文本，输出按序排列的 ctx/del/add 行。 */
function lineDiff(oldText:string,newText:string):{type:"ctx"|"del"|"add";text:string}[]{
  const a=oldText.split("\n");
  const b=newText.split("\n");
  const n=a.length;
  const m=b.length;
  const dp:number[][]=Array.from({length:n+1},()=>new Array<number>(m+1).fill(0));
  for(let i=n-1;i>=0;i--)for(let j=m-1;j>=0;j--){const match=a[i]===b[j]?dp[i+1]![j+1]!+1:Math.max(dp[i+1]![j]!,dp[i]![j+1]!);dp[i]![j]=match;}
  const lines:{type:"ctx"|"del"|"add";text:string}[]=[];
  let i=0;
  let j=0;
  while(i<n&&j<m){
    if(a[i]===b[j]){lines.push({type:"ctx",text:a[i]!});i++;j++;}
    else if(dp[i+1]![j]!>=dp[i]![j+1]!){lines.push({type:"del",text:a[i]!});i++;}
    else{lines.push({type:"add",text:b[j]!});j++;}
  }
  while(i<n){lines.push({type:"del",text:a[i]!});i++;}
  while(j<m){lines.push({type:"add",text:b[j]!});j++;}
  return lines;
}

function download(name:string,base64:string,label:string){const bytes=Uint8Array.from(atob(base64),char=>char.charCodeAt(0));const url=URL.createObjectURL(new Blob([bytes],{type:"application/zip"}));const link=document.createElement("a");link.href=url;link.download=`${name}-${label}.zip`;link.click();URL.revokeObjectURL(url);}

const filterTabs=[["all","全部"],["current","使用中"],["published","已发布"],["draft","草稿"]] as const;
const filterLabel=(filter:string)=>filter==="current"?"使用中":filter==="published"?"已发布":"草稿";

export function AdminSkillVersionsPage({id,back}:{id:string;back:()=>void}){
  const base=`${root}/${id}`;
  const [data,setData]=useState<Management|null>(null);
  const [error,setError]=useState("");
  const [busy,setBusy]=useState(false);
  const [filter,setFilter]=useState("all");
  const [creating,setCreating]=useState(false);
  const [newLabel,setNewLabel]=useState("");
  const [newNote,setNewNote]=useState("");
  const [copyCurrent,setCopyCurrent]=useState(true);
  const [detail,setDetail]=useState<{label:string;data:Detail}|null>(null);
  const [editing,setEditing]=useState(false);
  const [description,setDescription]=useState("");
  const [content,setContent]=useState("");
  const [note,setNote]=useState("");
  const [confirm,setConfirm]=useState<{kind:"delete"|"rollback"|"publish";version:Version}|null>(null);
  const [selected,setSelected]=useState<string[]>([]);
  const [diff,setDiff]=useState<Comparison[]|null>(null);
  const refresh=useCallback(async()=>{try{setData(await controlRequest(`${base}/version-management`));setError("");}catch(cause){setError(apiErrorText(cause));}},[base]);
  useEffect(()=>{void refresh();},[refresh]);
  const versions=data?.versions??[];
  const shown=useMemo(()=>filter==="all"?versions:versions.filter(v=>v.state===filter),[versions,filter]);
  const suggest=()=>{const current=data?.currentLabel;const match=/^V(\d+)\.(\d+)\.(\d+)$/.exec(current??"");const proposed=match?`V${match[1]}.${Number(match[2])+1}.0`:"V1.0.0";setNewLabel(proposed);setNewNote("");setCopyCurrent(true);setCreating(true);};
  const open=async(version:Version,edit=false)=>{try{const result=await controlRequest(`${base}/version-management/${version.label}`) as Detail;setDetail({label:version.label,data:result});setDescription(result.description);setContent(result.content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/,"").trim());setNote(result.changeNote);setEditing(edit);}catch(cause){toastError(apiErrorText(cause));}};
  const mutate=async(path:string,method:string,body?:unknown,success?:string)=>{setBusy(true);try{await controlRequest(path,method,body);await refresh();setDetail(null);setConfirm(null);toastSuccess(success??"操作已完成");}catch(cause){toastError(apiErrorText(cause));}finally{setBusy(false);}};
  const confirmAction=()=>{if(!confirm)return;const {kind,version}=confirm;const message=kind==="publish"?`「${version.label}」已发布，成为当前使用版本`:kind==="rollback"?`已切换为使用版本「${version.label}」，原版本保留在历史中`:`草稿「${version.label}」已删除`;void mutate(`${base}/version-management/${version.label}${kind==="delete"?"":`/${kind}`}`,kind==="delete"?"DELETE":"POST",kind==="publish"?{revision:version.revision}:undefined,message);};
  const exportVersion=async(version:Version)=>{try{const result=await controlRequest(`${base}/version-management/${version.label}/export`);download(data?.skill.name??"skill",result.dataBase64,version.label);}catch(cause){toastError(apiErrorText(cause));}};
  const toggleCompare=(label:string)=>setSelected(old=>old.includes(label)?old.filter(item=>item!==label):[...old,label]);
  const cmpLabels=useMemo(()=>[...selected].sort((a,b)=>{const ta=versions.find(v=>v.label===a)?.createdAt??"";const tb=versions.find(v=>v.label===b)?.createdAt??"";return Date.parse(tb)-Date.parse(ta);}),[selected,versions]);
  const compare=async()=>{
    if(cmpLabels.length<2){toastError("请勾选2个及以上版本进行对比");return;}
    try{
      const pairs=cmpLabels.slice(0,-1).map((newer,index)=>({newer,older:cmpLabels[index+1]!}));
      const results=await Promise.all(pairs.map(async pair=>({
        ...pair,
        ...(await controlRequest(`${base}/version-diff?a=${encodeURIComponent(pair.older)}&b=${encodeURIComponent(pair.newer)}`) as {files:DiffFile[]}),
      })));
      setDiff(results);
    }catch(cause){toastError(apiErrorText(cause));}
  };
  const current=versions.find(v=>v.state==="current");
  const presentation=data?skillPresentation(data.skill):null;
  return <div className="admin-skill-version-page">
    <PageHeader title={`${presentation?.displayName??"技能"} · 版本管理`} description="管理草稿、已发布版本和当前使用版本" back={{label:"返回技能列表",onClick:back}} actions={<><Button onClick={()=>void compare()}>⇄ 版本对比</Button><Button variant="primary" onClick={suggest}>＋ 新建版本</Button></>}/>
    {error&&<p role="alert" className="admin-skill-error">{error}</p>}
    <div className="skill-version-layout">
      <aside className="skill-version-sidebar">
        <section className="sv-card">
          <div className="sv-info-top">
            <div className="sv-icon" style={{background:iconColor(data?.skill.categoryId)}} aria-hidden>{(data?.skill.name??"技").charAt(0)}</div>
            <div>
              <p className="sv-info-name">{presentation?.displayName??"加载中…"}</p>
              <p className="sv-info-id">{data?.skill.name??id}</p>
            </div>
          </div>
          <p className="sv-info-desc">{presentation?.summary}</p>
          <div className="sv-info-meta">
            <span className="sv-tag grey">{data?.skill.categoryId}</span>
            <span className="sv-tag grey">内置技能</span>
          </div>
        </section>
        <section className="sv-card">
          <span className="sv-cur-lab">当前使用版本</span>
          <div className="sv-cur-row">
            <span className="sv-cur-num">{data?.currentLabel??"尚未发布"}</span>
            {current&&<span className="sv-tag green">使用中</span>}
          </div>
          <div className="sv-stat-row">
            <div className="sv-stat"><b>{versions.length}</b><span>版本数</span></div>
            <div className="sv-stat"><b>{current?.files.length??0}</b><span>文件数</span></div>
            <div className="sv-stat"><b>{data?.agentCount??0}</b><span>引用智能体</span></div>
          </div>
        </section>
        <section className="sv-card">
          <h3 className="sv-side-title">📄 当前版本文件</h3>
          {current?.files.map(file=>(
            <div className="sv-file-item" key={file.path}>
              <span aria-hidden>{fileIcon(file.path)}</span>
              <span className="sv-file-path">{file.path}</span>
              <span className="sv-file-size">{fmtSize(file.size)}</span>
            </div>
          ))??<p className="skill-version-muted">暂无文件</p>}
        </section>
        <section className="sv-card">
          <h3 className="sv-side-title">💡 版本号规则</h3>
          <p className="sv-rule-tip">
            采用三段式语义化版本 <code>主.次.修订</code>：<br/>
            主版本 — 协议不兼容变更；<br/>
            次版本 — 新增能力或文件；<br/>
            修订 — 描述与参数微调。<br/>
            新建版本时自动基于当前版本号 +1 建议。
          </p>
        </section>
      </aside>
      <main className="skill-version-main">
        <div className="sv-rp-head">
          <h2 className="sv-rp-title">版本历史</h2>
          <span className="sv-rp-count">共 {versions.length} 个版本</span>
          <div className="sv-chips">
            {filterTabs.map(([key,label])=>{
              const count=key==="all"?versions.length:versions.filter(v=>v.state===key).length;
              return <button key={key} type="button" className={`sv-t-chip${filter===key?" active":""}`} aria-pressed={filter===key} onClick={()=>setFilter(prev=>prev===key?"all":key)}>{label} {count}</button>;
            })}
          </div>
        </div>
        {data===null&&!error
          ?<p className="skill-version-muted">正在加载版本…</p>
          :versions.length===0
            ?<div className="sv-empty">
              <p className="skill-version-muted">该技能还没有任何版本。</p>
              <button type="button" className="sv-op pri" onClick={suggest}>＋ 创建首个版本</button>
            </div>
            :shown.length===0
              ?<p className="skill-version-muted">「{filterLabel(filter)}」状态下暂无版本，试试切换到「全部」。</p>
              :<div className="sv-tl">
                {shown.map(version=>(
                  <article key={version.label} className={`sv-ver ${version.state}${version.state==="current"?" cur":""}`}>
                    <div className="sv-ver-head">
                      <span className="sv-ver-num">{version.label}</span>
                      <span className={`sv-tag ${stateTag[version.state].cls}`}>{stateTag[version.state].t}</span>
                      {version.state==="current"&&<span className="sv-tag green">● 当前使用</span>}
                      <span className="sv-ver-time">{fmtTime(version.createdAt)}</span>
                    </div>
                    <div className="sv-ver-meta">
                      <span>📦 {fmtSize(version.size)}</span>
                      <span>📄 {version.files.length} 个文件</span>
                    </div>
                    <p className={`sv-ver-log${version.changeNote?"":" sv-ver-log-empty"}`}>{version.changeNote||"暂无变更说明"}</p>
                    <div className="sv-fchips">{version.files.map(file=><span className="sv-fchip" key={file.path}>{file.path}</span>)}</div>
                    <div className="sv-ver-ops">
                      {version.state==="draft"&&<>
                        <button type="button" className="sv-op pri" onClick={()=>setConfirm({kind:"publish",version})}>发布</button>
                        <button type="button" className="sv-op" onClick={()=>void open(version,true)}>编辑</button>
                        <button type="button" className="sv-op danger" onClick={()=>setConfirm({kind:"delete",version})}>删除</button>
                      </>}
                      {version.state==="published"&&<button type="button" className="sv-op pri" onClick={()=>setConfirm({kind:"rollback",version})}>回滚到此版本</button>}
                      {version.state==="current"&&<span title="已是当前使用版本"><button type="button" className="sv-op" disabled>回滚到此版本</button></span>}
                      <button type="button" className="sv-op" onClick={()=>void open(version)}>预览</button>
                      <button type="button" className="sv-op" onClick={()=>void exportVersion(version)}>下载</button>
                      <label className={`sv-cmp-pick${selected.includes(version.label)?" picked":""}`}>
                        <input type="checkbox" checked={selected.includes(version.label)} onChange={()=>toggleCompare(version.label)} aria-label={`选择 ${version.label} 参与对比`}/>
                        对比
                      </label>
                    </div>
                  </article>
                ))}
              </div>}
      </main>
    </div>
    {selected.length>0&&<div className="skill-version-selection" role="status">已勾选 {selected.length} 个版本 <button type="button" onClick={()=>setSelected([])}>清除选择</button></div>}
    {creating&&<Modal open title="新建技能版本" onClose={()=>setCreating(false)} footer={<><Button onClick={()=>setCreating(false)}>取消</Button><Button variant="primary" disabled={busy||!/^V\d+\.\d+\.\d+$/.test(newLabel)} onClick={async()=>{setBusy(true);try{await controlRequest(`${base}/version-management`,"POST",{label:newLabel,changeNote:newNote,copyCurrent});setCreating(false);await refresh();toastSuccess(`草稿版本「${newLabel}」已创建`);}catch(cause){toastError(apiErrorText(cause));}finally{setBusy(false);}}}>创建草稿</Button></>}>
      <div className="skill-version-form">
        <label>版本号<input value={newLabel} onChange={event=>setNewLabel(event.target.value)}/></label>
        {newLabel&&!/^V\d+\.\d+\.\d+$/.test(newLabel)&&<p className="sv-hint-error">版本号格式为 V主.次.修订，例如 V1.5.0</p>}
        <p className="sv-hint">{data?.currentLabel?`基于当前版本 ${data.currentLabel} 自动建议（次版本 +1），可手动修改。`:"当前无使用版本，默认 V1.0.0"}</p>
        <label>变更说明<textarea value={newNote} onChange={event=>setNewNote(event.target.value)} placeholder="描述本次版本的主要变更，将展示在版本历史中…"/></label>
        <label className="check-row"><input type="checkbox" checked={copyCurrent} onChange={event=>setCopyCurrent(event.target.checked)}/> 基于当前使用版本复制文件</label>
        <p className="sv-hint">关闭则从空白草稿开始。新版本以「草稿」状态创建，不影响当前使用中的版本。</p>
      </div>
    </Modal>}
    {detail&&<Modal open title={`${detail.label} · ${editing?"编辑草稿":"预览"}`} onClose={()=>setDetail(null)} widthClass="sm:max-w-4xl" footer={editing?<><Button onClick={()=>setEditing(false)}>取消编辑</Button><Button variant="primary" disabled={busy||!description.trim()||!content.trim()} onClick={()=>void mutate(`${base}/version-management/${detail.label}`,"PUT",{revision:detail.data.revision,description,content,changeNote:note},`草稿「${detail.label}」已保存`)}>保存草稿</Button></>:undefined}>
      {editing?<div className="skill-version-form">
        <label>技能描述<textarea value={description} onChange={event=>setDescription(event.target.value)}/></label>
        <label>变更说明<textarea value={note} onChange={event=>setNote(event.target.value)}/></label>
        <label>SKILL.md 正文<textarea className="skill-version-body" value={content} onChange={event=>setContent(event.target.value)}/></label>
        <p className="sv-hint">附属文件保持原样。</p>
      </div>:<CentralSkillFiles name={data?.skill.name??"skill"} files={detail.data.files}/>}
    </Modal>}
    {diff&&<Modal open title={`版本对比 · ${diff.length+1} 个版本`} onClose={()=>setDiff(null)} widthClass="sm:max-w-4xl">
      {diff.map(pair=><div key={`${pair.newer}-${pair.older}`} className="sv-diff-pair"><h3>{pair.newer} ← {pair.older}</h3>
      {pair.files.length===0?<p className="skill-version-muted">两个版本的文件内容相同。</p>:pair.files.map(file=>{
        const lines=file.oldText!==null&&file.newText!==null?lineDiff(file.oldText,file.newText):null;
        const deleted=lines?.filter(line=>line.type==="del").length??0;
        const added=lines?.filter(line=>line.type==="add").length??0;
        return <section className="sv-diff-file" key={file.path}>
          <div className="sv-df-head">
            <span className="sv-df-path">{file.path}</span>
            {lines!==null&&<span className="sv-df-chg"><b className="minus">−{deleted}</b> <b className="plus">+{added}</b></span>}
            {lines===null&&<span className="sv-df-chg">{file.change==="added"?"新增":file.change==="removed"?"移除":"修改"}</span>}
          </div>
          {lines===null
            ?<p className="sv-df-note">二进制文件或单侧文件变化：{file.oldHash??"无"} → {file.newHash??"无"}</p>
            :<div className="sv-df-body">{lines.map((line,index)=><div key={index} className={`sv-dl ${line.type}`}>{line.text}</div>)}</div>}
        </section>;
      })}</div>)}
    </Modal>}
    <ConfirmModal open={!!confirm} tone={confirm?.kind==="delete"?"danger":"primary"} title={confirm?.kind==="delete"?`删除草稿 ${confirm.version.label}`:confirm?.kind==="publish"?`发布 ${confirm.version.label}`:`回滚到 ${confirm?.version.label}`} busy={busy} onClose={()=>setConfirm(null)} onConfirm={confirmAction} confirmLabel="确认" cancelLabel="取消">
      {confirm?.kind==="publish"&&<p>确认发布「{data?.skill.name??"技能"}」<b>{confirm.version.label}</b>？发布后内容将不可修改，并立即成为当前使用版本。</p>}
      {confirm?.kind==="rollback"&&<p>确认将使用版本从 <b>{data?.currentLabel??"—"}</b> 切换到 <b>{confirm.version.label}</b>？回滚不会删除任何版本，当前版本会保留在历史中，可随时切回。</p>}
      {confirm?.kind==="delete"&&<p>确认删除草稿 <b>{confirm.version.label}</b>？删除后不可恢复，不影响当前使用中的版本。</p>}
    </ConfirmModal>
  </div>;
}
