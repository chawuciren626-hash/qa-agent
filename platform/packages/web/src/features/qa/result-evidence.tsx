import { useState } from "react";
import { createPortal } from "react-dom";
import { artifactUrl, safeEvidencePath } from "./task-results";
import { ArtifactPreview } from "./artifact-preview";

const imageFile = (name: string) => /\.(png|jpe?g|webp)$/i.test(name);
const jsonFile = (name: string) => /\.json$/i.test(name);

export function splitResultEvidence(references: string[] = []) {
  return {
    screenshots: references.filter(reference => imageFile(reference)),
    evidence: references.filter(reference => !imageFile(reference)),
  };
}

export function ResultEvidenceFields({ sessionId, runId, references }: { sessionId: string; runId: string; references?: string[] }) {
  const groups = splitResultEvidence(references);
  return <>
    <div><strong>结果截图</strong><ResultEvidence sessionId={sessionId} runId={runId} references={groups.screenshots} empty="暂无结果截图"/></div>
    <div><strong>结果取证</strong><ResultEvidence sessionId={sessionId} runId={runId} references={groups.evidence} empty="暂无结果取证文件"/></div>
  </>;
}

export function ResultEvidence({ sessionId, runId, references, empty = "暂无证据文件" }: { sessionId: string; runId: string; references?: string[]; empty?: string }) {
  const [opened, setOpened] = useState<{ path: string; name: string } | null>(null);
  const [scale, setScale] = useState(1);
  const [json, setJson] = useState<string | null>(null);
  const [error, setError] = useState("");
  async function preview(path: string, name: string) {
    setOpened({ path, name }); setScale(1); setJson(null); setError("");
    if (!jsonFile(name)) return;
    try {
      const response = await fetch(artifactUrl(sessionId, path), { credentials: "include" });
      if (!response.ok) throw Error(`HTTP ${response.status}`);
      const raw = await response.text();
      if (raw.length > 2 * 1024 * 1024) throw Error("文件超过预览大小限制");
      setJson(raw);
    } catch { setError("取证文件读取失败，请在阶段产物中查看或下载。"); }
  }
  const viewer = opened && createPortal(jsonFile(opened.name) ?
    <div className="qtd-mask" role="presentation" onMouseDown={event=>{if(event.target===event.currentTarget)setOpened(null);}}><div className="qtd-modal qtd-artifact-modal" role="dialog" aria-modal="true" aria-label={`预览 ${opened.name}`}><header><strong>{opened.name}</strong><button type="button" onClick={()=>setOpened(null)} aria-label="关闭预览">✕</button></header>{error ? <p className="qtd-preview-content" role="alert">{error}</p> : json !== null ? <ArtifactPreview preview={{name:opened.name,kind:"json",text:json}}/> : <p className="qtd-preview-content" role="status">正在读取取证文件…</p>}<footer><button type="button" onClick={()=>setOpened(null)}>关闭</button></footer></div></div> :
    <div className="qtd-image-mask" role="presentation" onMouseDown={event=>{if(event.target===event.currentTarget)setOpened(null);}}><section role="dialog" aria-modal="true" aria-label="结果截图预览" className="qtd-image-viewer"><header><strong>{opened.name}</strong><div><button type="button" onClick={()=>setScale(value=>Math.max(.25,value-.25))}>缩小</button><span>{Math.round(scale*100)}%</span><button type="button" onClick={()=>setScale(value=>Math.min(4,value+.25))}>放大</button><button type="button" onClick={()=>setScale(1)}>适应窗口</button><button type="button" onClick={()=>setOpened(null)} aria-label="关闭截图预览">×</button></div></header><div className="qtd-image-scroll"><img src={artifactUrl(sessionId,opened.path)} alt={opened.name} style={{width:`${scale*100}%`}}/></div></section></div>, document.body);
  return <><span className="qtd-evidence-list">{references?.length ? references.map((reference,index) => {
    const path=safeEvidencePath(reference,runId), name=path?.split("/").at(-1) ?? "";
    return <span key={`${reference}-${index}`}>{path ? <>{imageFile(name) || jsonFile(name) ? <button type="button" className="qtd-link-button" onClick={()=>void preview(path,name)}>{name || `证据 ${index+1}`}</button> : <a href={artifactUrl(sessionId,path)} target="_blank" rel="noopener noreferrer">{name || `证据 ${index+1}`}</a>}{imageFile(name) && <button type="button" className="qtd-evidence-thumb" aria-label={`放大查看证据 ${index+1}`} onClick={()=>void preview(path,name)}><img src={artifactUrl(sessionId,path)} alt={`证据 ${index+1}`}/></button>}</> : "原路径不可用"}</span>;
  }) : empty}</span>{viewer}</>;
}
