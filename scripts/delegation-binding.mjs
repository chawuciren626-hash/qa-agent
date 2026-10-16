import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { dataPath, directoryContext } from './directory-context.mjs';
import { assertUnlinked } from './skill-resources.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
function parameterHash(args) {
  const keys = ['agent_id', 'description', 'prompt'];
  if (!args || Object.keys(args).length !== keys.length || keys.some(key => typeof args[key] !== 'string' || !args[key])) {
    throw new Error('Use the complete registered delegation object, without extra arguments');
  }
  return hash(JSON.stringify(keys.map(key => args[key])));
}
function bytes(root, path) {
  const absolute = dataPath(root, path);
  assertUnlinked(directoryContext(root).session_root, absolute);
  return readFileSync(absolute);
}

export function captureDelegationBinding(root, dispatchId, delegation, { contract = false, evidence = false } = {}) {
  if (!/^[A-Za-z0-9-]+$/.test(dispatchId)) throw new Error('Invalid dispatch identity');
  const paths = [`output/delegations/${dispatchId}.json`];
  if (contract) paths.push(`output/delegations/${dispatchId}.prompt.txt`);
  if (evidence) paths.push(`output/delegations/${dispatchId}.evidence.json`);
  return { version: 1, parameters_sha256: parameterHash(delegation),
    files: paths.map(path => ({ path, sha256: hash(bytes(root, path)) })) };
}

export function verifyDelegationBinding(root, { session, runId, stage, dispatchId, args }) {
  const dir = dataPath(root, 'output/action-audit', session);
  assertUnlinked(directoryContext(root).session_root, dir);
  if (!existsSync(dir)) throw new Error('Registered dispatch receipt unavailable; no child was launched');
  const records = [];
  for (const name of readdirSync(dir).filter(name => name.endsWith('.json'))) {
    const path = relative(directoryContext(root).session_root, resolve(dir, name));
    const receipt = JSON.parse(bytes(root, path));
    if (receipt.action === 'dispatch' && receipt.dispatch_id === dispatchId) records.push(receipt);
  }
  if (records.length !== 1) throw new Error('Expected one registered dispatch receipt; no child was launched');
  const receipt = records[0], binding = receipt.delegation_binding;
  if (receipt.status !== 'completed' || receipt.exit_code !== 0 || receipt.session_id !== session || receipt.run_id !== runId || receipt.stage !== stage) {
    throw new Error('Dispatch receipt is incomplete or belongs to another task');
  }
  // Unbound historical work is not silently promoted to a new launch authorization.
  if (binding?.version !== 1 || !Array.isArray(binding.files)) throw new Error('Historical dispatch has no content binding; do not launch or recreate the task to bypass it');
  if (parameterHash(receipt.delegation) !== binding.parameters_sha256) throw new Error('Registered delegation receipt changed');
  const {yield_time_ms:yieldTime,...authorityArgs}=args ?? {};
  if(yieldTime!==undefined && (!Number.isFinite(yieldTime) || yieldTime<250 || yieldTime>600000)) throw new Error('Invalid delegation yield_time_ms; expected 250..600000 milliseconds');
  parameterHash(authorityArgs); // No extra execution/model options are accepted.
  // Display wording is not delegated authority. Keep the original receipt hash intact.
  if (parameterHash({...authorityArgs,description:receipt.delegation.description}) !== binding.parameters_sha256) throw new Error('Delegation arguments differ from registration. Copy the registered agent_id and prompt unchanged; only the display description may be reworded. Do not redispatch or ask the user to unlock');
  const prefix = `output/delegations/${dispatchId}`;
  const allowed = new Set([`${prefix}.json`, `${prefix}.prompt.txt`, `${prefix}.evidence.json`]);
  const seen = new Set();
  for (const file of binding.files) {
    if (!allowed.has(file.path) || seen.has(file.path) || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error('Invalid bound delegation resource');
    seen.add(file.path);
    if (hash(bytes(root, file.path)) !== file.sha256) throw new Error('Bound delegation resource changed; no child was launched. Preserve evidence and report the engineering fault, not a user approval request');
  }
  if (!seen.has(`${prefix}.json`) || (args.prompt.includes('INDEPENDENT TASK CONTRACT') && !seen.has(`${prefix}.prompt.txt`))) throw new Error('Incomplete delegation resource binding');
  return binding;
}
