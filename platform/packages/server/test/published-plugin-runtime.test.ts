import { afterEach, expect, it } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadPluginGroups } from "@prismshadow/penguin-core";
import { PublishedBundleCache } from "../src/auth/published-bundle-cache.js";
import { publishedResourceRef, resolvedBundleHash } from "../src/auth/published-bundle.js";
const roots:string[]=[];
afterEach(async()=>{for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
function bundle(pluginName:string,pluginVersion:string){
 const common={description:"",audience:["alice"],revision:1,version:1,published:true,updatedAt:"2026-11-10T00:00:00Z"};
 const plugin={...common,id:"b".repeat(36),kind:"plugins" as const,name:pluginName,payload:{source:"upstream-library",pluginName,pluginVersion}};
 const agent={...common,id:"a".repeat(36),kind:"agents" as const,name:"专业测试",payload:{agentId:"test_agent",prompt:"Test",agentsMd:"Test role",pluginResources:[plugin.id]}};
 const resources=[agent,plugin],versions=resources.map(publishedResourceRef);
 return {rootId:agent.id,resources,versions,bundleHash:resolvedBundleHash(versions)};
}
it("loads pinned upstream skills and hooks into an account bundle without project Agent writes",async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),"plugin-published-"));roots.push(root);
 const cache=new PublishedBundleCache(root);
 const plugin=loadPluginGroups().flatMap(group=>group.plugins).find(p=>p.skills.length>0)!;
 expect(plugin).toBeTruthy();
 const publication=bundle(plugin.name,plugin.version);await cache.store("alice",publication);
 const definition=await cache.definition("alice",publication.bundleHash);
 expect(definition.skills.map(s=>s.name)).toEqual(plugin.skills.map(s=>s.name));
 expect(await readFile(path.join(definition.skills[0]!.directory,"SKILL.md"),"utf8")).toBe(plugin.skills[0]!.content);
 expect(definition.skills[0]!.directory).toContain(".shared-agent-definitions");
 expect(definition.mcpServers?.map(s=>s.name)).toEqual(plugin.mcpServers.map(s=>s.name));
 expect(await cache.definition("alice",publication.bundleHash)).toEqual(definition);
});
it("rejects unavailable pinned package versions before enabling a new definition",async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),"plugin-version-"));roots.push(root);
 const cache=new PublishedBundleCache(root);
 const plugin=loadPluginGroups().flatMap(group=>group.plugins)[0]!;
 const publication=bundle(plugin.name,"0.0.0-unavailable");await cache.store("alice",publication);
 await expect(cache.definition("alice",publication.bundleHash)).rejects.toThrow("匹配版本");
});
