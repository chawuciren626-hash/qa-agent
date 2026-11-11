import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { libraryPlugin, pluginMcpServerEntries, type InstalledHook, type SystemConfig } from "@prismshadow/penguin-core";
import type { ResolvedPublishedBundle } from "./published-bundle.js";

/** Resolve only administrator-pinned packages already supplied by the local upstream runtime. */
export async function publishedPluginRuntime(bundle: ResolvedPublishedBundle, base: string) {
  const skills: {name:string;directory:string;description?:string}[]=[];
  const hookPackages: InstalledHook[]=[];
  const mcpServers: NonNullable<NonNullable<SystemConfig["tools"]>["mcpServers"]>=[];
  const names=new Set<string>();
  for(const resource of bundle.resources.filter(item=>item.kind==="plugins"&&item.payload.source==="upstream-library")) {
    const name=String(resource.payload.pluginName), version=String(resource.payload.pluginVersion);
    if(!/^[a-z][a-z0-9_-]*$/.test(name)||names.has(name))throw Error("Invalid or duplicate published plugin");
    names.add(name);
    const plugin=libraryPlugin(name);
    if(!plugin||plugin.version!==version)throw Error(`本机缺少已发布插件的匹配版本：${name}@${version}，请更新客户端插件运行资源。`);
    const directory=path.join(base,"plugins",name);
    const files: Record<string,string>={};
    for(const skill of plugin.skills) {
      for(const [file,content] of Object.entries(skill.files??{}))files[`skills/${skill.name}/${file}`]=content;
      files[`skills/${skill.name}/SKILL.md`]=skill.content;
      if(skill.icon)files[`skills/${skill.name}/icon.svg`]=skill.icon;
      skills.push({name:skill.name,directory:path.join(directory,"skills",skill.name),description:skill.description});
    }
    if(plugin.hooks) {
      for(const [file,content] of Object.entries(plugin.hooks.files))files[`hooks/${file}`]=content;
      files["hooks/hooks.json"]=JSON.stringify(plugin.hooks.manifest);
      hookPackages.push({...plugin.hooks.manifest,dir:path.join(directory,"hooks")});
    }
    for(const entry of pluginMcpServerEntries(plugin)) {
      if(mcpServers.some(item=>item.name===entry.name))throw Error("Published plugins contain duplicate MCP server names");
      mcpServers.push(entry);
    }
    // Preserve workbench assets beside the pinned plugin, without modifying project Agent State.
    for(const workbench of plugin.workbenches??[])for(const [file,content] of Object.entries(workbench.files))files[`workbenches/${workbench.name}/${file}`]=content;
    for(const file of Object.keys(files))if(file.includes("\\")||file.split("/").some(part=>!part||part==="."||part==="..")||path.isAbsolute(file))throw Error("Unsafe published plugin file");
    const parent=path.dirname(directory);
    await fs.mkdir(parent,{recursive:true});
    for(const dir of [base,parent]){const st=await fs.lstat(dir);if(!st.isDirectory()||st.isSymbolicLink())throw Error("Unsafe plugin cache directory");}
    const existing=await fs.lstat(directory).catch((error:NodeJS.ErrnoException)=>{if(error.code==="ENOENT")return null;throw error;});
    if(!existing){
      const temp=path.join(parent,`.${randomUUID()}`);
      try{
        await fs.mkdir(temp);
        for(const [file,content] of Object.entries(files)){const dest=path.join(temp,file);await fs.mkdir(path.dirname(dest),{recursive:true});await fs.writeFile(dest,content,{flag:"wx",mode:0o600});}
        try{await fs.rename(temp,directory);}catch(error){if(!["EEXIST","ENOTEMPTY","EACCES"].includes((error as NodeJS.ErrnoException).code??""))throw error;}
      }finally{await fs.rm(temp,{recursive:true,force:true});}
    }
    for(const [file,content] of Object.entries(files)){
      let current=directory;
      for(const part of file.split("/")){const st=await fs.lstat(current);if(st.isSymbolicLink()||!st.isDirectory())throw Error("Unsafe plugin cache path");current=path.join(current,part);}
      const st=await fs.lstat(current);if(!st.isFile()||st.isSymbolicLink()||await fs.readFile(current,"utf8")!==content)throw Error("Published plugin cache content changed");
    }
  }
  return {skills,hookPackages,mcpServers};
}
