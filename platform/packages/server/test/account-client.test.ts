import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { randomUUID } from "node:crypto";
import { zipSync, strToU8 } from "fflate";
import { createTestApp, restartTestApp, apiClient, loginUser } from "./helpers.js";
import type { TestApp } from "./helpers.js";
import { readAccountClientConfig } from "../src/auth/account-client.js";
import { publishedResourceRef, resolvedBundleHash } from "../src/auth/published-bundle.js";
import type { AuthState } from "../src/hmr/capabilities.js";
import type { Http } from "../src/http/app.js";

let server:Server, app:TestApp|undefined, origin:string, offline=false, wrongService=false, roleVersion=1;
let modules:string[], resourceIds:string[], disabled=false, memoryValue="";
const tokens=new Map<string,string>();
const captured:{path:string;body:unknown}[]=[];
beforeEach(async()=>{
  tokens.clear();captured.length=0;offline=false;wrongService=false;roleVersion=1;
  modules=["chat","projects","models","plugins","skills"];disabled=false;memoryValue="";
  resourceIds=['a'.repeat(36)];
  server=createServer(async(req,res)=>{
    let raw="";for await(const chunk of req)raw+=chunk;
    const body=raw?JSON.parse(raw):undefined;
    captured.push({path:req.url!,body});
    res.setHeader("content-type","application/json");
    if(offline){res.writeHead(503);res.end('{}');return;}
    if(wrongService){res.setHeader('content-type','text/html');res.writeHead(404);res.end('<!DOCTYPE html><title>File not found</title>');return;}
    if(req.url==="/api/auth/login") {
      if(body.password!=="central-test-password"){res.writeHead(401);res.end('{"error":{"code":"invalid_credentials"}}');return;}
      const token=randomUUID();tokens.set(token,body.userId);
      res.setHeader("set-cookie",`penguin_session=${token}; HttpOnly; Path=/`);
      res.end(JSON.stringify({user:{userId:body.userId,isAdmin:body.userId==="admin",createdAt:new Date().toISOString(),passwordIsInitial:false}}));return;
    }
    if(req.url==="/api/auth/registration"){res.end('{"enabled":true,"accountCenter":true}');return;}
    const id=tokens.get((req.headers.cookie??'').replace('penguin_session=',''));
    if(!id){res.writeHead(401);res.end('{}');return;}
    if(req.url==="/api/control/access"){res.end(JSON.stringify({modules,resourceIds}));return;}
    if(req.url?.startsWith('/api/control/private/agents/')&&req.url.includes('/memory')){res.end(JSON.stringify({entries:memoryValue?[{name:'notes',value:memoryValue}]:[]}));return;}
    if(req.url==="/api/control/catalog/roles"){res.end(JSON.stringify({roles:[{agentId:'test_agent',resourceId:'a'.repeat(36),version:roleVersion}]}));return;}
    if(req.url==="/api/control/catalog/roles/resolved"){
      const resource={id:'a'.repeat(36),kind:'agents' as const,name:'Shared QA',description:'',payload:{agentId:'test_agent',prompt:'test',agentsMd:`Shared QA instructions v${roleVersion}`,scheduleTemplates:[{name:'daily_check',prompt:'Check the project',period:'1d'}],apiTemplate:{approvalMode:'read-only',maxConcurrentRuns:2}},audience:['*'],revision:0,version:roleVersion,published:true,updatedAt:'2026-11-04T00:00:00.000Z'};
      const versions=[publishedResourceRef(resource)];
      res.end(JSON.stringify({bundles:[{agentId:'test_agent',rootId:resource.id,versions,bundleHash:resolvedBundleHash(versions),resources:[resource]}]}));return;
    }
    if(req.url==="/api/control/catalog/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/resolved"){
      const resource={id:'a'.repeat(36),kind:'agents' as const,name:'Shared QA',description:'',payload:{agentId:'test_agent',prompt:'test',agentsMd:`Shared QA instructions v${roleVersion}`,scheduleTemplates:[{name:'daily_check',prompt:'Check the project',period:'1d'}],apiTemplate:{approvalMode:'read-only',maxConcurrentRuns:2}},audience:['*'],revision:0,version:roleVersion,published:true,updatedAt:'2026-11-04T00:00:00.000Z'};
      const versions=[publishedResourceRef(resource)];
      res.end(JSON.stringify({rootId:resource.id,versions,bundleHash:resolvedBundleHash(versions),resources:[resource]}));return;
    }
    if(req.url==="/api/me"){res.end(JSON.stringify({user:{userId:id,isAdmin:id==="admin",disabled,passwordIsInitial:false,createdAt:new Date().toISOString()}}));return;}
    res.end('{}');
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  origin=`http://localhost:${(server.address() as {port:number}).port}`;
  app=await createTestApp({config:{accountClient:{origin,ownerUserId:'admin'}},durableDatabase:true});
});
afterEach(async()=>{await app?.cleanup();app=undefined;await new Promise<void>(resolve=>server.close(()=>resolve()));});
describe('central identity with full local application',()=>{
  it('forwards central Agent settings and scoped private reads through the authenticated bridge',async()=>{
    const admin=apiClient(app!.app,(await loginUser(app!.app,'admin','central-test-password')).cookie);
    const id='a'.repeat(36);
    expect((await admin.get('/api/control/admin/agent-cards')).status).toBe(200);
    expect((await admin.get(`/api/control/admin/resources/${id}/versions/1/resolved`)).status).toBe(200);
    expect((await admin.get(`/api/control/private/agents/${id}/memory?scope=project&projectId=qa`)).status).toBe(200);
    expect(captured.some(request=>request.path?.startsWith(`/api/control/private/agents/${id}/memory?scope=project&projectId=project_`))).toBe(true);
    expect((await admin.post('/api/control/agent-template/apply',{resourceId:id,projectId:'qa',kind:'schedule',name:'x',startAt:'invalid',enabled:true})).status).toBe(400);
  });
  it('adopts a published template only on an explicit local Project request',async()=>{
    const user=apiClient(app!.app,(await loginUser(app!.app,'ordinary','central-test-password')).cookie);
    modules.push('schedules','agents');
    const identity=await (await user.get('/api/me')).json() as {user:{userId:string}};
    const projectId=`${identity.user.userId}-template_project`;
    const created=await user.post('/api/projects',{projectId});
    if(created.status!==201)throw Error(await created.text());
    // Provision the published Agent through the host; ordinary users cannot create definitions.
    await app!.deps.agentService.createAgent(projectId,'test_agent','Test Agent');
    const resourceId='a'.repeat(36);
    const startAt=new Date(Date.now()+24*60*60*1000).toISOString();
    const schedule=await user.post('/api/control/agent-template/apply',{resourceId,projectId,kind:'schedule',name:'daily_check',startAt,enabled:true});
    expect(schedule.status).toBe(201);
    const listed=await (await user.get(`/api/projects/${projectId}/agents/test_agent/schedules`)).json() as {schedules:{name:string}[]};
    expect(listed.schedules.map(item=>item.name)).toContain('daily_check');
    const api=await user.post('/api/control/agent-template/apply',{resourceId,projectId,kind:'api'});
    expect(api.status).toBe(200);
    const settings=await (await user.get(`/api/projects/${projectId}/agents/test_agent/api`)).json() as {api:{enabled:boolean;approvalMode:string;maxConcurrentRuns:number}};
    expect(settings.api).toMatchObject({enabled:false,approvalMode:'read-only',maxConcurrentRuns:2});
    expect(captured.every(request=>request.path!=='/api/control/catalog/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/resolved'||request.body===undefined)).toBe(true);
  });
  it('forwards read-only resolved bundles to the central service',async()=>{
    const user=apiClient(app!.app,(await loginUser(app!.app,'ordinary','central-test-password')).cookie);
    const id='a'.repeat(36);
    expect((await user.get(`/api/control/catalog/${id}/resolved`)).status).toBe(200);
    expect(captured.some(request=>request.path===`/api/control/catalog/${id}/resolved`)).toBe(true);
    expect((await user.get(`/api/control/catalog/${id}/resolved`)).status).toBe(200);
    expect((await user.post(`/api/control/catalog/${id}/resolved`,{})).status).toBe(404);
  });
  it('resolves a shared role without sending project content to the center',async()=>{
    const login=await loginUser(app!.app,'ordinary','central-test-password');
    const localId=(await (await apiClient(app!.app,login.cookie).get('/api/me')).json() as {user:{userId:string}}).user.userId;
    const client=app!.boot.tree.api<AuthState>("RuntimeModule","AuthState").accountClient!;
    const bundle=await client.resolveRoleBundle(localId,'test_agent') as {resources:{payload:{prompt:string}}[]};
    expect(bundle.resources[0]?.payload.prompt).toBe('test');
    expect(captured.some(request=>request.path==='/api/control/catalog/roles')).toBe(true);
    expect(captured.every(request=>request.body===undefined||request.path==='/api/auth/login')).toBe(true);
  });
  it('pins a published role for a local session without sending project coordinates',async()=>{
    const login=await loginUser(app!.app,'ordinary','central-test-password');
    const localId=(await (await apiClient(app!.app,login.cookie).get('/api/me')).json() as {user:{userId:string}}).user.userId;
    const client=app!.boot.tree.api<AuthState>("RuntimeModule","AuthState").accountClient!;
    expect(await client.pinPublishedSession(localId,'private_project','test_agent','session-test')).toBe(true);
    const definition=await client.resolvePinnedDefinition('private_project','test_agent','session-test');
    expect(definition?.prompt).toBe('test');
    expect(captured.some(request=>request.path==='/api/control/catalog/roles/resolved')).toBe(true);
    expect(JSON.stringify(captured)).not.toContain('private_project');
  });
  it('loads only the session owner\'s central memory when assembling a pinned Agent',async()=>{
    const login=await loginUser(app!.app,'ordinary','central-test-password');
    const localId=(await (await apiClient(app!.app,login.cookie).get('/api/me')).json() as {user:{userId:string}}).user.userId;
    const client=app!.boot.tree.api<AuthState>('RuntimeModule','AuthState').accountClient!;
    await client.pinPublishedSession(localId,'private_project','test_agent','session-memory');
    memoryValue='only this account';
    const definition=await client.resolvePinnedDefinition('private_project','test_agent','session-memory');
    expect(definition?.memoryInstructions).toContain('only this account');
    expect(captured.some(request=>request.path?.includes('/memory?scope=project&projectId=project_'))).toBe(true);
    expect(JSON.stringify(captured)).not.toContain('private_project');
  });
  it('pins new Sessions to a new publication while an existing Session keeps its original definition',async()=>{
    const login=await loginUser(app!.app,'ordinary','central-test-password');
    const localId=(await (await apiClient(app!.app,login.cookie).get('/api/me')).json() as {user:{userId:string}}).user.userId;
    const client=app!.boot.tree.api<AuthState>("RuntimeModule","AuthState").accountClient!;
    expect(await client.pinPublishedSession(localId,'private_project','test_agent','session-v1')).toBe(true);
    const original=await client.resolvePinnedDefinition('private_project','test_agent','session-v1');
    expect(original?.agentsMd).toContain('v1');
    roleVersion=2;
    expect(await client.pinPublishedSession(localId,'private_project','test_agent','session-v2')).toBe(true);
    const updated=await client.resolvePinnedDefinition('private_project','test_agent','session-v2');
    expect(updated?.agentsMd).toContain('v2');
    expect(updated?.bundleHash).not.toBe(original?.bundleHash);
    expect((await client.resolvePinnedDefinition('private_project','test_agent','session-v1'))?.bundleHash).toBe(original?.bundleHash);
  });
  it('restores a local login after the service restarts and still honors central revocation',async()=>{
    const login=await loginUser(app!.app,'admin','central-test-password');
    const cookie=login.cookie;
    expect((await apiClient(app!.app,cookie).get('/api/me')).status).toBe(200);
    const stored=app!.deps.db.prepare('SELECT central_cookie FROM account_center_sessions').get() as {central_cookie:string};
    expect(stored.central_cookie).toMatch(/^enc:v1:/);
    expect(stored.central_cookie).not.toContain('penguin_session=');
    app=await restartTestApp(app!);
    expect((await apiClient(app!.app,cookie).get('/api/me')).status).toBe(200);
    tokens.clear();
    expect((await apiClient(app!.app,cookie).get('/api/me')).status).toBe(401);
    expect(app!.deps.db.prepare('SELECT count(*) AS n FROM account_center_sessions').get()!.n).toBe(0);
  });
  it('migrates valid legacy plaintext cookies on restart',async()=>{
    const login=await loginUser(app!.app,'admin','central-test-password');
    const legacy=`penguin_session=${[...tokens.keys()][0]}`;
    app!.deps.db.prepare('UPDATE account_center_sessions SET central_cookie=?').run(legacy);
    app=await restartTestApp(app!);
    expect((await apiClient(app!.app,login.cookie).get('/api/me')).status).toBe(200);
    const stored=app!.deps.db.prepare('SELECT central_cookie FROM account_center_sessions').get() as {central_cookie:string};
    expect(stored.central_cookie).toMatch(/^enc:v1:/);
    expect(stored.central_cookie).not.toContain(legacy);
  });
  it('forwards skill categories and keeps local plugin category assignments scoped to administrators',async()=>{
    const admin=apiClient(app!.app,(await loginUser(app!.app,'admin','central-test-password')).cookie);
    const ordinary=apiClient(app!.app,(await loginUser(app!.app,'ordinary','central-test-password')).cookie);
    expect((await ordinary.get('/api/control/admin/plugin-categories')).status).toBe(403);
    const skill=await admin.post('/api/control/skills/categories',{name:'自定义技能分类'});
    expect(skill.status).toBe(200); // The fake service returns this status; the bridge preserves it.
    expect(captured).toContainEqual({path:'/api/control/skills/categories',body:{name:'自定义技能分类'}});
    expect((await admin.get('/api/control/skills/categories')).status).toBe(200);

    const plugin=await admin.post('/api/control/admin/plugin-categories',{name:'自定义插件分类'});
    expect(plugin.status).toBe(201);
    const pluginId=(await plugin.json() as {id:string}).id;
    expect((await admin.put('/api/control/admin/plugin-categories/assign',{pluginKey:'library:example',categoryId:pluginId})).status).toBe(200);
    expect((await admin.delete(`/api/control/admin/plugin-categories/${pluginId}`)).status).toBe(409);
    expect((await admin.delete('/api/control/admin/plugin-categories/assignment/library%3Aexample')).status).toBe(200);
    expect((await admin.delete(`/api/control/admin/plugin-categories/${pluginId}`)).status).toBe(200);
    expect((await admin.put('/api/control/admin/plugin-categories/sandbox',{name:'运行沙箱'})).status).toBe(200);
    const listing=await (await admin.get('/api/control/admin/plugin-categories')).json() as {overrides:{id:string;name:string}[]};
    expect(listing.overrides).toContainEqual({id:'sandbox',name:'运行沙箱',deleted:0});
  });
  it('shares local projects between two logins but logs out only the requesting session',async()=>{
    const first=await loginUser(app!.app,'admin','central-test-password');
    const second=await loginUser(app!.app,'admin','central-test-password');
    expect(first.cookie).not.toBe(second.cookie);
    const a=apiClient(app!.app,first.cookie),b=apiClient(app!.app,second.cookie);
    expect(await (await a.get('/api/projects')).json()).toEqual(await (await b.get('/api/projects')).json());
    expect((await app!.app.request('/api/auth/logout',{method:'POST',headers:{cookie:first.cookie}})).status).toBe(204);
    expect((await a.get('/api/projects')).status).toBe(401);
    expect((await b.get('/api/projects')).status).toBe(200);
  });
  it('enforces native feature routes over HTTP and socket dispatch after grants change',async()=>{
    const login=await loginUser(app!.app,'ordinary','central-test-password');
    const api=apiClient(app!.app,login.cookie);
    const me=await (await api.get('/api/me')).json() as {user:{userId:string}};
    const projects=await (await api.get('/api/projects')).json() as {projects:{projectId:string}[]};
    const project=projects.projects[0]!.projectId;
    const agents=await (await api.get(`/api/projects/${project}/agents`)).json() as {agents:{agentId:string}[]};
    const agent=agents.agents[0]!.agentId;
    const paths=[
      `/api/projects/${project}/benchmarks`,
      `/api/projects/${project}/agents/${agent}/mcp-servers`,
      `/api/projects/${project}/agents/${agent}/skills`,
    ];
    const http=app!.boot.tree.api<Http>('HttpModule','http');
    modules=[];
    for(const path of paths){
      const response=await api.get(path);
      expect(response.status,path).toBe(403);
      expect(await response.json()).toMatchObject({error:{code:'module_forbidden'}});
      const socket=await http.fetchAs(me.user.userId,new Request('http://localhost'+path));
      expect(socket.status,path).toBe(403);
      expect(await socket.json()).toMatchObject({error:{code:'module_forbidden'}});
    }
    // Same login immediately observes restored and revoked permission; no cached grant.
    modules=['skills'];
    expect((await api.get(paths[2]!)).status).toBe(200);
    expect((await http.fetchAs(me.user.userId,new Request('http://localhost'+paths[2]))).status).toBe(200);
    modules=[];
    expect((await api.get(paths[2]!)).status).toBe(403);
    expect((await api.get(`/api/projects/${project}/agents`)).status).toBe(200);
  });
  it('denies ordinary admin login and isolates account switches without deleting local projects',async()=>{
    const admin=await loginUser(app!.app,'admin','central-test-password');
    const denied=await app!.app.request('/api/auth/admin-login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({userId:'ordinary',password:'central-test-password'})});
    expect(denied.status).toBe(403);
    expect(denied.headers.get('set-cookie')).toBeNull();
    const ordinary=await loginUser(app!.app,'ordinary','central-test-password');
    expect((await apiClient(app!.app,ordinary.cookie).get('/api/projects/default_project/agents')).status).toBe(404);
    expect((await apiClient(app!.app,admin.cookie).get('/api/projects/default_project/agents')).status).toBe(200);
    const count=app!.deps.db.prepare('SELECT count(*) n FROM projects').get()!.n;
    disabled=true;
    expect((await apiClient(app!.app,ordinary.cookie).get('/api/projects')).status).toBe(401);
    disabled=false;
    expect((await apiClient(app!.app,ordinary.cookie).get('/api/projects')).status).toBe(401);
    expect(app!.deps.db.prepare('SELECT count(*) n FROM projects').get()!.n).toBe(count);
  });
  it('uses central login and preserves the owner project without sending business data',async()=>{
    const login=await loginUser(app!.app,'admin','central-test-password');
    const api=apiClient(app!.app,login.cookie);
    expect((await api.get('/api/projects')).status).toBe(200);
    const me=await (await api.get('/api/me')).json() as {accountClient:boolean;user:{userId:string;passwordIsInitial:boolean}};
    expect(me).toMatchObject({accountClient:true,user:{userId:'admin',passwordIsInitial:false}});
    expect(captured.every(r=>['/api/auth/login','/api/me','/api/control/access','/api/control/catalog/roles/resolved'].includes(r.path))).toBe(true);
    expect((await app!.app.request('/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({userId:'admin',password:app!.adminPassword})})).status).toBe(401);
  });
  it('isolates an ordinary account and rejects taking over existing admin data',async()=>{
    const login=await loginUser(app!.app,'ordinary','central-test-password');
    const api=apiClient(app!.app,login.cookie);
    const me=await (await api.get('/api/me')).json() as {user:{userId:string;isAdmin:boolean}};
    expect(me.user.userId).toMatch(/^acct_/);expect(me.user.isAdmin).toBe(false);
    expect((await api.get('/api/projects/default_project')).status).toBe(404);
    expect((await api.get('/api/account-client/api/admin/users')).status).toBe(403);
    expect((await api.get('/api/projects')).status).toBe(200);
    const again=await loginUser(app!.app,'ordinary','central-test-password');
    expect((await (await apiClient(app!.app,again.cookie).get('/api/me')).json() as typeof me).user.userId).toBe(me.user.userId);
  });
  it.skipIf(!process.env.AITEST_ENGINE_ROOT)('keeps personal resource authorization in its route for a central project member',async()=>{
    const owner=apiClient(app!.app,(await loginUser(app!.app,'ordinary','central-test-password')).cookie);
    const peerLogin=await loginUser(app!.app,'peer','central-test-password');
    const peer=apiClient(app!.app,peerLogin.cookie);
    const peerId=(await (await peer.get('/api/me')).json() as {user:{userId:string}}).user.userId;
    const projectId=(await (await owner.get('/api/projects')).json() as {projects:{projectId:string}[]}).projects[0]!.projectId;
    expect((await owner.post(`/api/projects/${projectId}/members`,{userId:peerId})).status).toBe(201);
    const dataBase64=Buffer.from(zipSync({'SKILL.md':strToU8('---\nname: central-member\ndescription: Personal test guidance\n---\nUse project-specific checks.')})).toString('base64');
    const response=await peer.post(`/api/projects/${projectId}/agents/qa/personal-resources`,{kind:'skill',dataBase64});
    expect(response.status,await response.clone().text()).toBe(403);
    expect((await (await peer.get(`/api/projects/${projectId}/agents/qa/personal-resources`)).json() as {resources:unknown[]}).resources).toHaveLength(0);
    expect((await (await owner.get(`/api/projects/${projectId}/agents/qa/personal-resources`)).json() as {resources:unknown[]}).resources).toHaveLength(0);
    expect((await peer.get(`/api/projects/${projectId}/usage`)).status).toBe(403);
    const design=await peer.post(`/api/projects/${projectId}/agents/qa/tasks/missing/runs/run-main/design`,{});
    expect(design.status).toBe(404);
    expect((await design.json() as {error:{code:string}}).error.code).toBe('task_not_found');
  });
  it('fails closed on outage and revocation while preserving projects',async()=>{
    const login=await loginUser(app!.app,'admin','central-test-password');const api=apiClient(app!.app,login.cookie);
    const count=app!.deps.db.prepare('SELECT count(*) n FROM projects').get()!.n;
    offline=true;expect((await api.get('/api/projects')).status).toBe(503);
    offline=false;expect((await api.get('/api/projects')).status).toBe(200);
    tokens.clear();expect((await api.get('/api/projects')).status).toBe(401);
    expect(app!.deps.db.prepare('SELECT count(*) n FROM projects').get()!.n).toBe(count);
  });
  it('reports a misplaced HTML service as unavailable during login',async()=>{
    wrongService=true;
    const response=await app!.app.request('/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({userId:'admin',password:'central-test-password'})});
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({error:{code:'account_center_unavailable',message:'服务端不可用，请联系管理员'}});
  });
  it('refuses arbitrary proxy endpoints and extra business payload fields before forwarding',async()=>{
    const api=apiClient(app!.app,(await loginUser(app!.app,'admin','central-test-password')).cookie);
    expect((await api.post('/api/account-client/api/projects',{files:'local-private'})).status).toBe(404);
    expect((await api.post('/api/account-client/api/admin/users',{userId:'new_user',password:'example-password',files:'local-private'})).status).toBe(400);
    expect(JSON.stringify(captured)).not.toContain('local-private');
  });
  it('blocks old password-free desktop claims and verifies socket-dispatched operations',async()=>{
    expect((await app!.app.request('/api/auth/claim?token=old')).headers.get('location')).toBe('/login');
    const login=await loginUser(app!.app,'admin','central-test-password');
    expect(app!.deps.authService.authenticateWithMeta(login.cookie.split('=')[1]!)?.user.userId).toBe('admin');
    const http=app!.boot.tree.api<Http>('HttpModule','http');
    offline=true;
    expect((await http.fetchAs('admin',new Request('http://localhost/api/projects'))).status).toBe(503);
  });
  it('rejects nonlocal plaintext origins and ambiguous origin URLs',()=>{
    for(const url of ['http://example.com','https://user:password@example.com','https://example.com/path'])expect(()=>readAccountClientConfig(app!.root,{AITEST_ACCOUNT_CENTER_ORIGIN:url,AITEST_ACCOUNT_CENTER_OWNER:'admin'})).toThrow();
  });
  it('keeps local template version records scoped to visible projects without sending them centrally',async()=>{
    const login=await loginUser(app!.app,'ordinary','central-test-password');
    const api=apiClient(app!.app,login.cookie);
    const projects=await (await api.get('/api/projects')).json() as {projects:{projectId:string}[]};
    const own=projects.projects[0]!.projectId;
    const response=await api.get('/api/control/applied?projectId='+encodeURIComponent(own));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({applied:[]});
    expect((await api.get('/api/control/applied?projectId=default_project')).status).toBe(403);
    expect(captured.some(r=>r.path.includes('/applied')||r.path.includes(own))).toBe(false);
  });
});

it('blocks pinned sessions on resource revocation, module revocation and logout', async () => {
  const login = await loginUser(app!.app, 'ordinary', 'central-test-password');
  const user = apiClient(app!.app, login.cookie);
  const localId = (await (await user.get('/api/me')).json() as { user: { userId: string } }).user.userId;
  const bridge = app!.boot.tree.api<AuthState>('RuntimeModule', 'AuthState').accountClient!;
  await bridge.pinPublishedSession(localId, 'private_project', 'test_agent', 'session-revoke');
  await bridge.authorizeSessionInvocation('private_project', 'test_agent', 'session-revoke');
  resourceIds = [];
  await expect(bridge.authorizeSessionInvocation('private_project', 'test_agent', 'session-revoke')).rejects.toMatchObject({ code: 'resource_revoked' });
  resourceIds = ['a'.repeat(36)];
  modules = [];
  await expect(bridge.authorizeSessionInvocation('private_project', 'test_agent', 'session-revoke')).rejects.toMatchObject({ code: 'module_forbidden' });
  modules = ['chat'];
  await bridge.authorizeSessionInvocation('private_project', 'test_agent', 'session-revoke');
  await user.post('/api/auth/logout', {});
  await expect(bridge.authorizeSessionInvocation('private_project', 'test_agent', 'session-revoke')).rejects.toBeDefined();
});

it('uses the authenticated service policy and local device for unattended authorization', async () => {
  const { wire } = await import('@prismshadow/penguin-core/kernel');
  const { GrantCheckingAuthorizer } = await import('../src/runtime/unattended/authorizer.js');
  const { localDeviceId } = await import('../src/runtime/unattended/device-identity.js');
  await loginUser(app!.app, 'admin', 'central-test-password');
  const authState = app!.boot.tree.api<AuthState>('RuntimeModule','AuthState');
  const authorizer = wire(GrantCheckingAuthorizer, { authState, config: app!.deps.config });
  const identity = {tenantId:null, userId:'admin', deviceId:localDeviceId(app!.root), projectId:'default_project', agentId:'test_agent', taskId:'nightly'};
  const resource = {kind:'schedule_fire' as const, projectId:identity.projectId, agentId:identity.agentId, taskId:identity.taskId, slotMs:Date.now()};
  const constraints = {operation:'schedule.dispatch',now:new Date().toISOString()};
  expect((await authorizer.authorizeInvocation(identity,resource,constraints)).allowed).toBe(true);
  expect((await authorizer.authorizeInvocation({...identity,deviceId:'foreign'},resource,constraints)).reasonCode).toBe('device_mismatch');
  tokens.clear();
  expect((await authorizer.authorizeInvocation(identity,resource,constraints)).allowed).toBe(false);
});
