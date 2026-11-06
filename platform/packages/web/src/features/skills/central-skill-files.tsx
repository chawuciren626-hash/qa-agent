import { useState } from "react";
import { FileBrowser, type TreeToggle } from "@prismshadow/penguin-ui";
import { S } from "../../lib/strings";
import { useReaderFind } from "../../lib/reader-find";
import { groupPluginFiles, pluginTreeRows } from "../plugins/plugin-detail";

export function CentralSkillFiles({name,files}:{name:string;files:Record<string,string>}){
  const [selected,setSelected]=useState<string|null>(null);
  const [collapsed,setCollapsed]=useState<ReadonlySet<string>>(new Set());
  const [toggled,setToggled]=useState<TreeToggle|null>(null);
  const readerFind=useReaderFind();
  const prefix=`skills/${name}/`;
  const groups=groupPluginFiles(Object.keys(files).map(path=>prefix+path),[name],S.plugins.detailHooks);
  const current=selected??groups[0]?.paths[0]??null;
  const relative=current?.slice(prefix.length);
  const content=relative===undefined?undefined:files[relative];
  return <FileBrowser rows={pluginTreeRows(groups,collapsed)} treeLabel={S.files.treeLabel} selectedPath={current} toggled={toggled} treeLoading={false} treeError={null} headerFallback={name} preview={current&&content!==undefined?{path:current,name:current.split("/").at(-1)!,kind:/\.md$/i.test(current)?"md":"text",content}:null} emptyPreview={S.common.none} emptyDirLabel={S.files.empty} truncatedLabel={S.files.previewTruncated} unsupportedLabel={S.files.previewUnsupported} downloadLabel={S.files.download} stripFrontmatter {...readerFind} resolveRef={ref=>{
    if(!current||ref.startsWith("/")||ref.startsWith("#"))return null;
    let decoded:string;try{decoded=decodeURIComponent(ref.split(/[?#]/)[0]!);}catch{return null;}
    const parts=current.split("/").slice(0,-1);
    for(const part of decoded.split("/")){if(part==="..")parts.pop();else if(part&&part!==".")parts.push(part);}
    const target=parts.join("/");
    return target.startsWith(prefix)&&Object.hasOwn(files,target.slice(prefix.length))?{url:"#",treePath:target}:null;
  }} onToggleDir={dir=>{const open=collapsed.has(dir);setToggled(last=>({dir,open,serial:(last?.serial??0)+1}));setCollapsed(previous=>{const next=new Set(previous);if(open)next.delete(dir);else next.add(dir);return next;});}} onOpenFile={setSelected}/>;
}
