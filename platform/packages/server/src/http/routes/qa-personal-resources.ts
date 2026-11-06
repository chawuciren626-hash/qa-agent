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
import {
  activeSelectionReferences,
  cancelSelection,
  consumeSelection,
  createRoundSelection,
  currentSelection,
  getSelection,
  selectionDirectory,
  selectionSkillFiles,
  selectionView,
  skillResourceFingerprint,
  skillResourceVersion,
  type SkillPick
} from '../../services/qa-skill-selection.js';

type Resource = { id: string; name: string; kind: 'skill' | 'plugin'; version?: number; contentHash?: string; createdAt: string; skills: { name: string; files: Record<string, string> }[]; applied?: Record<string, Record<string,string>> };
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
const summary = (resource: Resource) => ({id:resource.id, name:resource.name, kind:resource.kind, version:skillResourceVersion(resource), contentHash:resource.contentHash ?? skillResourceFingerprint(resource), createdAt:resource.createdAt, skills:resource.skills.map(s => s.name), appliedAgents:Object.keys(resource.applied ?? {})});
function protectedSkillNames(): Set<string> {
  return new Set(qaEngineModule('qa-project-bootstrap').qaRoles().flatMap((role: {skills:string[]}) => role.skills.map(name => name.toLowerCase())));
}
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
    const userHash = hash(c.var.user.userId);
    return { projectId, owner, dir: path.join(root, '.qa-personal-resources', userHash, projectId), selectionDir: selectionDirectory(root, userHash, projectId) };
  };
  app.get(base, async c => {
    const { dir, owner } = scope(c);
    const names = await fs.readdir(dir).catch((e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT') return []; throw e; });
    const resources = await Promise.all(names.filter(n => /^[a-f0-9-]+\.json$/.test(n)).map(n => read(path.join(dir, n)).then(summary)));
    return c.json({ resources, canApply: owner && c.var.user.isAdmin });
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
    const resource: Resource = { id:randomUUID(), name, kind, version:1, skills, createdAt:new Date().toISOString() };
    resource.contentHash = skillResourceFingerprint(resource);
    await fs.mkdir(dir, {recursive:true});
    await fs.writeFile(path.join(dir, resource.id + '.json'), JSON.stringify(resource), {flag:'wx'});
    return c.json(summary(resource), 201);
  });
  const targetSession = (projectId: string, sessionId: string, agentId: string) => {
    const session = deps.sessionsRepo.findById(sessionId);
    if (!session || session.projectId !== projectId || session.agentId !== agentId) throw new HttpError(404, 'session_not_found', '任务不存在或不属于该智能体。');
    return session;
  };
  app.get(base + '/selection', async c => {
    const {projectId, selectionDir} = scope(c);
    const sessionId = c.req.query('sessionId') ?? '';
    const agentId = c.req.query('agentId') ?? '';
    if (!sessionId || !agentId) throw new HttpError(400, 'invalid_selection', '任务和智能体标识必填。');
    targetSession(projectId, sessionId, agentId);
    const selection = await currentSelection({dir: selectionDir, sessionId, agentId});
    return c.json({selection: selection ? selectionView(selection) : null});
  });
  app.post(base + '/selection', async c => {
    const {projectId, dir, selectionDir} = scope(c);
    const body = await readJson(c);
    const sessionId = requireString(body, 'sessionId', {minLen: 3, maxLen: 120});
    const agentId = requireString(body, 'agentId', {minLen: 1, maxLen: 100});
    if (!/^[A-Za-z0-9_-]+$/.test(agentId)) throw new HttpError(400, 'invalid_agent', '无效智能体。');
    targetSession(projectId, sessionId, agentId);
    await deps.agentConfigService.requireExists(projectId, agentId);
    const raw = body.resources;
    if (!Array.isArray(raw) || !raw.length || raw.length > 20) throw new HttpError(400, 'invalid_selection', '请选择 1 至 20 个个人资源。');
    const picks: SkillPick[] = raw.map(item => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new HttpError(400, 'invalid_selection', '个人资源选择无效。');
      const record = item as Record<string, unknown>;
      if (typeof record.resourceId !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(record.resourceId)) throw new HttpError(400, 'invalid_selection', '个人资源标识无效。');
      if (record.skills !== undefined && (!Array.isArray(record.skills) || !record.skills.length || record.skills.some(name => typeof name !== 'string'))) throw new HttpError(400, 'invalid_selection', '技能选择无效。');
      return {resourceId: record.resourceId, ...(record.skills === undefined ? {} : {skills: record.skills as string[]})};
    });
    let roundKey: string | undefined;
    if (body.roundKey !== undefined) {
      roundKey = requireString(body, 'roundKey', {minLen: 1, maxLen: 200});
      if (!/^[A-Za-z0-9_.:-]+$/.test(roundKey)) throw new HttpError(400, 'invalid_selection', '请求标识格式无效。');
    }
    const result = await createRoundSelection({
      dir: selectionDir, resourceDir: dir, projectId, userId: c.var.user.userId,
      sessionId, agentId, picks, roundKey, protectedNames: protectedSkillNames()
    });
    return c.json({idempotent: result.idempotent, selection: selectionView(result.selection)}, result.idempotent ? 200 : 201);
  });
  app.get(base + '/selection/:selectionId', async c => {
    const {selectionDir} = scope(c);
    const selection = await getSelection({dir: selectionDir, id: requireValidId(c, 'selectionId')});
    return c.json(selectionView(selection));
  });
  app.post(base + '/selection/:selectionId/consume', async c => {
    const {selectionDir} = scope(c);
    const result = await consumeSelection({dir: selectionDir, id: requireValidId(c, 'selectionId')});
    return c.json({idempotent: result.idempotent, selection: selectionView(result.selection)});
  });
  app.delete(base + '/selection/:selectionId', async c => {
    const {selectionDir} = scope(c);
    await cancelSelection({dir: selectionDir, id: requireValidId(c, 'selectionId')});
    return c.body(null, 204);
  });
  app.get(base + '/selection/:selectionId/skills/:skillName/files', async c => {
    const {selectionDir} = scope(c);
    const skillName = requireValidId(c, 'skillName');
    const result = await selectionSkillFiles({dir: selectionDir, id: requireValidId(c, 'selectionId'), skillName});
    return c.json({name: result.skill.name, resourceId: result.skill.resourceId, resourceVersion: result.skill.resourceVersion, contentHash: result.skill.contentHash, files: result.files});
  });
  app.delete(base + '/:resourceId', async c => {
    const {dir, selectionDir} = scope(c); const id = requireValidId(c, 'resourceId');
    await exclusive(dir + '/' + id, async () => {
      const active = await activeSelectionReferences({dir: selectionDir, resourceId: id});
      if (active.length) throw new HttpError(409, 'resource_in_selection', '该资源正在本轮任务中使用，请先取消选择。');
      const file = path.join(dir,id+'.json'); const resource=await read(file); if(Object.keys(resource.applied??{}).length) throw new HttpError(409,'resource_applied','请先移除已应用的副本，再删除个人资源。'); await fs.unlink(file);
    });
    return c.body(null,204);
  });
  app.post(base + '/:resourceId/apply', async c => {
    const {dir, owner} = scope(c);
    if (!owner) throw new HttpError(403, 'project_owner_required', '仅项目所有者可以管理项目 Agent。');
    await read(path.join(dir, requireValidId(c, 'resourceId') + '.json'));
    throw new HttpError(409, 'round_selection_required', '个人 Skill 仅可在任务中选择并对本轮生效。');
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
