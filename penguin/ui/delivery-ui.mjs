const extensions=/\.(html?|pdf|png|jpe?g|webp|xlsx|docx|xmind|md|csv|zip)$/i;
const office=/\.(xlsx|docx|xmind)$/i;

export function localDeliveryPath(value, workspace) {
  if(typeof value!=='string') return null;
  let path;try {path=decodeURIComponent(value.trim());} catch {return null;}
  if(!path || /[\x00-\x1f?#]/.test(path) || path.startsWith('//') || path.startsWith('\\\\')) return null;
  path=path.replaceAll('\\','/');
  const base=workspace?.replaceAll('\\','/').replace(/\/$/,'');
  if(/^[a-z]:\//i.test(path)) {
    if(!base || !path.toLowerCase().startsWith(`${base.toLowerCase()}/`)) return null;
    path=path.slice(base.length+1);
  } else if(path.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(path)) return null;
  const parts=path.split('/').filter(p=>p && p!=='.');
  if(parts.some(p=>p==='..' || p.includes(':'))) return null;
  return parts.length?parts.join('/'):null;
}

export function extractDeliveries(text,workspace) {
  const found=new Map();
  const add=(raw,label)=>{const path=localDeliveryPath(raw,workspace);if(path && extensions.test(path) && !found.has(path)) found.set(path,{path,label:label || path.split('/').at(-1)});};
  for(const m of text.matchAll(/\[([^\]\n]+)\]\(\s*(?:<([^>\n]+)>|([^\s)]+))\s*\)/g)) add(m[2]??m[3],m[1]);
  for(const m of text.matchAll(/`([^`\n]+)`/g)) add(m[1]);
  return [...found.values()];
}

export function normalizeDeliveryItems(items) {
  const result=[];let placeholder=false;
  for(const item of items) {
    if(item.kind==='thinking' && (item.stopReason===undefined || item.stopReason==='completed') && typeof item.thinking==='string' && item.thinking.length<=64 && /^[\s.\u2026\u3002\u00b7]*$/.test(item.thinking)) {
      placeholder=true;continue;
    }
    const previous=result.at(-1);
    const sameBoundary=previous && ['requestId','turnId','sessionId'].every(key=>previous[key]===item[key]);
    if(placeholder && previous?.kind==='assistant_text' && item.kind==='assistant_text' && sameBoundary &&
      typeof previous.text==='string' && typeof item.text==='string' && !['aborted','fatal'].includes(previous.stopReason)) {
      result[result.length-1]={...previous,text:previous.text+item.text,streaming:item.streaming,stopReason:item.stopReason};
    } else result.push(item);
    placeholder=false;
  }
  return result;
}

// Only texts structurally followed by work are folded; the final answer and errors stay visible.
export function groupDeliveryItems(items) {
  items=normalizeDeliveryItems(items);
  const segments=[];let pending=[];
  const flush=()=>{if(pending.length) segments.push({type:'group',items:pending});pending=[];};
  for(let i=0;i<items.length;i++) {
    const item=items[i];
    const work=['thinking','tool_call','subagent'].includes(item.kind);
    let intermediate=false;
    if(item.kind==='assistant_text' && !item.streaming) {
      for(let j=i+1;j<items.length;j++) {
        if(['user_text','user_image','user_steering','task_stats','abort','llm_error','reconnect'].includes(items[j].kind)) break;
        if(['tool_call','subagent'].includes(items[j].kind)) {intermediate=true;break;}
      }
    }
    if(work || intermediate) pending.push(item);
    else {flush();segments.push({type:'single',item});}
  }
  flush();return segments;
}

export function createDeliveryUI({React,jsx,jsxs,Markdown,Icon,fileIcon}) {
  const style={border:'1px solid #d1d5db',borderRadius:6,padding:'10px 12px',display:'flex',alignItems:'center',gap:10,minWidth:0};
  function Message({item,ctx}) {
    const [error,setError]=React.useState('');
    const [existing,setExisting]=React.useState(null);
    const files=React.useMemo(()=>extractDeliveries(item.text,ctx.workspace),[item.text,ctx.workspace]);
    React.useEffect(()=>{let disposed=false;setExisting(null);if(ctx.statFiles && files.length) ctx.statFiles(files.map(x=>x.path)).then(value=>{if(!disposed)setExisting(value);}).catch(()=>{if(!disposed)setError('暂时无法检查文件，请稍后点击重试。');});return()=>{disposed=true;};},[files,ctx.statFiles]);
    const url=(path,mode='content')=>`/api/sessions/${encodeURIComponent(ctx.sessionId)}/files/${mode}?path=${encodeURIComponent(path)}`;
    const open=async(path,native=false)=>{
      setError('');
      try {
        const check=await fetch(`/api/sessions/${encodeURIComponent(ctx.sessionId)}/files/stat`,{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({paths:[path]})});
        if(!check.ok) throw new Error('File check unavailable');
        if(!(await check.json()).existing.includes(path)) throw new Error('文件不存在或已移动，请检查交付文件。');
        if(native) {
          const response=await fetch(url(path,'open-deliverable'),{method:'POST',credentials:'same-origin'});
          if(!response.ok) {setError(response.status===403?'本机打开仅支持桌面应用；可使用下载或在文件夹中显示。':response.status===404?'文件打开接口暂不可用；可使用下载或在文件夹中显示。':response.status===504?'打开超时，请先查看桌面是否已打开文档；也可下载或在文件夹中显示。':'未能打开本机应用；可使用下载或在文件夹中显示。');return;}
        } else ctx.onOpenFile(path);
      } catch(e) {setError(e.message==='文件不存在或已移动，请检查交付文件。'?e.message:'暂时无法打开文件，请稍后重试。');}
    };
    const reveal=async path=>{
      setError('');
      try {const response=await fetch(url(path,'reveal'),{method:'POST',credentials:'same-origin'});if(!response.ok) setError('在文件夹中显示仅支持桌面应用；也可点击文件预览或下载。');}
      catch {setError('暂时无法打开文件夹。');}
    };
    const components={a:({href,children})=>{
      const path=localDeliveryPath(href,ctx.workspace);
      if(path && extensions.test(path)) return jsx('a',{href:url(path),onClick:e=>{e.preventDefault();void open(path,office.test(path));},children});
      if(typeof href==='string' && /^(https?:|mailto:|#)/i.test(href)) return jsx('a',{href,target:href.startsWith('#')?undefined:'_blank',rel:'noopener noreferrer',children});
      return jsx('span',{children});
    }};
    const visible=files.filter(file=>existing?.has(file.path));
    return jsxs('div',{className:'md-body anim-msg my-3 text-base leading-relaxed text-gray-800 dark:text-gray-100','data-qa-delivery-message':true,children:[
      jsx(Markdown,{text:item.text,streaming:item.streaming,components}),
      !item.streaming && visible.length>0 && jsxs('section',{'aria-label':'交付文件',style:{display:'grid',gap:8,marginTop:12},children:[
        ...visible.map(file=>jsxs('div',{style,children:[jsx(Icon,{d:fileIcon,size:18}),jsxs('div',{style:{flex:1,minWidth:0},children:[jsx('a',{href:url(file.path),title:file.path,onClick:e=>{e.preventDefault();void open(file.path,office.test(file.path));},style:{overflowWrap:'anywhere',fontWeight:600},children:file.label}),jsx('div',{style:{fontSize:12,color:'#6b7280'},children:file.path.split('.').at(-1).toUpperCase()})]}),jsx('a',{href:`${url(file.path)}&download=1`,download:true,style:{fontSize:13,flexShrink:0},children:'下载'})]},file.path)),
        jsx('button',{type:'button',onClick:()=>void reveal(visible[0].path),style:{textAlign:'left',fontSize:13,color:'inherit'},children:'在文件夹中显示'})]}),
      error && jsx('p',{role:'alert',style:{color:'#b91c1c',fontSize:13},children:error})
    ]});
  }
  return Message;
}
