import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { randomUUID } from "node:crypto";
import { createTestApp, apiClient, loginUser } from "./helpers.js";
import type { TestApp } from "./helpers.js";
import { readAccountClientConfig } from "../src/auth/account-client.js";
import type { Http } from "../src/http/app.js";

let server:Server, app:TestApp|undefined, origin:string, offline=false;
let modules:string[], disabled=false;
const tokens=new Map<string,string>();
const captured:{path:string;body:unknown}[]=[];
beforeEach(async()=>{
  tokens.clear();captured.length=0;offline=false;
  modules=["chat","projects","models","plugins","skills"];disabled=false;
  server=createServer(async(req,res)=>{
    let raw="";for await(const chunk of req)raw+=chunk;
    const body=raw?JSON.parse(raw):undefined;
    captured.push({path:req.url!,body});
    res.setHeader("content-type","application/json");
    if(offline){res.writeHead(503);res.end('{}');return;}
    if(req.url==="/api/auth/login") {
      if(body.password!=="central-test-password"){res.writeHead(401);res.end('{"error":{"code":"invalid_credentials"}}');return;}
      const token=randomUUID();tokens.set(token,body.userId);
      res.setHeader("set-cookie",`penguin_session=${token}; HttpOnly; Path=/`);
      res.end(JSON.stringify({user:{userId:body.userId,isAdmin:body.userId==="admin",createdAt:new Date().toISOString(),passwordIsInitial:false}}));return;
    }
    if(req.url==="/api/auth/registration"){res.end('{"enabled":true,"accountCenter":true}');return;}
    const id=tokens.get((req.headers.cookie??'').replace('penguin_session=',''));
    if(!id){res.writeHead(401);res.end('{}');return;}
    if(req.url==="/api/control/access"){res.end(JSON.stringify({modules,resourceIds:[]}));return;}
    if(req.url==="/api/me"){res.end(JSON.stringify({user:{userId:id,isAdmin:id==="admin",disabled,passwordIsInitial:false,createdAt:new Date().toISOString()}}));return;}
    res.end('{}');
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  origin=`http://localhost:${(server.address() as {port:number}).port}`;
  app=await createTestApp({config:{accountClient:{origin,ownerUserId:'admin'}},durableDatabase:true});
});
afterEach(async()=>{await app?.cleanup();app=undefined;await new Promise<void>(resolve=>server.close(()=>resolve()));});
describe('central identity with full local application',()=>{
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
      `/api/projects/${project}/agents/qa/personal-resources`,
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
    expect(captured.every(r=>['/api/auth/login','/api/me','/api/control/access'].includes(r.path))).toBe(true);
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
  it('fails closed on outage and revocation while preserving projects',async()=>{
    const login=await loginUser(app!.app,'admin','central-test-password');const api=apiClient(app!.app,login.cookie);
    const count=app!.deps.db.prepare('SELECT count(*) n FROM projects').get()!.n;
    offline=true;expect((await api.get('/api/projects')).status).toBe(503);
    offline=false;expect((await api.get('/api/projects')).status).toBe(200);
    tokens.clear();expect((await api.get('/api/projects')).status).toBe(401);
    expect(app!.deps.db.prepare('SELECT count(*) n FROM projects').get()!.n).toBe(count);
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
