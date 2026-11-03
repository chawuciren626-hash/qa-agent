import {afterEach,beforeEach,describe,it,expect,vi} from 'vitest';
import {zipSync,strToU8} from 'fflate';
import fs from 'node:fs/promises';
import path from 'node:path';
import {apiClient,createTestApp,provisionUser,loginAdmin} from './helpers.js';
import type {TestApp} from './helpers.js';
const zip=(files:Record<string,string>)=>Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([k,v])=>[k,strToU8(v)])))).toString('base64');
const skill=(name:string)=>`---\nname: ${name}\ndescription: personal acceptance guidance\nversion: 2026.10.26.1\n---\nRead references/example.md before generating tests.`;
describe.skipIf(!process.env.AITEST_ENGINE_ROOT)('QA personal resources and role boundaries',()=>{
 let app:TestApp, owner:ReturnType<typeof apiClient>, member:ReturnType<typeof apiClient>, admin:ReturnType<typeof apiClient>;
 const p='resource_owner-sandbox', base=`/api/projects/${p}/agents/qa/personal-resources`;
 beforeEach(async()=>{app=await createTestApp(); owner=apiClient(app.app,(await provisionUser(app.app,'resource_owner')).cookie);member=apiClient(app.app,(await provisionUser(app.app,'resource_member')).cookie);admin=apiClient(app.app,(await loginAdmin(app.app)).cookie);expect((await owner.post('/api/projects',{projectId:p})).status).toBe(201);await owner.post(`/api/projects/${p}/members`,{userId:'resource_member'});});
 afterEach(async()=>{vi.restoreAllMocks();await app?.cleanup();});
 it('keeps imports private and forbids permanent personal Skill installation',async()=>{
  const res=await owner.post(base,{kind:'skill',dataBase64:zip({'SKILL.md':skill('personal-design'),'references/example.md':'local-only guidance'})});expect(res.status).toBe(201);const item=await res.json() as {id:string};
  expect((await (await member.get(base)).json() as {resources:unknown[]}).resources).toHaveLength(0);
  expect((await member.post(base+'/'+item.id+'/apply',{agentId:'test_agent'})).status).toBe(403);
  const denied=await owner.post(base+'/'+item.id+'/apply',{agentId:'test_agent'});
  expect(denied.status).toBe(409);
  expect((await denied.json() as {error:{code:string}}).error.code).toBe('round_selection_required');
  const dest=path.join(app.root,p,'agents/test_agent/agent_state');
  await expect(fs.access(path.join(dest,'skills/personal-design/SKILL.md'))).rejects.toThrow();
  expect((await owner.delete(`/api/projects/${p}/agents/test_agent/skills/personal-design`)).status).toBe(403);
  expect((await owner.post(`/api/projects/${p}/agents/test_agent/hooks/archive`,{})).status).toBe(403);
  expect((await owner.get(`/api/projects/${p}/usage`)).status).toBe(403);
  expect((await admin.get(`/api/projects/${p}/agents/test_agent/skills`)).status).toBe(200);
  expect((await owner.delete(base+'/'+item.id)).status).toBe(204);
 });
 it('imports Skill resource plugins without installing them globally',async()=>{
  const payload=zip({'package.json':JSON.stringify({name:'@private/qa-notes',version:'1.0.0'}),'skills/personal-notes/SKILL.md':skill('personal-notes'),'skills/personal-notes/references/example.md':'plugin reference'});
  const res=await owner.post(base,{kind:'plugin',dataBase64:payload});expect(res.status,await res.clone().text()).toBe(201);const item=await res.json() as {id:string};
  expect((await owner.post(base+'/'+item.id+'/apply',{agentId:'test_agent'})).status).toBe(409);
  await expect(fs.access(path.join(app.root,p,'agents/test_agent/agent_state/skills/personal-notes/SKILL.md'))).rejects.toThrow();
  expect(await (await owner.get('/api/plugins')).text()).not.toContain('qa-notes');
  const bad=await owner.post(base,{kind:'plugin',dataBase64:zip({'package.json':JSON.stringify({name:'@private/module',version:'1.0.0'}),'ifaces.json':'{}'})});expect(bad.status).toBe(400);
 }); it('records a personal Skill selection for the current round without installing it',async()=>{
  const res=await owner.post(base,{kind:'skill',dataBase64:zip({'SKILL.md':skill('round-skill'),'references/example.md':'round guidance'})});const item=await res.json() as {id:string};
  vi.spyOn(app.deps.sessionsRepo,'findById').mockReturnValue({projectId:p,agentId:'test_agent'} as never);
  const select=(roundKey:string)=>owner.post(base+'/selection',{sessionId:'session-round',agentId:'test_agent',resources:[{resourceId:item.id}],roundKey});
  const created=await select('task-1');expect(created.status,await created.clone().text()).toBe(201);
  const selection=(await created.json() as {selection:{selectionId:string;round:number;status:string;resources:{version:number;contentHash:string}[];skills:{name:string;resourceVersion:number}[]}}).selection;
  expect(selection.round).toBe(1);expect(selection.status).toBe('active');
  expect(selection.resources[0]!.version).toBe(1);expect(selection.resources[0]!.contentHash).toMatch(/^sha256:/);
  expect(selection.skills[0]).toMatchObject({name:'round-skill',resourceVersion:1});
  const repeated=await select('task-1');expect(repeated.status).toBe(200);expect((await repeated.json() as {idempotent:boolean}).idempotent).toBe(true);

  expect(await (await owner.get(base+'/selection?sessionId=session-round&agentId=test_agent')).json()).toMatchObject({selection:{selectionId:selection.selectionId}});
  expect((await (await member.get(base+'/selection?sessionId=session-round&agentId=test_agent')).json() as {selection:unknown}).selection).toBeNull();
  expect((await member.get(base+'/selection/'+selection.selectionId)).status).toBe(404);
  const files=await owner.get(base+'/selection/'+selection.selectionId+'/skills/round-skill/files');
  expect(files.status,await files.clone().text()).toBe(200);
  const fileBody=await files.json() as {files:{path:string;contentBase64:string}[]};
  expect(Buffer.from(fileBody.files.find(file=>file.path==='references/example.md')!.contentBase64,'base64').toString('utf8')).toBe('round guidance');
  expect((await owner.delete(base+'/'+item.id)).status).toBe(409);

  expect((await owner.post(base+'/selection/'+selection.selectionId+'/consume')).status).toBe(200);
  expect((await owner.get(base+'/selection?sessionId=session-round&agentId=test_agent')).status).toBe(200);
  expect((await owner.delete(base+'/'+item.id)).status).toBe(204);
  await expect(fs.access(path.join(app.root,p,'agents/test_agent/agent_state/skills/round-skill'))).rejects.toThrow();
 });
 it('isolates projects and validates archives before writing',async()=>{
  const res=await owner.post(base,{kind:'skill',dataBase64:zip({'SKILL.md':skill('project-only')})});const item=await res.json() as {id:string};
  const p2='resource_owner-other';await owner.post('/api/projects',{projectId:p2});
  expect((await owner.post(`/api/projects/${p2}/agents/qa/personal-resources/${item.id}/apply`,{agentId:'test_agent'})).status).toBe(404);
  expect((await owner.post(base,{kind:'skill',dataBase64:zip({'../bad/SKILL.md':skill('bad')})})).status).toBe(400);
  const ownMember=await member.post(base,{kind:'skill',dataBase64:zip({'SKILL.md':skill('member-note')})});expect(ownMember.status).toBe(201);
  expect((await owner.get(`/api/projects/${p}/agents/qa/personal-resources`)).status).toBe(200);
 });
});
