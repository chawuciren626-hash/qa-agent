import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { apiClient, createTestApp, provisionUser, type TestApp } from './helpers.js';
import { qaEngineModule } from '../src/services/qa-engine.js';

type Json = Record<string, any>;
describe.skipIf(!process.env.AITEST_ENGINE_ROOT)('personal library project references', () => {
  let app: TestApp;
  let owner: ReturnType<typeof apiClient>, member: ReturnType<typeof apiClient>;
  const project='ref_owner-project', base=`/api/projects/${project}/agents/qa`;
  const json=async(r:Response):Promise<Json>=>{expect(r.status,await r.clone().text()).toBeLessThan(300);return await r.json() as Json;};
  const file=(body:Json={},id?:string,method='POST')=>qaEngineModule('client-library').libraryOperation(app.root,project,'ref_owner',method,id,{kind:'file',name:'requirements.md',content:'Original requirements',...body});
  async function readPreview(id:string){return json(await owner.get(`${base}/knowledge/library/${id}`));}
  const payload=(p:Json)=>({confirmed:true,sourceRevision:p.source.revision,contentHash:p.source.contentHash,expectedDocumentRevision:p.reference?.revision??null});
  beforeEach(async()=>{
    app=await createTestApp();
    owner=apiClient(app.app,(await provisionUser(app.app,'ref_owner')).cookie);
    member=apiClient(app.app,(await provisionUser(app.app,'ref_member')).cookie);
    await json(await owner.post('/api/projects',{projectId:project}));
    await json(await owner.post(`/api/projects/${project}/members`,{userId:'ref_member'}));
  });
  afterEach(async()=>{await app?.cleanup();});

  it('requires confirmation, isolates private sources and deduplicates concurrent confirmations',async()=>{
    const source=await file(), endpoint=`${base}/knowledge/library/${source.id}`, p=await readPreview(source.id);
    expect(p.reference).toBeNull();
    expect((await member.get(endpoint)).status).toBe(404);
    expect((await member.post(endpoint,payload(p))).status).toBe(403);
    expect((await owner.post(endpoint,{...payload(p),confirmed:false})).status).toBe(400);
    const results=await Promise.all([owner.post(endpoint,payload(p)),owner.post(endpoint,payload(p))]);
    const bodies=await Promise.all(results.map(json));
    expect(bodies.map(b=>b.idempotent).sort()).toEqual([false,true]);
    expect(bodies[0]!.document.document.documentId).toBe(bodies[1]!.document.document.documentId);
    expect((await json(await owner.get(`${base}/documents`))).documents).toHaveLength(1);
    expect((await member.get(`${base}/documents/${bodies[0]!.document.document.documentId}`)).status).toBe(200);
  });

  it('preserves revisions, rejects stale source and destination previews, and retains deleted-source snapshots',async()=>{
    let source=await file(); const endpoint=`${base}/knowledge/library/${source.id}`;
    const original=await readPreview(source.id);
    const first=await json(await owner.post(endpoint,payload(original)));
    const id=first.document.document.documentId;
    source=await file({revision:source.revision,content:'Updated requirements'},source.id,'PUT');
    expect((await owner.post(endpoint,payload(original))).status).toBe(409);
    const fresh=await readPreview(source.id);
    await json(await owner.put(`${base}/documents/${id}`,{expectedRevision:1,content:'Independent edit'}));
    expect((await owner.post(endpoint,payload(fresh))).status).toBe(409);
    const updated=await json(await owner.post(endpoint,payload(await readPreview(source.id))));
    expect(updated.document.document).toMatchObject({documentId:id,currentRevision:3});
    expect(updated.document.content).toBe('Updated requirements');
    expect((await json(await owner.get(`${base}/documents/${id}/revisions/1`))).content).toBe('Original requirements');
    await file({revision:source.revision},source.id,'DELETE');
    expect((await owner.get(endpoint)).status).toBe(404);
    expect((await json(await owner.get(`${base}/documents/${id}`))).content).toBe('Updated requirements');
  });

  it('does not restore archived references or silently change formats',async()=>{
    let source=await file();const endpoint=`${base}/knowledge/library/${source.id}`;
    const first=await json(await owner.post(endpoint,payload(await readPreview(source.id))));
    const id=first.document.document.documentId;
    source=await file({revision:source.revision,name:'requirements.json',content:'{}'},source.id,'PUT');
    const changed=await owner.post(endpoint,payload(await readPreview(source.id)));
    expect(changed.status).toBe(409);
    expect((await changed.json() as Json).error.code).toBe('library_format_changed');
    await json(await owner.delete(`${base}/documents/${id}?expectedRevision=1`));
    const archived=await owner.post(endpoint,payload(await readPreview(source.id)));
    expect(archived.status).toBe(409);
    expect((await archived.json() as Json).error.code).toBe('document_archived');
  });

  it('rejects links, invalid UTF-8 and oversized project text',async()=>{
    for(const fixture of [
      {kind:'link',name:'link.md',content:'https://example.com'},
      {name:'binary.txt',content:Buffer.from([255,254,253]).toString('base64'),encoding:'base64'},
      {name:'large.txt',content:'x'.repeat(2*1024*1024+1)},
    ]){
      const source=await file(fixture);
      expect((await owner.get(`${base}/knowledge/library/${source.id}`)).status).toBe(fixture.name==='large.txt'?413:400);
    }
  });

  it('carries the referenced content revision through proposal and owner confirmation',async()=>{
    const source=await file(), endpoint=`${base}/knowledge/library/${source.id}`;
    const reference=await json(await owner.post(endpoint,payload(await readPreview(source.id))));
    const sourceRefs=[{type:'document',documentId:reference.document.document.documentId,revision:1}];
    const candidate=await json(await member.post(`${base}/knowledge/candidates`,{title:'Requirement',statement:'Verify requirements',sourceRefs}));
    expect((await member.post(`${base}/knowledge/candidates/${candidate.candidateId}/confirm`,{expectedRevision:1})).status).toBe(403);
    const accepted=await json(await owner.post(`${base}/knowledge/candidates/${candidate.candidateId}/confirm`,{expectedRevision:1}));
    expect(accepted.candidate.status).toBe('accepted');
    expect(accepted.rule.sourceRefs).toEqual(sourceRefs);
  });
});
