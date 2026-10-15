import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, cpSync, readFileSync, writeFileSync, existsSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { syncPenguinAgents, mergeFallbackInstructions } from '../../scripts/sync-penguin-agents.mjs';
import { guardDefaultDelegation } from '../../scripts/default-agent-guard.mjs';

const root=resolve(import.meta.dirname,'../..');
const manifest=JSON.parse(readFileSync(resolve(root,'penguin/agents.json')));
function fixture(t) {
  const parent=realpathSync(tmpdir()),target=realpathSync(mkdtempSync(resolve(parent,'qa-role-boundary-')));
  t.after(()=>{assert.ok(target.startsWith(resolve(parent,'qa-role-boundary-')));assert.equal(realpathSync(target),target);rmSync(target,{recursive:true,force:true});});
  for(const id of [...manifest.agents.map(a=>a.id),'default_agent']) mkdirSync(resolve(target,id,'agent_state'),{recursive:true});
  return {target,state:id=>resolve(target,id,'agent_state')};
}

test('controller retires only byte-identical managed skills; other skills and settings survive',t=>{
  const f=fixture(t),controller=manifest.agents.find(a=>a.id==='test_agent');
  assert.deepEqual(controller.skills,[]);assert.equal(controller.retired_skills.length,11);
  for(const skill of controller.retired_skills) cpSync(resolve(root,'skills',skill),resolve(f.state('test_agent'),'skills',skill),{recursive:true});
  const custom=resolve(f.state('test_agent'),'skills/custom');mkdirSync(custom);writeFileSync(resolve(custom,'SKILL.md'),'user-owned');
  const config=resolve(f.state('test_agent'),'system_config.yaml');writeFileSync(config,'future-provider-and-model');
  const check=syncPenguinAgents(root,f.target);assert.equal(check.status,'drift_detected');
  assert.ok(existsSync(resolve(f.state('test_agent'),'skills',controller.retired_skills[0])));
  const result=syncPenguinAgents(root,f.target,{apply:true});assert.equal(result.archived_skills.length,11);
  for(const move of result.archived_skills) {assert.equal(existsSync(move.source),false);assert.ok(existsSync(resolve(move.target,'SKILL.md')));}
  assert.equal(readFileSync(resolve(custom,'SKILL.md'),'utf8'),'user-owned');
  assert.equal(readFileSync(config,'utf8'),'future-provider-and-model');
  assert.equal(syncPenguinAgents(root,f.target).status,'in_sync');
  for(const role of manifest.agents.filter(a=>a.id!=='test_agent')) for(const skill of role.skills) assert.ok(existsSync(resolve(f.state(role.id),'skills',skill,'SKILL.md')));
});

test('modified retired skill refuses sync before any changes',t=>{
  const f=fixture(t),name=manifest.agents[0].retired_skills[0];
  cpSync(resolve(root,'skills',name),resolve(f.state('test_agent'),'skills',name),{recursive:true});
  const path=resolve(f.state('test_agent'),'skills',name,'SKILL.md');writeFileSync(path,'customized');
  assert.throws(()=>syncPenguinAgents(root,f.target,{apply:true}),/custom or stale/);
  assert.equal(readFileSync(path,'utf8'),'customized');assert.equal(existsSync(resolve(f.state('test_agent'),'AGENTS.md')),false);
});

test('default fallback preserves custom instructions and installs an executable delegation guard',t=>{
  const f=fixture(t),prompt=resolve(f.state('default_agent'),'AGENTS.md');writeFileSync(prompt,'Existing general instructions.\n');
  syncPenguinAgents(root,f.target,{apply:true});
  const installed=readFileSync(prompt,'utf8');assert.ok(installed.startsWith('Existing general instructions.\n'));
  assert.match(installed,/不是软件测试总控/);assert.equal(installed.split('qa-default-entry:start').length,2);
  assert.equal(syncPenguinAgents(root,f.target).status,'in_sync');
  const hook=resolve(f.state('default_agent'),'hooks/qa-default-entry/guard.mjs');
  const child=spawnSync(process.execPath,[hook],{input:JSON.stringify({tool_name:'run_subagent',arguments:{agent_id:'test_case_agent'}}),encoding:'utf8'});
  assert.equal(child.status,0);assert.equal(JSON.parse(child.stdout).decision,'deny');
  assert.throws(()=>mergeFallbackInstructions('<!-- qa-default-entry:start -->','test'),/markers/);
});

test('default cannot call any QA role, but unrelated work and tools remain available',()=>{
  for(const agent of manifest.agents) assert.equal(guardDefaultDelegation(root,{tool_name:'run_subagent',arguments:JSON.stringify({agent_id:agent.id})}).decision,'deny');
  assert.deepEqual(guardDefaultDelegation(root,{tool_name:'run_subagent',arguments:{agent_id:'unrelated_user_agent'}}),{});
  assert.deepEqual(guardDefaultDelegation(root,{tool_name:'read_file'}),{});
  assert.equal(guardDefaultDelegation(root,{tool_name:'run_subagent',arguments:'broken'}).decision,'deny');
});
