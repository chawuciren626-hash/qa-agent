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
  assert.throws(()=>assertChildCommands(recovered.slice(0,2),options),/not corrected/);
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
