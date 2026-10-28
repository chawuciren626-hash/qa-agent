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
 it('keeps imports private, applies supplemental skills only to owned project, and preserves bundled capabilities',async()=>{
  const res=await owner.post(base,{kind:'skill',dataBase64:zip({'SKILL.md':skill('personal-design'),'references/example.md':'local-only guidance'})});expect(res.status).toBe(201);const item=await res.json() as {id:string};
  expect((await (await member.get(base)).json() as {resources:unknown[]}).resources).toHaveLength(0);
  expect((await member.post(base+'/'+item.id+'/apply',{agentId:'test_agent'})).status).toBe(403);
  expect((await member.delete(base+'/'+item.id)).status).toBe(404);
  const dest=path.join(app.root,p,'agents/test_agent/agent_state');const before=await fs.readFile(path.join(dest,'AGENTS.md'),'utf8');
  const active=vi.spyOn(app.deps.manager,'activeCountForAgent').mockReturnValue(1);
  expect((await owner.post(base+'/'+item.id+'/apply',{agentId:'test_agent'})).status).toBe(409);active.mockRestore();
  expect((await owner.post(base+'/'+item.id+'/apply',{agentId:'test_agent'})).status).toBe(200);
  expect(await fs.readFile(path.join(dest,'skills/personal-design/references/example.md'),'utf8')).toBe('local-only guidance');
  expect(await fs.readFile(path.join(dest,'AGENTS.md'),'utf8')).toBe(before);
  expect((await owner.post(base+'/'+item.id+'/apply',{agentId:'test_agent'})).status).toBe(409);
  expect((await owner.delete(`/api/projects/${p}/agents/test_agent/skills/personal-design`)).status).toBe(403);
  expect((await owner.post(`/api/projects/${p}/agents/test_agent/hooks/archive`,{})).status).toBe(403);
  // The lightweight test app omits deployment plugin modules; full HTTP verification covers that route.
  expect((await owner.get(`/api/projects/${p}/usage`)).status).toBe(403);
  expect((await owner.get(`/api/projects/${p}/benchmarks`)).status).toBe(403);

  expect((await admin.get(`/api/projects/${p}/agents/test_agent/skills`)).status).toBe(200);
  expect((await owner.delete(base+'/'+item.id)).status).toBe(409);
  const skillFile=path.join(dest,'skills/personal-design/SKILL.md');const original=await fs.readFile(skillFile,'utf8');
  await fs.appendFile(skillFile,'\nadmin change');
  expect((await owner.post(base+'/'+item.id+'/remove',{agentId:'test_agent'})).status).toBe(409);
  await fs.writeFile(skillFile,original);
  expect((await owner.post(base+'/'+item.id+'/remove',{agentId:'test_agent'})).status).toBe(200);
  expect((await owner.delete(base+'/'+item.id)).status).toBe(204);
  await expect(fs.access(skillFile)).rejects.toThrow();
 });
 it('imports a Skill plugin without making it global, and refuses managed names and server modules',async()=>{
  const payload=zip({'package.json':JSON.stringify({name:'@private/qa-notes',version:'1.0.0'}),'skills/personal-notes/SKILL.md':skill('personal-notes'),'skills/personal-notes/references/example.md':'plugin reference'});
  const res=await owner.post(base,{kind:'plugin',dataBase64:payload});expect(res.status,await res.clone().text()).toBe(201);const item=await res.json() as {id:string};
  expect((await owner.post(base+'/'+item.id+'/apply',{agentId:'test_agent'})).status).toBe(200);
  expect(await fs.readFile(path.join(app.root,p,'agents/test_agent/agent_state/skills/personal-notes/SKILL.md'),'utf8')).toContain('personal-notes');
  expect(await (await owner.get('/api/plugins')).text()).not.toContain('qa-notes');
  const bad=await owner.post(base,{kind:'plugin',dataBase64:zip({'package.json':JSON.stringify({name:'@private/module',version:'1.0.0'}),'ifaces.json':'{}'})});expect(bad.status).toBe(400);
  const roles=await (await owner.get(`/api/projects/${p}/agents/qa`)).json() as {roles:{skills:string[]}[]};const reserved=roles.roles.flatMap(r=>r.skills)[0]!;
  const protectedRes=await owner.post(base,{kind:'skill',dataBase64:zip({'SKILL.md':skill(reserved)})});const protectedItem=await protectedRes.json() as {id:string};
  expect((await owner.post(base+'/'+protectedItem.id+'/apply',{agentId:'test_agent'})).status).toBe(409);
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
