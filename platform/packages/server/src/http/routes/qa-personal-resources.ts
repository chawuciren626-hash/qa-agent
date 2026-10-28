/** Account/project-scoped imports. Never installs packages into the global npm prefix. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { Context, Hono } from 'hono';
import { readLibraryPackage, replaceSkillDirectory, skillsDir } from '@prismshadow/penguin-core';
import type { AppEnv } from '../../auth/middleware.js';
import type { AgentsRouteDeps } from './agents.js';
import { HttpError } from '../errors.js';
import { readJson, requireString, requireValidId } from '../validate.js';
import { parseSkillArchive } from './skills.js';
import { parsePluginArchive } from '../../services/plugin-archive.js';
import { qaEnabled, qaEngineModule } from '../../services/qa-engine.js';

type Resource = { id: string; name: string; kind: 'skill' | 'plugin'; createdAt: string; skills: { name: string; files: Record<string, string> }[]; applied?: Record<string, Record<string,string>> };
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const locks = new Set<string>();
async function exclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
  if (locks.has(key)) throw new HttpError(409, 'resource_busy', '资源正在更新，请稍后重试。');
  locks.add(key); try { return await fn(); } finally { locks.delete(key); }
}
async function read(file: string): Promise<Resource> {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new HttpError(404, 'not_found', '个人资源不存在。'); throw e; }
}
const summary = ({id, name, kind, createdAt, skills, applied}: Resource) => ({id, name, kind, createdAt, skills: skills.map(s => s.name), appliedAgents:Object.keys(applied ?? {})});
async function fingerprint(dir: string): Promise<string> {
  const files: string[]=[];
  async function walk(at:string) {
    for (const item of await fs.readdir(at,{withFileTypes:true})) {
      const file=path.join(at,item.name);
      if(item.isSymbolicLink()) throw new HttpError(409,'resource_modified','资源包含链接，无法安全移除。');
      if(item.isDirectory()) await walk(file);
      else files.push(path.relative(dir,file)+':'+createHash('sha256').update(await fs.readFile(file)).digest('hex'));
    }
  }
  await walk(dir);return hash(files.sort().join('\n'));
}
async function saveResource(file:string, resource:Resource) {
  const temp=file+'.'+randomUUID()+'.tmp';
  try {await fs.writeFile(temp,JSON.stringify(resource));await fs.rename(temp,file);} finally {await fs.rm(temp,{force:true});}
}

export function registerQaPersonalResources(app: Hono<AppEnv>, deps: AgentsRouteDeps) {
  if (!qaEnabled || !deps.config) return;
  const root = deps.config.root;
  const base = '/qa/personal-resources';
  const scope = (c: Context<AppEnv>) => {
    const projectId = requireValidId(c, 'projectId');
    const access = deps.access.requireProjectAccess(c.var.user.userId, projectId);
    const owner = access.ownerUserId === c.var.user.userId;
    return { projectId, owner, dir: path.join(root, '.qa-personal-resources', hash(c.var.user.userId), projectId) };
  };
  app.get(base, async c => {
    const { dir, owner } = scope(c);
    const names = await fs.readdir(dir).catch((e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT') return []; throw e; });
    const resources = await Promise.all(names.filter(n => /^[a-f0-9-]+\.json$/.test(n)).map(n => read(path.join(dir, n)).then(summary)));
    return c.json({ resources, canApply: owner });
  });
  app.post(base, async c => {
    const { dir } = scope(c);
    const body = await readJson(c);
    const kind = body.kind;
    if (kind !== 'skill' && kind !== 'plugin') throw new HttpError(400, 'invalid_kind', '请选择 Skill 或插件 ZIP。');
    const bytes = Buffer.from(requireString(body, 'dataBase64', { minLen: 1, maxLen: 20 * 1024 * 1024 }), 'base64');
    if (bytes.length > 14 * 1024 * 1024) throw new HttpError(413,'resource_too_large','ZIP 文件不能超过 14 MB。');
    let name: string;
    let skills: Resource['skills'];
    if (kind === 'skill') {
      const skill = parseSkillArchive(bytes);
      name = skill.name;
      skills = [{name, files: Object.fromEntries([...skill.files].map(([p,b]) => [p, Buffer.from(b).toString('base64')]))}];
    } else {
      const archive = await parsePluginArchive(bytes);
      const manifest = JSON.parse(Buffer.from(archive.files.get('package.json')!).toString('utf8'));
      // Server modules/dependency installation affects every project and stays administrator-owned.
      if (archive.modules || manifest.dependencies && Object.keys(manifest.dependencies).length || manifest.scripts && Object.keys(manifest.scripts).length)
        throw new HttpError(400, 'admin_plugin_required', '包含服务模块、安装脚本或运行依赖的插件请由管理员安装；个人入口支持独立 Skill 资源插件。');
      await fs.mkdir(dir, {recursive: true});
      const temp = path.join(dir, '.inspect-' + randomUUID());
      try {
        for (const [rel, bytes] of archive.files) { const file = path.join(temp, rel); await fs.mkdir(path.dirname(file), {recursive:true}); await fs.writeFile(file, bytes); }
        const plugin = readLibraryPackage(temp);
        if (plugin.hooks || plugin.mcpServers.length || plugin.workbenches?.length || !plugin.skills.length)
          throw new HttpError(400, 'admin_plugin_required', '个人入口支持 Skill 资源插件；含 Hooks、MCP 或工作台的插件由管理员维护。');
        name = archive.name;
        skills = plugin.skills.map(skill => ({name:skill.name, files:Object.fromEntries(Object.entries({ ...skill.files, "SKILL.md": skill.content }).map(([p,b]) => [p, Buffer.from(b).toString('base64')]))}));
      } finally { await fs.rm(temp, {recursive:true,force:true}); }
    }
    const resource: Resource = { id:randomUUID(), name, kind, skills, createdAt:new Date().toISOString() };
    await fs.mkdir(dir, {recursive:true});
    await fs.writeFile(path.join(dir, resource.id + '.json'), JSON.stringify(resource), {flag:'wx'});
    return c.json(summary(resource), 201);
  });
  app.delete(base + '/:resourceId', async c => {
    const {dir} = scope(c); const id = requireValidId(c, 'resourceId');
    await exclusive(dir + '/' + id, async () => { const file = path.join(dir,id+'.json'); const resource=await read(file); if(Object.keys(resource.applied??{}).length) throw new HttpError(409,'resource_applied','请先移除已应用的副本，再删除个人资源。'); await fs.unlink(file); });
    return c.body(null,204);
  });
  app.post(base + '/:resourceId/apply', async c => {
    const {dir, projectId, owner} = scope(c);
    if (!owner) throw new HttpError(403,'project_owner_required','仅能应用到本人拥有的项目；共享项目请由项目所有者配置。');
    const id = requireValidId(c,'resourceId'); const body = await readJson(c);
    const agentId = requireString(body,'agentId');
    if (!/^[A-Za-z0-9_-]+$/.test(agentId)) throw new HttpError(400,'invalid_agent','无效智能体。');
    await deps.agentConfigService.requireExists(projectId,agentId);
    return exclusive(dir+'/'+id, () => exclusive(path.join(root,projectId,agentId), async () => {
      if (deps.manager.activeCountForAgent(projectId,agentId)>0) throw new HttpError(409,'agent_busy','请等待该智能体运行结束后再应用资源。');
      const config = await deps.agentConfigService.getConfig(projectId,agentId);
      if (config.config.skills.enabled === false) throw new HttpError(409,'skills_disabled','该智能体已禁用 Skills，请联系管理员启用后再应用。');
      const resource = await read(path.join(dir,id+'.json'));
      const protectedNames = new Set(qaEngineModule('qa-project-bootstrap').qaRoles().flatMap((r: {skills:string[]}) => r.skills.map(s=>s.toLowerCase())));
      const target = skillsDir(root,projectId,agentId);
      for (const skill of resource.skills) {
        if (protectedNames.has(skill.name.toLowerCase())) throw new HttpError(409,'protected_skill','不能覆盖内置测试 Skill：'+skill.name);
        if (await fs.lstat(path.join(target,skill.name)).then(()=>true, e=> { if(e.code==='ENOENT') return false; throw e; })) throw new HttpError(409,'skill_exists','已有同名 Skill，未覆盖：'+skill.name);
      }
      const written: string[] = [];
      try {
        for (const skill of resource.skills) {
          const dest = path.join(target,skill.name); written.push(dest);
          await replaceSkillDirectory(dest,Object.entries(skill.files).map(([p,b])=>[p,Buffer.from(b,'base64')] as [string,Buffer]));
        }
        await deps.agentConfigService.insertTemplatePlaceholder(projectId,agentId,'skills');
        const fingerprints:Record<string,string>={};
        for(const skill of resource.skills) fingerprints[skill.name]=await fingerprint(path.join(target,skill.name));
        resource.applied={...resource.applied,[agentId]:fingerprints};
        await saveResource(path.join(dir,id+'.json'),resource);
      } catch (e) { for (const dest of written) await fs.rm(dest,{recursive:true,force:true}); throw e; }
      deps.manager.invalidateAgentRuntimes(projectId,agentId);
      return c.json({applied:true,agentId,skills:resource.skills.map(s=>s.name),scope:'project-agent',mode:'supplement'});
    }));
  });
  app.post(base + '/:resourceId/remove', async c => {
    const {dir,projectId,owner}=scope(c);
    if(!owner) throw new HttpError(403,'project_owner_required','仅项目所有者可以移除已应用副本。');
    const id=requireValidId(c,'resourceId');const body=await readJson(c);const agentId=requireString(body,'agentId');
    if(!/^[A-Za-z0-9_-]+$/.test(agentId)) throw new HttpError(400,'invalid_agent','无效智能体。');
    await deps.agentConfigService.requireExists(projectId,agentId);
    return exclusive(dir+'/'+id,()=>exclusive(path.join(root,projectId,agentId),async()=>{
      if(deps.manager.activeCountForAgent(projectId,agentId)>0)throw new HttpError(409,'agent_busy','请等待智能体运行结束。');
      const resource=await read(path.join(dir,id+'.json'));const applied=resource.applied?.[agentId];
      if(!applied)throw new HttpError(404,'not_applied','此资源未应用到该智能体。');
      const target=skillsDir(root,projectId,agentId);
      for(const [name,expected] of Object.entries(applied)) {
        const actual=await fingerprint(path.join(target,name)).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
        if(actual!==null&&actual!==expected)throw new HttpError(409,'resource_modified','副本已修改，为保留修改未移除：'+name);
      }
      // Rename to reversible staging before updating ownership metadata.
      const moved:[string,string][]=[];
      try {
        for(const name of Object.keys(applied)) {const from=path.join(target,name),to=path.join(target,'.remove-'+randomUUID());try{await fs.rename(from,to);moved.push([from,to]);}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}}
        delete resource.applied![agentId];await saveResource(path.join(dir,id+'.json'),resource);
      }catch(e){for(const [from,to] of moved.reverse())await fs.rename(to,from);throw e;}
      for(const [,to] of moved)await fs.rm(to,{recursive:true,force:true});
      deps.manager.invalidateAgentRuntimes(projectId,agentId);return c.json({removed:true});
    }));
  });
}
