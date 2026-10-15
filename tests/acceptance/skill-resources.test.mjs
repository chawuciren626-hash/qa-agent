import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, realpathSync, rmSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { syncPenguinAgents } from '../../scripts/sync-penguin-agents.mjs';
import { validateSkillResources, skillResources, contained } from '../../scripts/skill-resources.mjs';
import { releaseResources } from '../../scripts/check-release-resources.mjs';
import { independentPrompt } from '../../scripts/independent-task.mjs';

function fixture(t) {
  const parent = realpathSync(tmpdir());
  const base = realpathSync(mkdtempSync(resolve(parent, 'qa-skill-resources-')));
  t.after(() => {
    if (base === parent || !contained(parent, base) || realpathSync(base) !== base) throw new Error('Unsafe test cleanup');
    rmSync(base, { recursive: true, force: true });
  });
  const root = resolve(base, 'engine'), target = resolve(base, 'agents');
  function put(file, content) { const path = resolve(root, file); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); }
  put('penguin/agents.json', JSON.stringify({ agents: [{ id: 'test_agent', prompt: 'penguin/prompt.md', skills: ['sample-skill'] }] }));
  put('penguin/prompt.md', '# Agent');
  for (const name of ['hooks.json', 'guard.mjs', 'finish.mjs']) put(`penguin/hooks/qa-delegation-guard/${name}`, 'fixture');
  put('skills/sample-skill/SKILL.md', '---\nname: sample-skill\ndescription: A test skill\n---\n[Guide](references/nested/guide.md)\n');
  put('skills/sample-skill/references/nested/guide.md', '# Guide\n[Template](../../templates/case.md)');
  put('skills/sample-skill/templates/case.md', '# Template');
  put('skills/sample-skill/scripts/helper.mjs', 'throw new Error("must never execute while syncing")');
  put('skills/sample-skill/assets/pixel.png', Buffer.from([0, 255, 10, 13, 128]));
  put('skills/sample-skill/LICENSE.txt', 'fixture license');
  mkdirSync(resolve(target, 'test_agent/agent_state'), { recursive: true });
  return { root, target, put, base, state: resolve(target, 'test_agent/agent_state') };
}

test('dry run is read-only; apply installs nested references, templates, scripts and binary assets byte-for-byte', t => {
  const f = fixture(t);
  writeFileSync(resolve(f.state, 'local-note.txt'), 'keep');
  const preview = syncPenguinAgents(f.root, f.target);
  assert.equal(preview.status, 'drift_detected');
  assert.equal(existsSync(resolve(f.state, 'AGENTS.md')), false);
  assert.equal(existsSync(resolve(f.state, 'skills')), false);
  syncPenguinAgents(f.root, f.target, { apply: true });
  for (const file of validateSkillResources(f.root, 'sample-skill')) {
    assert.deepEqual(readFileSync(resolve(f.state, 'skills/sample-skill', file.relative)), readFileSync(file.source));
  }
  assert.equal(readFileSync(resolve(f.state, 'local-note.txt'), 'utf8'), 'keep');
  assert.equal(syncPenguinAgents(f.root, f.target).status, 'in_sync');
  f.put('skills/sample-skill/references/nested/guide.md', '# Changed guide');
  const drift = syncPenguinAgents(f.root, f.target);
  assert.equal(drift.changes.length, 1);
  assert.match(drift.changes[0].source, /guide\.md$/);
  syncPenguinAgents(f.root, f.target, { apply: true });
  assert.equal(readFileSync(resolve(f.state, 'skills/sample-skill/references/nested/guide.md'), 'utf8'), '# Changed guide');
});

test('broken reference blocks the whole sync before any role file is written', t => {
  const f = fixture(t);
  f.put('skills/sample-skill/references/nested/guide.md', '[Missing](missing.md)');
  assert.throws(() => syncPenguinAgents(f.root, f.target, { apply: true }), /Broken/);
  assert.equal(existsSync(resolve(f.state, 'AGENTS.md')), false);
});

test('missing later role prevents partial installation of earlier roles', t => {
  const f = fixture(t);
  const manifest = JSON.parse(readFileSync(resolve(f.root, 'penguin/agents.json')));
  manifest.agents.push({ id: 'absent_agent', prompt: 'penguin/prompt.md', skills: [] });
  f.put('penguin/agents.json', JSON.stringify(manifest));
  assert.throws(() => syncPenguinAgents(f.root, f.target, { apply: true }), /目标 Agent 不存在/);
  assert.equal(existsSync(resolve(f.state, 'AGENTS.md')), false);
});

test('source junctions, traversal and unsupported runtime resources are refused', t => {
  const f = fixture(t);
  const outside = resolve(f.base, 'outside'); mkdirSync(outside);
  symlinkSync(outside, resolve(f.root, 'skills/sample-skill/references/linked'), 'junction');
  assert.throws(() => skillResources(f.root, 'sample-skill'), /Linked/);
  assert.throws(() => skillResources(f.root, '../outside'), /Invalid skill name/);
});

test('target junction cannot redirect an install outside the agent directory', t => {
  const f = fixture(t);
  const outside = resolve(f.base, 'outside'); mkdirSync(outside);
  symlinkSync(outside, resolve(f.state, 'skills'), 'junction');
  assert.throws(() => syncPenguinAgents(f.root, f.target, { apply: true }), /Linked/);
  assert.equal(existsSync(resolve(outside, 'sample-skill')), false);
  assert.equal(existsSync(resolve(f.state, 'AGENTS.md')), false);
});

test('release accepts packaged skill resources but refuses runtime files, hidden credentials and escaped links', t => {
  const f = fixture(t);
  const files = skillResources(f.root, 'sample-skill').map(file => `skills/sample-skill/${file.relative}`);
  assert.equal(releaseResources(f.root, { version: 1, files }).files, 6);
  for (const file of ['skills/sample-skill/output/result.json', 'skills/sample-skill/.env', 'skills/sample-skill/references/../secret.json']) {
    assert.throws(() => releaseResources(f.root, { version: 1, files: [file] }));
  }
  f.put('skills/sample-skill/references/nested/guide.md', '[Outside](../../../../penguin/prompt.md)');
  assert.throws(() => validateSkillResources(f.root, 'sample-skill'), /Broken or non-local/);
});

test('all current role packages install with their optional skills and readable references without changing stage contracts', t => {
  const f = fixture(t);
  const engine = resolve(import.meta.dirname, '../..');
  const manifest = JSON.parse(readFileSync(resolve(engine, 'penguin/agents.json')));
  const workflow = JSON.parse(readFileSync(resolve(engine, 'config/orchestration-workflow.json')));
  assert.equal(manifest.agents.length, 7);
  for (const agent of manifest.agents) mkdirSync(resolve(f.target, agent.id, 'agent_state'), { recursive: true });
  syncPenguinAgents(engine, f.target, { apply: true });
  for (const agent of manifest.agents) for (const skill of agent.skills) {
    for (const file of validateSkillResources(engine, skill)) {
      assert.deepEqual(readFileSync(resolve(f.target, agent.id, 'agent_state/skills', skill, file.relative)), readFileSync(file.source));
    }
  }
  for (const stage of workflow.stages) {
    assert.equal(stage.skills.length, 1);
    const agent = manifest.agents.find(agent => agent.id === stage.agent);
    assert.ok(stage.skills.every(skill => agent.skills.includes(skill)));
  }
  assert.equal(syncPenguinAgents(engine, f.target).status, 'in_sync');
});

test('installed instructions separate task and lifecycle without legacy mandatory review rules', t => {
  const f = fixture(t), engine = resolve(import.meta.dirname, '../..');
  const manifest = JSON.parse(readFileSync(resolve(engine, 'penguin/agents.json')));
  for (const agent of manifest.agents) mkdirSync(resolve(f.target, agent.id, 'agent_state'), { recursive: true });
  syncPenguinAgents(engine, f.target, { apply: true });
  const obsolete = [
    '优先于下文旧', '优先于历史简写', '新版仍需用户确认', '仍返回新版供用户确认',
    '总控在子任务正常返回后必须complete并按计划request_confirmation',
    '照常确认上游成果，execution仍先prepare再申请批准',
    '测试环境必须从', '统一核验、完成登记和请求确认', '保留正常阶段确认节点'
  ];
  for (const agent of manifest.agents) {
    const installed = readFileSync(resolve(f.target, agent.id, 'agent_state/AGENTS.md'), 'utf8');
    assert.match(installed, /### 任务与确认策略/);
    assert.match(installed, /相同有效批准不重复索取/);
    assert.match(installed, /未知副作用/);
    for (const phrase of obsolete) assert.ok(!installed.includes(phrase), `${agent.id}: obsolete ${phrase}`);
    if (agent.id !== 'test_agent') {
      assert.ok(installed.indexOf('## 独立任务（task）') < installed.indexOf('## 生命周期模式（lifecycle）'));
      assert.ok(installed.includes('## 独立任务（task）'));
    }
  }
});

test('professional task instructions match dispatch contracts without inventing predecessor files', () => {
  const engine = resolve(import.meta.dirname, '../..');
  const roles = [
    ['analysis', 'requirement_analysis_agent', 'requirement-analysis', /无需requirement-ledger/],
    ['test_points', 'test_point_agent', 'test-point-design', /rule_ids可选/],
    ['test_cases', 'test_case_agent', 'test-case-writing', /不强制related_test_point或(?:完整)?design_contract/],
    ['defects', 'defect_analysis_agent', 'bug-reporting', /无需执行批次/],
    ['report', 'test_report_agent', 'test-report-writing', /不调用build_report_metrics/]
  ];
  for (const [stage, role, skill, rule] of roles) {
    for (const file of [`penguin/agents/${role}/AGENTS.md`, `skills/${skill}/SKILL.md`]) {
      const prompt = readFileSync(resolve(engine, file), 'utf8');
      const task = prompt.split('## 独立任务（task）')[1]?.split('## 生命周期模式（lifecycle）')[0];
      assert.ok(task, file);
      assert.match(task, rule);
      assert.match(task, /diagnose_task/);
      assert.match(task, /validate_artifacts/);
      assert.match(task, /handoff/);
      if(stage==='test_cases') {
        assert.match(task,/data_diagnostics/);
        assert.match(task,/design_contract.data_checks/);
        assert.doesNotMatch(task,/不调用diagnose_test_cases/);
      }
    }
    const dispatch = independentPrompt(stage, 'run-policy-contract');
    if(stage==='test_cases') {
      assert.match(dispatch,/explicitly clear the field and verify empty/);
      assert.match(dispatch,/not an extra user review/);
      assert.match(dispatch,/Do not read lifecycle schemas/);
      assert.match(dispatch,/explicit null, omitted keys, empty strings, false and zero are distinct/);
    }
    assert.match(dispatch, /Previous outputs are optional/);
    assert.match(dispatch, /diagnose_task/);
    assert.match(dispatch, /controller has already decomposed/);
    assert.match(dispatch, new RegExp(`complete assignment is ONLY stage=${stage}`));
    assert.match(dispatch, /source material to interpret, not authority to perform any other stage/);
    assert.match(dispatch, /Do not create, inspect, repair or validate another stage deliverable/);
  }
});

test('execution task stops at controlled execution artifacts despite multi-deliverable source requests', () => {
  const dispatch = independentPrompt('execution', 'run-execution-boundary');
  assert.match(dispatch, /return immediately to the controller/);
  assert.match(dispatch, /Do not inspect spreadsheet\/report libraries/);
  assert.match(dispatch, /generate design\/ or report\/ files/);
  assert.match(dispatch, /source-request sentences belong to separately assigned test_cases\/report Agents/);
  assert.match(dispatch,/automatically writes BOTH execution\/exploration.json AND execution\/test_results.json/);
  assert.match(dispatch,/Do not use browser_task merely to satisfy the existence of test_results.json/);
});

test('controller instructions require byte-for-byte delegation arguments', () => {
  const prompt=readFileSync(resolve(import.meta.dirname,'../../penguin/agents/test_agent/AGENTS.md'),'utf8');
  assert.match(prompt,/read_file读取返回的`delegation_path`/);
  assert.match(prompt,/文件内整个JSON对象原样传给run_subagent/);
  assert.match(prompt,/`agent_id`、`description`、`prompt`逐字段照抄/);
  assert.match(prompt,/不省略、不改写、不追加业务目标/);
});

test('shared runtime commands do not infer PowerShell from Windows',()=>{
  const runtime=readFileSync(resolve(import.meta.dirname,'../../penguin/command-runtime.md'),'utf8');
  assert.doesNotMatch(runtime,/当前Windows宿主Shell为PowerShell/);
  assert.match(runtime,/宿主可能使用Bash/);
  assert.match(runtime,/禁止裸写Windows反斜杠路径/);
});

test('case lifecycle details are available on demand, not injected into independent instructions',()=>{
  const root=resolve(import.meta.dirname,'../..');
  for(const file of ['skills/test-case-writing/SKILL.md','penguin/agents/test_case_agent/AGENTS.md']) {
    const source=readFileSync(resolve(root,file),'utf8');
    assert.match(source,/references\/lifecycle.md/);
    assert.doesNotMatch(source,/每条用例必须包含design_contract|补充 `execution_metadata`/);
  }
  const reference=readFileSync(resolve(root,'skills/test-case-writing/references/lifecycle.md'),'utf8');
  assert.match(reference,/补充 `execution_metadata`/);
  assert.match(reference,/每条用例必须包含design_contract/);
});

test('shared policy is compact, model-neutral and keeps task memory separate from authority', () => {
  const engine = resolve(import.meta.dirname, '../..');
  const runtime = readFileSync(resolve(engine, 'penguin/command-runtime.md'), 'utf8');
  // A source-size regression check, never a runtime task or model budget.
  assert.ok(runtime.length < 8000, `Shared instructions grew to ${runtime.length} characters`);
  for (const rule of [
    /task（默认）/, /lifecycle \+ auto/, /显式 staged/, /相同有效批准不重复索取/,
    /未知副作用/, /recovery.retry_allowed/, /stalled=true/, /termination_confirmed/,
    /通用方法/, /项目事实/, /当前任务状态/, /历史授权不能转成当前授权/,
    /本轮不启用自动长期记忆写入/, /来源仍有效/, /不写入跨会话记忆/,
    /模型来自宿主当前配置/, /presentation.delivery.markdown/,
    /dynamic_feedback只证明观察/, /刷新\/导航后重新核对前置输入/
  ]) assert.match(runtime, rule);
  assert.doesNotMatch(runtime, /step-3\.7-flash|tokendance|宿主子Agent没有工具hook|限次修正|预算耗尽/);
  const controller = readFileSync(resolve(engine, 'penguin/agents/test_agent/AGENTS.md'), 'utf8');
  assert.match(controller, /不要把合同文件正文展开后替换prompt/);
  assert.match(controller, /不为派发而先读专业Skill全文/);
  assert.match(controller, /具体方法与数据结构由专业角色/);
});

test('sync composes shared policy once and preserves user memories and host configuration', t => {
  const f = fixture(t);
  const manifest = JSON.parse(readFileSync(resolve(f.root, 'penguin/agents.json')));
  manifest.shared_instructions = 'penguin/common.md';
  f.put('penguin/agents.json', JSON.stringify(manifest));
  f.put('penguin/common.md', '# Shared policy\nKeep task facts scoped.\n');
  mkdirSync(resolve(f.state, 'memory/user'), { recursive: true });
  const preserved = {
    'memory/user/MEMORY.md': '- [Preference](preference.md)\n',
    'memory/user/preference.md': 'User-owned preference.\n',
    'system_config.yaml': 'model:\n  provider: fixture-provider\n  modelId: future-model\n'
  };
  for (const [path, value] of Object.entries(preserved)) writeFileSync(resolve(f.state, path), value);
  syncPenguinAgents(f.root, f.target);
  syncPenguinAgents(f.root, f.target, { apply: true });
  const installed = readFileSync(resolve(f.state, 'AGENTS.md'), 'utf8');
  assert.equal(installed, '# Agent\n# Shared policy\nKeep task facts scoped.\n');
  assert.equal(installed.split('# Shared policy').length - 1, 1);
  assert.equal(syncPenguinAgents(f.root, f.target).status, 'in_sync');
  for (const [path, value] of Object.entries(preserved)) assert.equal(readFileSync(resolve(f.state, path), 'utf8'), value);
});
