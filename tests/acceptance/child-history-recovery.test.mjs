import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertChildCommands } from '../../scripts/child-command-policy.mjs';

const options = { allowRecovery: true, requireControlledCommands: true };
const call = (name, id, args) => ({ payload: { type: 'tool_call', name, tool_call_id: id, arguments: args } });
const output = (id, value, stop_reason = 'completed') => ({ payload: { type: 'tool_call_output', tool_call_id: id, output: value, stop_reason } });
const success = JSON.stringify({ status: 'completed', exit_code: 0, result: { termination_confirmed: true } });
test('catalog recovery accepts Node 24 entry errors and archived help, never archived execution',()=>{
  const lookup=call('exec_command','catalog',{cmd:'node scripts/project-action.mjs catalog'});
  const missing="Error: Cannot find module 'project-action.mjs'\n at Module.executeUserEntryPoint (run_main:1)\n code: 'MODULE_NOT_FOUND', requireStack: []\n[exit code: 1]";
  const help='{ "status": "help", "actions": {\n[truncated]\n}\n[output archived: scratchpad/catalog.log]';
  const recovered=[lookup,output('catalog',missing),call('exec_command','fixed',{cmd:'node scripts/project-action.mjs catalog'}),output('fixed',help)];
  assert.doesNotThrow(()=>assertChildCommands(recovered,options));
  assert.throws(()=>assertChildCommands(recovered.slice(0,2),options),/catalog lookup failure/);
  // A successful business action also proves the child moved past the read-only lookup failure.
  assert.doesNotThrow(()=>assertChildCommands([...recovered.slice(0,2),call('exec_command','execute',{cmd:'node scripts/project-action.mjs execute'}),output('execute',success)],options));
  assert.throws(()=>assertChildCommands([call('exec_command','execute',{cmd:'node scripts/project-action.mjs execute'}),output('execute',help)],options),/unreadable/);
  assert.throws(()=>assertChildCommands([lookup,output('catalog',help,'fatal')],options),/unreadable/);
});

test('detached read-only catalog with an empty poll does not block later verified actions',()=>{
  const background='[command running in background with process_id proc-a; its completion will arrive as a user message — no need to poll. Use input_command to interact (kill: true stops it)]';
  const catalog=[call('exec_command','catalog',{cmd:'node scripts/project-action.mjs catalog'}),output('catalog',background),call('input_command','poll',{process_id:'proc-a'}),output('poll','[no output]')];
  assert.doesNotThrow(()=>assertChildCommands([...catalog,call('exec_command','execute',{cmd:'node scripts/project-action.mjs execute'}),output('execute',success)],options));
  assert.throws(()=>assertChildCommands(catalog.slice(0,2),options),/unreadable/);
  assert.throws(()=>assertChildCommands([call('exec_command','catalog',{cmd:'node scripts/project-action.mjs execute'}),...catalog.slice(1)],options),/unreadable/);
  const failedPoll=[...catalog];failedPoll[3]=output('poll','failed','fatal');
  assert.throws(()=>assertChildCommands(failedPoll,options),/unreadable/);
  // Silence is a property of every poll, not of a poll count: confirming a second time
  // that the background catalog printed nothing must not become an unresolved debt.
  const silentAgain=[...catalog,call('input_command','poll-again',{process_id:'proc-a'}),output('poll-again','[no output]')];
  assert.doesNotThrow(()=>assertChildCommands([...silentAgain,call('exec_command','execute',{cmd:'node scripts/project-action.mjs execute'}),output('execute',success)],options));
  // A poll that does return content is a real result; it must not be waved through as silence.
  const noisyPoll=[...catalog,call('input_command','poll-again',{process_id:'proc-a'}),output('poll-again','["help"]')];
  assert.throws(()=>assertChildCommands(noisyPoll,options),/unreadable/);
});
const launch = () => [
  call('exec_command', 'launch', { cmd: 'node scripts/project-action.mjs execute' }),
  output('launch', '[process running with process_id proc-a; use input_command to send input or poll for output]')
];
const poll = (id = 'finish', value = success, stop = 'completed', process_id = 'proc-a') => [
  call('input_command', id, { process_id }), output(id, value, stop)
];
const malformed = () => [
  call('input_command', 'truncated', '{"process_id":"proc-'),
  { type: 'event_msg', payload: {
    type: 'request_end', status: 'retryable', error_code: 'malformed',
    error_message: 'Invalid streamed tool call arguments from OpenaiChatClient for tool "input_command" (tool_call_id="truncated", length=20): Unterminated string'
  } }
];

test('F02: native rejection of truncated polling arguments does not poison later valid polls', () => {
  const rows = [...launch(), ...malformed(), ...poll('wait', '[process still running with process_id proc-a]'), ...poll()];
  assert.doesNotThrow(() => assertChildCommands(rows, options));
  assert.throws(() => assertChildCommands(rows), /poll arguments unreadable/);
  assert.throws(() => assertChildCommands([...launch(), ...malformed()], options), /no terminal response/);
  assert.doesNotThrow(() => assertChildCommands([...launch(), ...poll('other', 'unrelated', 'fatal', 'proc-other'), ...malformed(), ...poll()], options));
});

test('F02: missing, mismatched or contradictory native evidence cannot excuse a malformed poll', () => {
  const variants = [malformed().slice(0, 1)];
  for (const change of [
    { status: 'completed' }, { error_code: 'other' },
    { error_message: 'The model says this tool was not executed' },
    { error_message: malformed()[1].payload.error_message.replace('truncated', 'other') },
    { error_message: malformed()[1].payload.error_message.replace('input_command', 'exec_command') }
  ]) {
    const rows = malformed(); Object.assign(rows[1].payload, change); variants.push(rows);
  }
  variants.push([...malformed(), output('truncated', 'failed', 'fatal')]);
  variants.push([...malformed(), output('truncated', success)]);
  variants.push([malformed()[0], malformed()[0], malformed()[1]]);
  variants.push([malformed()[0], { type: 'event_msg', payload: { type: 'hook' } }, malformed()[1]]);
  variants.push([malformed()[0], { type: 'event_msg', payload: { type: 'request_begin' } }, malformed()[1]]);
  for (const rows of variants) {
    assert.throws(() => assertChildCommands([...launch(), ...rows, ...poll()], options), /poll arguments unreadable/);
  }
});

test('F02: later success cannot hide unknown or executed failed polls', () => {
  assert.throws(() => assertChildCommands([...launch(), call('input_command', 'missing', { process_id: 'proc-a' }), ...poll()], options), /unknown terminal response/);
  assert.throws(() => assertChildCommands([...launch(), ...poll('bad', 'failed', 'fatal'), ...poll()], options), /multiple terminal responses/);
  assert.throws(() => assertChildCommands([...launch(), ...malformed(), ...poll('bad', JSON.stringify({ status: 'failed', exit_code: 1 }), 'fatal')], options), /failed/);
  assert.throws(() => assertChildCommands([...launch(), ...poll(), output('finish', success)], options), /unknown terminal response/);
});

const path = 'E:/QAWorkspaces/run/inputs/source.md';
const failedRead = (cmd = `Get-Content "${path}"`) => [
  call('exec_command', 'shell-read', { cmd }), output('shell-read', 'Read failed', 'fatal')
];
const nativeRead = (file_path = path, stop = 'completed') => [
  call('read_file', 'native-read', { file_path }), output('native-read', 'source content', stop)
];

test('F03: a denied shell read needs no native repair while an executed one fails closed', () => {
  const denied = cmd => [
    call('exec_command', 'shell-read', { cmd }),
    { type: 'event_msg', payload: { type: 'approval_decision', tool_call_id: 'shell-read', decision: 'deny' } },
    output('shell-read', 'Tool call denied by the qa-stage-boundary hook: QA shell redirect: This command was NOT executed.', 'aborted')
  ];
  for (const cmd of [`Get-Content "${path}"`, `Get-Content -LiteralPath "${path}" -Raw`]) {
    assert.doesNotThrow(() => assertChildCommands([...denied(cmd), ...nativeRead()], options));
    assert.doesNotThrow(() => assertChildCommands(denied(cmd), options));
  }
  assert.throws(() => assertChildCommands([...failedRead(), ...nativeRead()], options), /uncontrolled|Child command failed/);
});
test('F03: reading one file cannot resolve listings, searches, multiple targets or unsafe commands', () => {
  for (const cmd of [
    `Get-ChildItem "${path}"`, `Select-String -Path "${path}" -Pattern foo`,
    `Get-Content "${path}", "${path}.other"`, `Get-Content "${path}*"`,
    `Get-Content "${path}"; Remove-Item "${path}"`
  ]) {
    assert.throws(() => assertChildCommands([...failedRead(cmd), ...nativeRead()], options), /not corrected|uncontrolled/);
  }
});

test('F03: native read does not hide unknown reads, failed writes or failed controlled actions', () => {
  const failed = failedRead();
  assert.throws(() => assertChildCommands([failed[0], ...nativeRead()], options), /unknown terminal response/);
  for (const cmd of [`Set-Content "${path}" changed`, 'node scripts/project-action.mjs execute']) {
    assert.throws(() => assertChildCommands([
      ...failedRead(), ...nativeRead(), call('exec_command', 'failed-action', { cmd }),
      output('failed-action', JSON.stringify({ status: 'failed', exit_code: 1 }), 'fatal')
    ], options), /uncontrolled|failed/);
  }
});
// Seen on a live controller session: three calls were refused by the delegation guard, so
// their output is the denial prose and not a receipt. Reading those rows as receipts made
// every later handoff fail with "Child runner response unreadable" and left no action able
// to close it - the refusal itself had to be recognised as "nothing ran".
test('a controller call refused by the delegation guard never becomes an unreadable receipt',()=>{
  const deniedCall=call('exec_command','denied',{cmd:'node scripts/project-action.mjs execute --request=output/action-requests/status-check.json'});
  const deniedOutput=output('denied','Tool call denied by the qa-delegation-guard hook: QA controller boundary: Use one structured command, without shell composition.','aborted');
  const decision={payload:{type:'approval_decision',tool_call_id:'denied',decision:'deny'}};
  assert.doesNotThrow(()=>assertChildCommands([deniedCall,decision,deniedOutput],options));
  // Without the host's own decision row the same wording is just text a command could print.
  assert.throws(()=>assertChildCommands([deniedCall,deniedOutput],options),/unreadable/);
  // A refusal neither delivers nor fails: it cannot stand in for a successful receipt.
  assert.throws(()=>assertChildCommands([deniedCall,decision,deniedOutput],{...options,requireControlledCommands:false,allowRecovery:false}),/unreadable/);
});
// A user interrupt leaves a host placeholder where a receipt belongs. Demanding a receipt
// there made every later handoff fail with "response unreadable", and no action could clear
// it - one interrupt and the run could never advance. Only the exact host strings with an
// aborted status are skipped; a command that prints the same words still needs its receipt.
test('a call the user interrupted is not an unreadable receipt',()=>{
  const interrupted=[call('exec_command','cut',{cmd:'node scripts/project-action.mjs execute --request=output/action-requests/resolve.json'}),
    output('cut','[interrupted: tool aborted by user]','aborted')];
  assert.doesNotThrow(()=>assertChildCommands(interrupted,options));
  const processGone=[call('exec_command','gone',{cmd:'node scripts/project-action.mjs execute'}),
    output('gone','[interrupted: process exited before the tool finished]','aborted')];
  assert.doesNotThrow(()=>assertChildCommands(processGone,options));
  assert.throws(()=>assertChildCommands([call('exec_command','print',{cmd:'node scripts/project-action.mjs execute'}),
    output('print','[interrupted: tool aborted by user]','completed')],options),/unreadable/);
  assert.throws(()=>assertChildCommands(interrupted,{requireControlledCommands:true}),/unreadable/);
});

// A runner_error rejection is the action layer's own infrastructure failure (a harness
// archived-output write race on the live controller), not a correction debt: it files no
// recovery ledger, so nothing could ever clear it and one transient row poisoned every
// later handoff. It stops being evidence only when the child demonstrably recovered.
test('a runner_error rejection is superseded by a later success of the same task, never waved through',()=>{
  const poisoned=JSON.stringify({status:'rejected',exit_code:2,classification:'runner_error',action:'validate_artifacts',
    task_key:'run-abc:validate_artifacts:test_casesd',error:'Archived command output is empty'});
  const recovered=JSON.stringify({status:'completed',exit_code:0,action:'validate_artifacts',
    task_key:'run-abc:validate_artifacts:test_casesd',result:{termination_confirmed:true}});
  const poisonedCall=call('exec_command','poison',{cmd:'node scripts/project-action.mjs execute --request=output/action-requests/v.json'});
  const healedCall=call('exec_command','healed',{cmd:'node scripts/project-action.mjs execute --request=output/action-requests/w.json'});
  assert.doesNotThrow(()=>assertChildCommands([poisonedCall,output('poison',poisoned),healedCall,output('healed',recovered)],options));
  assert.throws(()=>assertChildCommands([poisonedCall,output('poison',poisoned)],options),/failed or was rejected/);
  const otherTask=JSON.stringify({status:'completed',exit_code:0,action:'export_test_cases',
    task_key:'run-abc:export_test_cases:test_casesd',result:{termination_confirmed:true}});
  assert.throws(()=>assertChildCommands([poisonedCall,output('poison',poisoned),healedCall,output('healed',otherTask)],options),/failed or was rejected/);
  const failedRetry=JSON.stringify({status:'completed',exit_code:1,action:'validate_artifacts',
    task_key:'run-abc:validate_artifacts:test_casesd',result:{termination_confirmed:true}});
  assert.throws(()=>assertChildCommands([poisonedCall,output('poison',poisoned),healedCall,output('healed',failedRetry)],options),/failed or was rejected/);
});
// A draft_records correction debt means "the corrected draft must be verified", not "re-file
// the rejected request": the child may legitimately have fixed the draft with native file
// tools, and draft_records output is wholesale-validated afterwards. One successful
// validate_artifacts for the same stage therefore closes the debt; other actions do not.
test('a draft_records debt is closed by a successful stage validation, not by other actions',()=>{
  const debt=JSON.stringify({status:'rejected',exit_code:2,classification:'input_rejected',action:'draft_records',
    task_key:'run-abc:draft_records:test_cases',
    recovery:{category:'input_correction',key:'run-abc:draft_records:test_cases',failure_number:1,retry_allowed:true,policy:'progress_based',stalled:false}});
  const debtCall=call('exec_command','debt',{cmd:'node scripts/project-action.mjs execute --request=output/action-requests/d.json'});
  const validated=JSON.stringify({status:'completed',exit_code:0,action:'validate_artifacts',script:'validate-artifacts.mjs',
    task_key:'run-abc:validate_artifacts:test_cases',action_receipt:'E:/audit/1.json',result:{termination_confirmed:true}});
  const validatedCall=call('exec_command','validated',{cmd:'node scripts/project-action.mjs execute --request=output/action-requests/e.json'});
  const recoveryOptions={...options,verifyRecovery:result=>result.status==='completed'||result.recovery!=null};
  assert.doesNotThrow(()=>assertChildCommands([debtCall,output('debt',debt),validatedCall,output('validated',validated)],recoveryOptions));
  assert.throws(()=>assertChildCommands([debtCall,output('debt',debt)],recoveryOptions),/Still open/);
  const wrongStage=JSON.stringify({...JSON.parse(validated),task_key:'run-abc:validate_artifacts:execution'});
  assert.throws(()=>assertChildCommands([debtCall,output('debt',debt),validatedCall,output('validated',wrongStage)],recoveryOptions),/Still open/);
  const otherAction=JSON.stringify({status:'completed',exit_code:0,action:'export_test_cases',script:'export-test-cases.mjs',
    task_key:'run-abc:export_test_cases:test_cases',action_receipt:'E:/audit/2.json',result:{termination_confirmed:true}});
  assert.throws(()=>assertChildCommands([debtCall,output('debt',debt),validatedCall,output('validated',otherAction)],recoveryOptions),/Still open/);
});
// A diagnose debt is the same evidence shape: diagnose_* only inspects, persists nothing, and
// its success can be structurally impossible mid-stage (diagnose_task:execution is gated on
// browser artifacts that only exist after the grant and a real run). One successful
// validate_artifacts for the same stage proves the inspected artifacts; other actions or a
// different stage do not.
test('a diagnose debt is closed by a successful stage validation, not by other actions',()=>{
  const debt=JSON.stringify({status:'rejected',exit_code:2,classification:'input_rejected',action:'diagnose_task',
    task_key:'run-abc:diagnose_task:execution',
    recovery:{category:'input_correction',key:'run-abc:diagnose_task:execution',failure_number:1,retry_allowed:true,policy:'progress_based',stalled:false}});
  const debtCall=call('exec_command','debt',{cmd:'node scripts/project-action.mjs execute --request=output/action-requests/d.json'});
  const validated=JSON.stringify({status:'completed',exit_code:0,action:'validate_artifacts',script:'validate-artifacts.mjs',
    task_key:'run-abc:validate_artifacts:execution',action_receipt:'E:/audit/3.json',result:{termination_confirmed:true}});
  const validatedCall=call('exec_command','validated',{cmd:'node scripts/project-action.mjs execute --request=output/action-requests/e.json'});
  const recoveryOptions={...options,verifyRecovery:result=>result.status==='completed'||result.recovery!=null};
  assert.doesNotThrow(()=>assertChildCommands([debtCall,output('debt',debt),validatedCall,output('validated',validated)],recoveryOptions));
  assert.throws(()=>assertChildCommands([debtCall,output('debt',debt)],recoveryOptions),/Still open/);
  const wrongStage=JSON.stringify({...JSON.parse(validated),task_key:'run-abc:validate_artifacts:test_cases'});
  assert.throws(()=>assertChildCommands([debtCall,output('debt',debt),validatedCall,output('validated',wrongStage)],recoveryOptions),/Still open/);
  const otherAction=JSON.stringify({status:'completed',exit_code:0,action:'export_test_cases',script:'export-test-cases.mjs',
    task_key:'run-abc:export_test_cases:execution',action_receipt:'E:/audit/4.json',result:{termination_confirmed:true}});
  assert.throws(()=>assertChildCommands([debtCall,output('debt',debt),validatedCall,output('validated',otherAction)],recoveryOptions),/Still open/);
});

test('a stage-less success clears only the child session\'s own stage debt',()=>{
  const debt=JSON.stringify({status:'rejected',exit_code:2,classification:'input_rejected',action:'draft_records',
    task_key:'run-abc:draft_records:test_cases',
    recovery:{category:'input_correction',key:'run-abc:draft_records:test_cases',failure_number:1,retry_allowed:true,policy:'progress_based',stalled:false}});
  const debtCall=call('exec_command','debt',{cmd:'node scripts/project-action.mjs execute --request=output/action-requests/d.json'});
  const unscoped=JSON.stringify({status:'completed',exit_code:0,action:'draft_records',script:'draft-records.mjs',
    task_key:'run-abc:draft_records:',action_receipt:'E:/audit/1.json',result:{termination_confirmed:true}});
  const clearCall=call('exec_command','clear',{cmd:'node scripts/project-action.mjs execute --request=output/action-requests/c.json'});
  const recoveryOptions={...options,verifyRecovery:result=>result.status==='completed'||result.recovery!=null};
  const rows=[debtCall,output('debt',debt),clearCall,output('clear',unscoped)];
  assert.doesNotThrow(()=>assertChildCommands(rows,{...recoveryOptions,stageWriteBoundary:{stage:'test_cases'}}));
  assert.throws(()=>assertChildCommands(rows,{...recoveryOptions,stageWriteBoundary:{stage:'analysis'}}),/Still open/);
});

test('a read-only catalog failure after a verified delivery does not block the handoff',()=>{
  const delivered=JSON.stringify({status:'completed',exit_code:0,action:'validate_artifacts',script:'validate-artifacts.mjs',
    task_key:'run-abc:validate_artifacts:analysis',action_receipt:'E:/audit/1.json',result:{termination_confirmed:true}});
  const deliveryCall=call('exec_command','deliver',{cmd:'node scripts/project-action.mjs execute --request=output/action-requests/v.json'});
  const lookup=call('exec_command','catalog',{cmd:'node scripts/project-action.mjs catalog'});
  const missing="Error: Cannot find module 'project-action.mjs'\n at Module.executeUserEntryPoint (run_main:1)\n code: 'MODULE_NOT_FOUND', requireStack: []\n[exit code: 1]";
  const recoveryOptions={...options,verifyRecovery:result=>result.status==='completed'||result.recovery!=null};
  assert.doesNotThrow(()=>assertChildCommands([deliveryCall,output('deliver',delivered),lookup,output('catalog',missing)],recoveryOptions));
  assert.throws(()=>assertChildCommands([lookup,output('catalog',missing)],recoveryOptions),/catalog lookup failure/);
});
