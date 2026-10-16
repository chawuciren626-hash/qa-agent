import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { dataPath } from './directory-context.mjs';
import { readRunFile } from './design-quality.mjs';

const safeActions = new Set(['read_source', 'run_status', 'prepare_execution_plan', 'validate_execution_prepare', 'validate_artifacts']);
const safeScripts = new Set(['select-test-cases.mjs', 'create-execution-plan.mjs', 'validate-artifacts.mjs', 'show-run-status.mjs', 'record-orchestration-event.mjs']);
const assert = (ok, message) => { if (!ok) throw new Error(message); };
const controlledAction = cmd => /^node(?:\.exe)?\s+(?:scripts\/)?project-action\.mjs\s+(?:catalog|execute)(?:\s|$)/.test(cmd ?? '') && !/[;&|><`\r\n]|\$\(/.test(cmd);

// Absence of results alone is not proof that no product operation occurred.
// Require terminal native tool outputs and matching engine-owned action receipts.
export function inspectPreparationSafety(root, dir, runId, parentId, dispatch, child, parent = []) {
  assert(dispatch.mode === 'prepare', 'Only preparation-only dispatches can recover automatically');
  for(const row of parent) {
    if(row.payload?.type!=='tool_call' || Date.parse(row.timestamp)<Date.parse(dispatch.at)) continue;
    const call=row.payload;
    assert(['run_subagent','read_file','write_file','edit_file','apply_patch','exec_command'].includes(call.name), 'Parent tool may have product effects; no automatic preparation recovery');
    if(call.name==='exec_command') {
      const args=typeof call.arguments==='string'?JSON.parse(call.arguments):call.arguments;
      assert(controlledAction(args?.cmd), 'Parent command bypassed controlled actions; effects require inspection');
    }
  }
  for (const path of ['execution/browser-state.json', 'execution/browser-private.json', 'execution/browser-evidence', 'execution/exploration.json', 'execution/exploration.lock', 'execution/execution-state.json', 'execution/execution.lock.json', 'execution/attempts', 'execution/test_results.json']) {
    assert(!existsSync(resolve(dir, path)), `Product execution evidence exists: ${path}; no automatic preparation recovery`);
  }
  const receipts = [];
  for (const [index, row] of child.entries()) {
    if (row.payload?.type !== 'tool_call') continue;
    const call = row.payload;
    assert(['read_file', 'write_file', 'edit_file', 'apply_patch', 'exec_command'].includes(call.name), `Unclassified tool ${call.name}; product effects are unknown`);
    const outputs = child.slice(index + 1).filter(item => item.payload?.type === 'tool_call_output' && item.payload.tool_call_id === call.tool_call_id);
    assert(outputs.length === 1, 'Preparation tool has no unique terminal response');
    const output = outputs[0].payload;
    if (output.stop_reason === 'aborted') {
      const denied = child.slice(index + 1, child.indexOf(outputs[0])).some(item => item.type === 'event_msg' && item.payload?.type === 'approval_decision' && item.payload.tool_call_id === call.tool_call_id && item.payload.decision === 'deny');
      assert(denied && String(output.output).startsWith('Tool call denied by the qa-stage-boundary hook:'), 'Unverified tool interruption');
      continue;
    }
    if (call.name !== 'exec_command') {
      assert(output.stop_reason === 'completed', 'Preparation file operation outcome is unknown');
      continue;
    }
    const args = typeof call.arguments === 'string' ? JSON.parse(call.arguments) : call.arguments;
    assert(controlledAction(args?.cmd), 'Preparation command must use the controlled action entry');
    const raw = String(output.output);
    const result = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
    if (/\s+catalog\s*$/.test(args.cmd)) {
      assert(result.status === 'help' && output.stop_reason === 'completed', 'Catalog lookup did not finish');
      continue;
    }
    const base = dataPath(root, 'output/action-audit', parentId);
    assert(typeof result.action_receipt === 'string' && resolve(result.action_receipt, '..') === base, 'Missing preparation action receipt');
    const record = JSON.parse(readRunFile(base, result.action_receipt.slice(base.length + 1)).data);
    assert(record.session_id === parentId && record.run_id === runId && Date.parse(record.at) >= Date.parse(dispatch.at), 'Preparation receipt belongs to another dispatch');
    assert(safeActions.has(record.action) && (result.action === undefined || record.action === result.action) && result.run_id === runId && record.status === result.status && record.exit_code === result.exit_code, 'Action may have product effects or receipt differs');
    assert((record.command_evidence ?? null) === (result.evidence_dir ?? null), 'Preparation command evidence differs from its action receipt');
    assert(['completed', 'failed', 'rejected'].includes(record.status), 'Preparation action outcome unknown');
    if (result.status === 'failed') assert(result.result?.termination_confirmed === true, 'Preparation process termination unknown');
    receipts.push(result.action_receipt);
  }
  const commands = resolve(dir, 'audit/commands');
  if (existsSync(commands)) for (const entry of readdirSync(commands, { withFileTypes: true })) {
    assert(entry.isDirectory() && !entry.isSymbolicLink(), 'Unexpected command audit entry');
    const record = JSON.parse(readRunFile(dir, `audit/commands/${entry.name}/command.json`).data);
    assert(Number.isFinite(Date.parse(record.started_at)), 'Command timestamp is unknown');
    if (Date.parse(record.started_at) < Date.parse(dispatch.at)) continue;
    assert(record.run_id === runId && safeScripts.has(record.script), 'Command may have operated on the product');
    assert(['completed', 'failed'].includes(record.status) && record.result?.termination_confirmed === true, 'Command termination is unknown');
  }
  return { kind: 'verified_preparation_only', dispatch_id: dispatch.dispatch_id, action_receipts: receipts, product_execution_observed: false, approval_granted: false };
}

export function preparationDraftFiles(dir) {
  const files = ['execution/execution-plan.json', 'selection/test-selection.json'];
  const walk = path => {
    if (!existsSync(resolve(dir, path))) return;
    for (const entry of readdirSync(resolve(dir, path), { withFileTypes: true })) {
      assert(!entry.isSymbolicLink(), 'Preparation draft directory is redirected');
      const child = `${path}/${entry.name}`;
      if (entry.isDirectory()) walk(child);
      else { assert(entry.isFile(), 'Unknown preparation draft entry'); files.push(child); }
    }
  };
  walk('execution/scripts');
  walk('environment');
  return files;
}
