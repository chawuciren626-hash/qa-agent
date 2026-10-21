import {readFileSync,writeFileSync,existsSync,mkdirSync,openSync,closeSync,unlinkSync,renameSync} from 'node:fs';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {syncPenguinAgents} from './sync-penguin-agents.mjs';
import {inspectProductService} from './product-doctor.mjs';
import {configureProductAgentTools} from './product-agent-tools.mjs';

const json=p=>JSON.parse(readFileSync(p,'utf8'));
function save(path,value) {const tmp=path+'.'+randomUUID()+'.tmp';writeFileSync(tmp,JSON.stringify(value,null,2)+'\n',{flag:'wx'});try{renameSync(tmp,path);}finally{if(existsSync(tmp))unlinkSync(tmp);}}
export async function initializeProductAgents(layout,{fetcher=fetch,serviceCheck=inspectProductService,synchronize=syncPenguinAgents,configureTools=configureProductAgentTools}={}) {
  if(layout.layout!=='unified')throw new Error('First-run provisioning is only for isolated unified installations');
  mkdirSync(layout.paths.qa_data,{recursive:true});
  const journal=resolve(layout.paths.qa_data,'agent-initialization.json'),lock=resolve(layout.paths.qa_data,'agent-initialization.lock');
  const fd=openSync(lock,'wx');
  try {
    writeFileSync(fd,JSON.stringify({pid:process.pid,installation_id:layout.installation_id}));
    const state=existsSync(journal)?json(journal):{version:1,installation_id:layout.installation_id,project_id:layout.project_id,status:'initializing',owned:[]};
    if(state.version!==1||state.installation_id!==layout.installation_id||state.project_id!==layout.project_id||!Array.isArray(state.owned))throw new Error('Initialization journal belongs to another installation');
    if(state.status==='complete'&&state.tool_interface_version===1)return {status:'already_initialized',agents:state.owned.length};
    const service=await serviceCheck(layout,{fetcher});if(service.status!=='ready')throw new Error('Host must be authenticated and ready before provisioning');
    const token=readFileSync(resolve(layout.paths.host_data,'api-token'),'utf8').trim();
    const base=`http://localhost:${service.port}/api/projects/${encodeURIComponent(layout.project_id)}/agents`;
    async function request(url,body,method=body?'POST':'GET') {
      const response=await fetcher(url,{method,headers:{authorization:'Bearer '+token,...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),redirect:'error',signal:AbortSignal.timeout(15000)});
      if(!response.ok)throw new Error('Agent initialization request failed (HTTP '+response.status+')');
      return response.json();
    }
    const manifest=json(resolve(layout.paths.engine,'penguin/agents.json'));
    const existing=await request(base);
    if(!Array.isArray(existing.agents))throw new Error('Invalid host agent inventory');
    const ids=new Set(existing.agents.map(a=>a.agentId));
    // Refuse all ownership collisions before creating or modifying any Agent.
    for(const agent of manifest.agents)if(ids.has(agent.id)&&!state.owned.includes(agent.id))throw new Error('Existing unmanaged QA agent; initialization refused');
    save(journal,state);
    for(const agent of manifest.agents) {
      if(!ids.has(agent.id)) {
        if(!state.owned.includes(agent.id)){state.owned.push(agent.id);save(journal,state);}
        const title=readFileSync(resolve(layout.paths.engine,agent.prompt),'utf8').split(/\r?\n/)[0].replace(/^#\s*/, '').trim();
        await request(base,{agentId:agent.id,name:title,plugins:[]});
      }
    }
    const result=synchronize(layout.paths.engine,layout.agent_root,{apply:true});
    if(result.status!=='synchronized')throw new Error('QA resources were not synchronized');
    await configureTools({...layout,port:service.port},manifest.agents.map(a=>a.id),request);
    state.status='complete';state.tool_interface_version=1;state.finished_at=new Date().toISOString();save(journal,state);
    return {status:'initialized',agents:state.owned.length,model_requests_sent:0};
  } finally {closeSync(fd);unlinkSync(lock);}
}
