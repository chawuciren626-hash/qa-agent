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

test('F03: same-path native read resolves historical single-file Shell read failure', () => {
  for (const cmd of [`Get-Content "${path}"`, `Get-Content -LiteralPath "${path}" -Raw`, `Get-Content -Path "${path}" -TotalCount 20 -Encoding UTF8`]) {
    const rows = [...failedRead(cmd), ...nativeRead('e:\\qaworkspaces\\run\\inputs\\SOURCE.md')];
    assert.doesNotThrow(() => assertChildCommands(rows, options));
    assert.doesNotThrow(() => assertChildCommands(rows, { ...options, allowUnresolvedRecovery: true }));
    assert.throws(() => assertChildCommands(rows), /Child command failed/);
  }
  const missingTool = failedRead();
  missingTool[1].payload.output = '/usr/bin/sh: Get-Content: command not found';
  assert.doesNotThrow(() => assertChildCommands([...missingTool, ...nativeRead()], options));
  assert.throws(() => assertChildCommands(missingTool, options), /not corrected/);
});

test('F03: native recovery requires unique successful evidence for the same file after the failure', () => {
  const duplicateCall = nativeRead(); duplicateCall.splice(1, 0, duplicateCall[0]);
  const duplicateOutput = nativeRead(); duplicateOutput.push(duplicateOutput[1]);
  const invalidArgs = nativeRead(); invalidArgs[0].payload.arguments = '{broken';
  const noId = nativeRead(); noId.forEach(row => delete row.payload.tool_call_id);
  for (const rows of [
    nativeRead(path + '.other'), nativeRead(path, 'fatal'), nativeRead(path, 'aborted'),
    nativeRead(path, 'interrupted'), nativeRead().slice(0, 1), duplicateCall, duplicateOutput, invalidArgs, noId
  ]) {
    for (const allowUnresolvedRecovery of [false, true]) {
      assert.throws(() => assertChildCommands([...failedRead(), ...rows], { ...options, allowUnresolvedRecovery }), /not corrected/);
    }
  }
  assert.throws(() => assertChildCommands([...nativeRead(), ...failedRead()], options), /not corrected/);
  const failed = failedRead(), read = nativeRead();
  assert.throws(() => assertChildCommands([failed[0], read[0], failed[1], read[1]], options), /not corrected/);
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
