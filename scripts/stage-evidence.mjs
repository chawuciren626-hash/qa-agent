import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { readRunFile, runDirectory } from './design-quality.mjs';
import { requiredArtifacts } from './artifact-contracts.mjs';
import { assertChildCommands, childCommandPolicy } from './child-command-policy.mjs';
export { requiredArtifacts } from './artifact-contracts.mjs';

export function readSession(agentRoot, agent, id) {
  const match = /^session-(\d{4}-\d{2}-\d{2})-\d{2}-\d{2}-\d{2}-[a-f0-9]+$/.exec(id ?? '');
  if (!match || !/^[a-z0-9_-]+$/.test(agent)) throw new Error('Valid agent and session ID required');
  const dir = resolve(agentRoot, agent, 'traces', match[1]);
  const files = readdirSync(dir).filter(name => name.startsWith(`${id}_`) && name.endsWith('.jsonl')).sort();
  if (!files.length) throw new Error('PenguinHarness session trace missing');
  return files.flatMap(name => readFileSync(resolve(dir, name), 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)));
}

export function assertParentSession(root, runId, id, agentRoot = process.env.PENGUIN_AGENT_ROOT ?? resolve(homedir(), '.penguin/data/default_project/agents')) {
  const rows = readSession(agentRoot, 'test_agent', id);
  const meta = rows.find(row => row.type === 'session_meta')?.payload;
  if (meta?.session_id !== id || resolve(meta.agent_state ?? '') !== resolve(agentRoot, 'test_agent/agent_state') || ![resolve(root), runDirectory(root, runId)].includes(resolve(meta.workspace ?? ''))) throw new Error('Parent session identity or workspace mismatch');
  return rows;
}

export function findParentDispatch(parent, { runId, agent, childId, dispatchedAt, dispatchId, commandPolicy }) {
  const calls = [];
  for (const [index, row] of parent.entries()) {
    if (row.type !== 'model_msg' || row.payload?.type !== 'tool_call' || row.payload.name !== 'run_subagent') continue;
    const outputs = parent.map((output, position) => ({ output, position })).filter(({ output, position }) => position > index && output.type === 'model_msg' && output.payload?.type === 'tool_call_output' && output.payload.tool_call_id === row.payload.tool_call_id);
    // A trace event without a tool-call ID can only be bound to one active invocation.
    calls.push({ row, index, outputs, end: outputs[0]?.position ?? parent.length });
  }
  const events = parent.map((row, index) => ({ row, index })).filter(({ row }) => row.type === 'event_msg' && row.payload?.type === 'subagent' && row.payload.session_id === childId);
  if (events.length !== 1) return null;
  const event = events[0];
  const active = calls.filter(call => call.index < event.index && event.index < call.end);
  if (active.length !== 1) return null;
  const call = active[0];
  if (call.outputs.length !== 1 || call.outputs[0].output.payload.stop_reason === 'fatal') return null;
  let args;
  try { args = typeof call.row.payload.arguments === 'string' ? JSON.parse(call.row.payload.arguments) : call.row.payload.arguments; } catch { return null; }
  if (args?.agent_id !== agent || typeof args.prompt !== 'string' || !args.prompt.split(/[^A-Za-z0-9-]+/).includes(runId)) return null;
  if (dispatchId && !args.prompt.split(/[^A-Za-z0-9-]+/).includes(dispatchId)) return null;
  if (commandPolicy && !args.prompt.includes(commandPolicy)) return null;
  const times = [dispatchedAt, call.row.timestamp, event.row.timestamp, call.outputs[0].output.timestamp].map(Date.parse);
  if (times.some(time => !Number.isFinite(time)) || times.some((time, i) => i > 0 && time < times[i - 1])) return null;
  return { tool_call_id: call.row.payload.tool_call_id, binding: 'unique_active_call_subagent_event', subagent_event_at: event.row.timestamp };
}

export function verifyStageEvidence(root, runId, manifest, options, agentRoot = process.env.PENGUIN_AGENT_ROOT ?? resolve(homedir(), '.penguin/data/default_project/agents')) {
  const dispatch = manifest.orchestration.events.filter(e => e.stage === options.stage && e.type === 'dispatched').at(-1);
  if (!dispatch) throw new Error('Dispatch event required');
  const childId = options['session-id'];
  const parentId = options['parent-session-id'];
  if (dispatch.dispatch_id && (options['dispatch-id'] !== dispatch.dispatch_id || parentId !== dispatch['parent-session-id'])) throw new Error('Completion does not belong to the current dispatch');
  const child = readSession(agentRoot, dispatch.agent, childId);
  const parent = readSession(agentRoot, 'test_agent', parentId);
  if (dispatch.dispatch_id) {
    const matchingCalls = parent.filter(row => {
      if (row.payload?.type !== 'tool_call' || row.payload.name !== 'run_subagent' || Date.parse(row.timestamp) < Date.parse(dispatch.at)) return false;
      let args;
      try { args = typeof row.payload.arguments === 'string' ? JSON.parse(row.payload.arguments) : row.payload.arguments; } catch { return false; }
      return args?.agent_id === dispatch.agent && String(args.prompt).split(/[^A-Za-z0-9-]+/).includes(runId);
    });
    if (matchingCalls.length !== 1) throw new Error('Dispatch must bind exactly one child call; retries need failure and explicit recovery');
  }
  const meta = child.find(row => row.type === 'session_meta');
  if (meta?.payload.session_id !== childId || meta.payload.source !== 'subagent' || resolve(meta.payload.agent_state) !== resolve(agentRoot, dispatch.agent, 'agent_state')) throw new Error('Wrong child agent or session source');
  if (resolve(meta.payload.workspace) !== resolve(root) && resolve(meta.payload.workspace) !== runDirectory(root, runId)) throw new Error('Child workspace mismatch');
  if (dispatch.child_command_policy && dispatch.child_command_policy !== childCommandPolicy(dispatch.dispatch_id)) throw new Error('Dispatch command policy differs from supported contract');
  const called = findParentDispatch(parent, { runId, agent: dispatch.agent, childId, dispatchedAt: dispatch.at, dispatchId: dispatch.dispatch_id, commandPolicy: dispatch.child_command_policy });
  if (!called) throw new Error('No matching parent dispatch response for this run');
  if (dispatch.child_command_policy) {
    if (!child.some(row => row.payload?.type === 'text' && row.payload.role === 'user' && row.payload.text?.includes(dispatch.child_command_policy))) throw new Error('Child did not receive the dispatch stop policy');
    assertChildCommands(child);
  }
  if (!child.some(row => row.payload?.type === 'text' && row.payload.role === 'user' && row.payload.text?.includes(runId))) throw new Error('Child task does not reference current run');
  const lastMessage = child.filter(row => row.type === 'model_msg' && row.payload?.role === 'assistant').at(-1);
  if (lastMessage?.payload.type !== 'text' || !lastMessage.payload.text?.trim() || Date.parse(lastMessage.timestamp) < Date.parse(dispatch.at)) throw new Error('Child has no completed response after dispatch');
  const lastRequest = child.filter(row => row.type === 'event_msg' && ['request_begin', 'request_end'].includes(row.payload?.type)).at(-1);
  if (lastRequest?.payload.type !== 'request_end' || lastRequest.payload.status !== 'completed') throw new Error('Child request is not complete');
  if (manifest.orchestration.events.some(e => e.evidence?.session_id === childId)) throw new Error('Child session already used to complete a stage');
  const artifacts = (options.artifacts ?? '').split(',').filter(Boolean);
  const preparation = options.stage === 'execution' && dispatch.mode === 'prepare';
  const required = preparation ? ['execution/execution-plan.json'] : requiredArtifacts[options.stage] ?? [];
  if (!required.length || required.some(path => !artifacts.includes(path))) throw new Error('Required stage artifacts missing from completion');
  if (preparation && !artifacts.some(path => /\.(spec|test)\.[cm]?[jt]sx?$/.test(path))) throw new Error('Preparation must return generated test scripts');
  const hashes = artifacts.map(path => {
    const file = readRunFile(runDirectory(root, runId), path);
    return { path: file.path, sha256: file.sha256 };
  });
  return { verified_at: new Date().toISOString(), parent_session_id: parentId, session_id: childId, dispatch_binding: called, artifacts: hashes };
}
