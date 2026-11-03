import { useState } from "react";
import { artifactUrl, safeEvidencePath } from "./task-results";

export function ResultEvidence({ sessionId, runId, references }: { sessionId: string; runId: string; references?: string[] }) {
  const [opened, setOpened] = useState("");
  const [scale, setScale] = useState(1);
  return <><span className="qtd-evidence-list">{references?.length ? references.map((reference,index) => {
    const path=safeEvidencePath(reference,runId), name=path?.split("/").at(-1) ?? "";
    return <span key={index}>{path ? <><a href={artifactUrl(sessionId,path)} target="_blank" rel="noopener noreferrer">{name || `证据 ${index+1}`}</a>{/\.(png|jpe?g|webp)$/i.test(name) && <button type="button" className="qtd-evidence-thumb" aria-label={`放大查看证据 ${index+1}`} onClick={()=>{setOpened(path);setScale(1);}}><img src={artifactUrl(sessionId,path)} alt={`证据 ${index+1}`}/></button>}</> : "原路径不可用"}</span>;
  }) : "暂无结果截图或证据文件"}</span>{opened && <div className="qtd-image-mask" role="presentation" onMouseDown={event=>{if(event.target===event.currentTarget)setOpened("");}}><section role="dialog" aria-modal="true" aria-label="放大查看截图" className="qtd-image-viewer"><header><strong>查看截图</strong><div><button type="button" onClick={()=>setScale(value=>Math.max(.25,value-.25))}>缩小</button><span>{Math.round(scale*100)}%</span><button type="button" onClick={()=>setScale(value=>Math.min(4,value+.25))}>放大</button><button type="button" onClick={()=>setScale(1)}>适应窗口</button><button type="button" onClick={()=>setOpened("")} aria-label="关闭截图">×</button></div></header><div className="qtd-image-scroll"><img src={artifactUrl(sessionId,opened)} alt="放大的结果截图" style={{width:`${scale*100}%`}}/></div></section></div>}</>;
}
