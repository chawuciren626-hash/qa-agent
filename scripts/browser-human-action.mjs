import { existsSync, readdirSync, readFileSync, realpathSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { readRunFile } from './design-quality.mjs';
import { readSession, findParentDispatch } from './stage-evidence.mjs';
import { writeJson } from './orchestration-state.mjs';
import { inspectApiHumanAction } from './api-human-action.mjs';

const agents = () => process.env.PENGUIN_AGENT_ROOT ?? resolve(homedir(), '.penguin/data/default_project/agents');
const uuid = value => /^[a-f0-9-]{36}$/.test(value ?? '');
const read = (dir, file) => JSON.parse(readRunFile(dir, file).data);
const receiptPath = id => `audit/human-actions/${id}.json`;
const pending = new Map();
export const humanConfirmationText = (id, decision) => `人工操作${decision === 'cancel' ? '取消' : '确认完成'}：${id}`;
export const isLoginConfirmation = text => /^(?:已登录|登录完成|已完成登录|登录已完成|已登录完成|验证码已完成|已完成验证|验证完成)(?:[，,、\s]*(?:请)?继续(?:测试|执行)?)?[。.!！\s]*$/u.test(String(text).trim());

// Bind the card to the original native child, never an ID inferred from a dispatch.
export function inspectHumanAction(workspace, parent, runId, agentRoot = agents(), actionId) {
  if (!/^run-[A-Za-z0-9-]+$/.test(runId)) throw Error('Invalid run');
  const dir = resolve(workspace, 'output/runs', runId);
  if (realpathSync(dir) !== dir) throw Error('Redirected run');
  const api=inspectApiHumanAction(workspace,parent,runId,agentRoot);
  if(api && (!actionId || api.action_id===actionId)) return api;
  const manifest = read(dir, 'manifest.json'), state = read(dir, 'execution/browser-state.json');
  const dispatch = manifest.orchestration?.events?.filter(e => e.type === 'dispatched' && e.stage === 'execution').at(-1);
  if (manifest.stages?.execution?.status !== 'in_progress' || state.status !== 'waiting_human' || state.human_protocol !== 1 ||
      !uuid(state.waiting_command_id) || dispatch?.dispatch_id !== state.dispatch_id || dispatch?.['parent-session-id'] !== parent) return null;
  const command = read(dir, `audit/commands/${state.waiting_command_id}/command.json`);
  const result = read(dir, `audit/commands/${state.waiting_command_id}/command.log`);
  if (command.script !== 'browser-task.mjs' || command.run_id !== runId || command.status !== 'completed' || command.result?.termination_confirmed !== true ||
      result.status !== 'waiting_human' || result.question !== state.question) return null;
  const child = command.host_binding?.session_id;
  if (!child) return null;
  const parentRows = readSession(agentRoot, 'test_agent', parent);
  const meta = parentRows.find(r => r.type === 'session_meta')?.payload;
  if (meta?.session_id !== parent || resolve(meta.workspace ?? '') !== resolve(workspace)) throw Error('Parent workspace mismatch');
  if (!findParentDispatch(parentRows, { runId, agent: dispatch.agent, childId: child, dispatchedAt: dispatch.at,
    dispatchId: dispatch.dispatch_id, commandPolicy: dispatch.child_command_policy, parallel: manifest.orchestration?.plan?.workflow_mode === 'task' })) return null;
  const childMeta = readSession(agentRoot, dispatch.agent, child).find(r => r.type === 'session_meta')?.payload;
  if (childMeta?.session_id !== child || childMeta.source !== 'subagent' || resolve(childMeta.workspace ?? '') !== resolve(workspace)) throw Error('Child workspace mismatch');
  const receipt = existsSync(resolve(dir, receiptPath(state.waiting_command_id))) ? read(dir, receiptPath(state.waiting_command_id)) : null;
  return { run_id: runId, action_id: state.waiting_command_id, dispatch_id: state.dispatch_id, child_session: child,
    agent: dispatch.agent, question: state.question, kind: state.human_kind, waiting_at: state.waiting_at,
    status: receipt?.status ?? 'waiting_human', decision: receipt?.decision ?? null };
}

export function listHumanActions(workspace, parent, agentRoot = agents()) {
  if (!workspace) return [];
  const runs = resolve(workspace, 'output/runs');
  if (!existsSync(runs) || realpathSync(runs) !== runs) return [];
  return readdirSync(runs, { withFileTypes: true }).filter(e => e.isDirectory() && /^run-[A-Za-z0-9-]+$/.test(e.name)).flatMap(e => {
    const actions=[];
    try {const api=inspectApiHumanAction(workspace,parent,e.name,agentRoot);if(api)actions.push(api);}catch{}
    try {const browser=inspectHumanAction(workspace,parent,e.name,agentRoot,'browser');if(browser)actions.push(browser);}catch{}
    return actions;
  });
}

export async function answerHumanAction({ workspace, parent, runId, actionId, decision, send, agentRoot = agents(), health = checkWorker }) {
  if (!uuid(actionId) || !['continue', 'cancel', 'wait'].includes(decision)) throw Error('Invalid human action');
  const key = `${workspace}:${runId}:${actionId}`;
  if (pending.has(key)) return pending.get(key);
  const operation = (async () => {
    const action = inspectHumanAction(workspace, parent, runId, agentRoot, actionId);
    if (!action || action.action_id !== actionId) throw Error('This human action has expired; refresh the task.');
    if (decision === 'wait') return { status: action.status, changed: false };
    if (action.status !== 'waiting_human' && action.status !== 'not_sent') return { status: action.status, changed: false };
    const dir = resolve(workspace, 'output/runs', runId);
    if(action.channel!=='api') await health(dir);
    else if(decision==='cancel') writeJson(resolve(dir,'execution/api/cancel.json'),{action_id:actionId,at:new Date().toISOString()});
    const file = resolve(dir, receiptPath(actionId));
    mkdirSync(resolve(file, '..'), { recursive: true });
    const receipt = { version: 1, run_id: runId, parent_session: parent, child_session: action.child_session, dispatch_id: action.dispatch_id,
      action_id: actionId, decision, status: 'sending', created_at: new Date().toISOString() };
    const save = () => writeJson(file, receipt);
    save();
    try {
      const outcome = await send(action.child_session, humanConfirmationText(actionId, decision), decision, action.channel ?? 'browser');
      if (!['started', 'steered', 'resumed'].includes(outcome)) {
        receipt.status = 'not_sent'; save();
        throw Error('The original child could not resume; no new task or product operation was started.');
      }
      receipt.status = 'accepted'; receipt.outcome = outcome; save();
      return { status: 'accepted', changed: true, child_session: action.child_session };
    } catch (error) {
      // Transport uncertainty must never resend a possibly accepted continuation.
      if (receipt.status === 'sending') { receipt.status = 'delivery_unknown'; save(); }
      throw error;
    }
  })();
  pending.set(key, operation);
  try { return await operation; } finally { pending.delete(key); }
}

async function checkWorker(dir) {
  const connection = read(dir, 'execution/browser-private.json');
  const response = await fetch(`http://127.0.0.1:${connection.port}/health`, { method: 'POST',
    headers: { authorization: `Bearer ${connection.token}`, 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(4000) });
  const state = response.ok ? await response.json() : null;
  if (!state || state.browser_state !== 'waiting_human' || !state.browser_connected || state.page_closed || state.closed || state.busy) throw Error('Original browser is unavailable; no new browser was opened.');
}

// The worker consumes a real native user message, not model text or a file claiming approval.
export function nativeHumanDecision(dir, state, commandId, agentRoot = agents()) {
  if (state.human_protocol !== 1 || !uuid(state.waiting_command_id)) return null;
  try {
    const receipt = read(dir, receiptPath(state.waiting_command_id));
    const command = read(dir, `audit/commands/${commandId}/command.json`);
    const manifest = read(dir, 'manifest.json');
    const dispatch = manifest.orchestration.events.filter(e => e.type === 'dispatched' && e.stage === 'execution').at(-1);
    if (!['sending', 'accepted', 'delivery_unknown'].includes(receipt.status) || !['continue','cancel'].includes(receipt.decision) ||
        receipt.action_id !== state.waiting_command_id || receipt.dispatch_id !== state.dispatch_id || receipt.run_id !== manifest.run_id ||
        receipt.parent_session !== dispatch['parent-session-id'] || dispatch.dispatch_id !== state.dispatch_id || command.host_binding?.session_id !== receipt.child_session) return null;
    const rows = readSession(agentRoot, dispatch.agent, receipt.child_session);
    const message = rows.filter(r => r.type === 'model_msg' && r.payload?.type === 'text' && r.payload.role === 'user' && !r.payload.sender).at(-1);
    if (message?.payload.text !== humanConfirmationText(state.waiting_command_id, receipt.decision) || Date.parse(message.timestamp) <= Date.parse(state.waiting_at)) return null;
    return { decision: receipt.decision, action_id: state.waiting_command_id, confirmed_at: message.timestamp };
  } catch { return null; }
}
