import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertUnlinked, skillResources, validateSkillResources } from './skill-resources.mjs';

export function mergeFallbackInstructions(current, prompt) {
  const start='<!-- qa-default-entry:start -->',end='<!-- qa-default-entry:end -->';
  const block=`${start}\n${prompt.trim()}\n${end}`;
  if(!current.includes(start) && !current.includes(end)) return `${current}${current && !current.endsWith('\n')?'\n':''}${block}\n`;
  if(current.split(start).length!==2 || current.split(end).length!==2 || current.indexOf(end)<current.indexOf(start)) throw new Error('Invalid default entry instruction markers; preserve custom content');
  return current.slice(0,current.indexOf(start))+block+current.slice(current.indexOf(end)+end.length);
}

const snapshot=files=>JSON.stringify(files.map(file=>[file.relative,createHash('sha256').update(readFileSync(file.source)).digest('hex')]));

export function syncPenguinAgents(root, targetRoot, { apply = false } = {}) {
  root = resolve(root); targetRoot = resolve(targetRoot);
  const manifest = JSON.parse(readFileSync(resolve(root, 'penguin/agents.json'), 'utf8'));
  if (manifest.shared_instructions) assertUnlinked(root, resolve(root, manifest.shared_instructions));
  const shared = manifest.shared_instructions ? readFileSync(resolve(root, manifest.shared_instructions), 'utf8') : '';
  const changes = [];
  const writes = [];
  const retirements = [];
  const destinations = new Set();
  function add(agent, source, target, content) {
    assertUnlinked(targetRoot, target);
    if (destinations.has(target)) throw new Error(`Duplicate sync destination: ${target}`);
    destinations.add(target);
    const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    if (existsSync(target) && bytes.equals(readFileSync(target))) return;
    changes.push({ agent, source, target });
    writes.push({ target, bytes });
  }
  // Validate every source and target before writing any file.
  for (const agent of manifest.agents ?? []) {
    if (!/^[a-z0-9_]+$/.test(agent.id)) throw new Error('Invalid agent id');
    const stateDir = resolve(targetRoot, agent.id, 'agent_state');
    assertUnlinked(targetRoot, stateDir);
    if (!existsSync(stateDir)) throw new Error(`目标 Agent 不存在: ${stateDir}。请先在 PenguinHarness 创建 ${agent.id}。`);
    const prompt = resolve(root, agent.prompt);
    assertUnlinked(root, prompt);
    add(agent.id, prompt, resolve(stateDir, 'AGENTS.md'), readFileSync(prompt, 'utf8') + (shared ? '\n' + shared : ''));
    for (const skill of agent.skills ?? []) {
      for (const file of validateSkillResources(root, skill)) {
        add(agent.id, file.source, resolve(stateDir, 'skills', skill, file.relative), readFileSync(file.source));
      }
    }
    for(const skill of agent.retired_skills ?? []) {
      if((agent.skills ?? []).includes(skill)) throw new Error('A skill cannot be both active and retired');
      const expected=validateSkillResources(root,skill);
      const source=resolve(stateDir,'skills',skill);
      assertUnlinked(targetRoot,source);
      if(!existsSync(source)) continue;
      const bytes=snapshot(skillResources(stateDir,skill));
      if(bytes!==snapshot(expected)) throw new Error(`Retired skill has custom or stale content; preserved without changes: ${agent.id}/${skill}`);
      const hash=createHash('sha256').update(bytes).digest('hex');
      const target=resolve(stateDir,'qa-skill-archive',`${skill}-${hash}`);
      assertUnlinked(targetRoot,target);
      if(existsSync(target)) throw new Error('Skill archive already exists; preserve both copies for maintenance');
      changes.push({agent:agent.id,source,target,action:'archive_retired_skill'});
      retirements.push({stateDir,skill,source,target,bytes});
    }
  }
  const fallback=manifest.fallback_entry;
  if(fallback) {
    if(fallback.id!=='default_agent') throw new Error('Unsupported fallback agent');
    const stateDir=resolve(targetRoot,fallback.id,'agent_state');assertUnlinked(targetRoot,stateDir);
    if(existsSync(stateDir)) {
      const source=resolve(root,fallback.prompt),target=resolve(stateDir,'AGENTS.md');
      assertUnlinked(root,source);assertUnlinked(targetRoot,target);
      add(fallback.id,source,target,mergeFallbackInstructions(existsSync(target)?readFileSync(target,'utf8'):'',readFileSync(source,'utf8')));
      for(const name of ['hooks.json','guard.mjs','project.json']) {
        const source=resolve(root,'penguin/hooks/qa-default-entry',name);
        if(name!=='project.json') assertUnlinked(root,source);
        add(fallback.id,name==='project.json'?'generated-default-entry':source,resolve(stateDir,'hooks/qa-default-entry',name),name==='project.json'?JSON.stringify({root},null,2)+'\n':readFileSync(source));
      }
    }
  }
  const hookDir = resolve(targetRoot, 'test_agent/agent_state/hooks/qa-delegation-guard');
  for (const name of ['hooks.json', 'guard.mjs', 'finish.mjs', 'project.json']) {
    const source = resolve(root, 'penguin/hooks/qa-delegation-guard', name);
    if (name !== 'project.json') assertUnlinked(root, source);
    const content = name === 'project.json' ? JSON.stringify({ root, agent_root: targetRoot }, null, 2) + '\n' : readFileSync(source);
    add('test_agent', name === 'project.json' ? 'generated-local-paths' : source, resolve(hookDir, name), content);
  }
  for(const agent of manifest.agents?.filter(agent=>agent.id!=='test_agent') ?? []) {
    const childHookDir=resolve(targetRoot,agent.id,'agent_state/hooks/qa-stage-boundary');
    for(const name of ['hooks.json','guard.mjs','project.json']) {
      const source=resolve(root,'penguin/hooks/qa-stage-boundary',name);
      if(name!=='project.json') assertUnlinked(root,source);
      const content=name==='project.json'?JSON.stringify({root,agent_root:targetRoot,agent_id:agent.id},null,2)+'\n':readFileSync(source);
      add(agent.id,name==='project.json'?'generated-child-boundary':source,resolve(childHookDir,name),content);
    }
  }
  if(apply) for(const item of retirements) {
    assertUnlinked(targetRoot,item.source);assertUnlinked(targetRoot,item.target);
    if(snapshot(skillResources(item.stateDir,item.skill))!==item.bytes || existsSync(item.target)) throw new Error('Skill changed during sync; archive refused');
    mkdirSync(dirname(item.target),{recursive:true});
    renameSync(item.source,item.target);
  }
  if (apply) for (const { target, bytes } of writes) {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes);
  }
  // Only explicitly retired, byte-identical managed skills move; unrelated files stay.
  return { status: apply ? 'synchronized' : changes.length ? 'drift_detected' : 'in_sync', target_root: targetRoot, changes: apply || !changes.length ? changes.length : changes, archived_skills:apply?retirements.map(({source,target})=>({source,target})):[] };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== '--apply' && !arg.startsWith('--target-root='))) throw new Error('Use --apply and/or --target-root=<path>');
  const targetRoot = args.find(arg => arg.startsWith('--target-root='))?.slice('--target-root='.length) ?? process.env.PENGUIN_AGENT_ROOT ?? resolve(homedir(), '.penguin/data/default_project/agents');
  const result = syncPenguinAgents(resolve(import.meta.dirname, '..'), targetRoot, { apply: args.includes('--apply') });
  console.log(JSON.stringify(result, null, 2));
  if (result.status === 'drift_detected') process.exitCode = 1;
}
