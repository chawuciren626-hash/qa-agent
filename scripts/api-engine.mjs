import { request as playwrightRequest } from '@playwright/test';
import Ajv from 'ajv';
import { isDeepStrictEqual } from 'node:util';
import { apiHash } from './api-contract.mjs';
import { readFileSync } from 'node:fs';

const validatePlanSchema=new Ajv({allErrors:true,strict:true}).compile(JSON.parse(readFileSync(new URL('../schemas/api_plan.schema.json',import.meta.url),'utf8')));

const id = v => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(v);
const sensitive = /authorization|cookie|token|password|secret|signature|api.?key/i;
const safeMethods = ['GET', 'HEAD', 'OPTIONS'];
const mediaTypePattern = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/i;
const mediaType = value => {
  const type = value.split(';', 1)[0].trim().toLowerCase();
  return mediaTypePattern.test(type) ? type : null;
};
const requireValue = (ok, message) => { if (!ok) throw new Error(message); };
export function apiField(value, path) {
  if (!path) return value;
  return path.split('.').reduce((v, k) => v != null && Object.hasOwn(Object(v), k) && !['__proto__', 'constructor', 'prototype'].includes(k) ? v[k] : undefined, value);
}
export function apiTarget(raw, scope) {
  const url = new URL(raw);
  requireValue(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.hash, 'Invalid API URL');
  requireValue(![...url.searchParams.keys()].some(k=>sensitive.test(k)), 'Sensitive query values must use the authentication reference channel');
  requireValue(!['169.254.169.254', 'metadata.google.internal', '[fd00:ec2::254]'].includes(url.hostname.toLowerCase()), 'Metadata service is outside API scope');
  requireValue(scope.some(s => new URL(s.url).origin === url.origin && (url.pathname === new URL(s.url).pathname || url.pathname.startsWith(new URL(s.url).pathname.endsWith('/') ? new URL(s.url).pathname : `${new URL(s.url).pathname}/`))), 'API target outside current task scope');
  return url;
}
export function validateApiCases(plan) {
  requireValue(validatePlanSchema(plan),'API plan schema rejected: '+(validatePlanSchema.errors??[]).map(e=>`${e.instancePath} ${e.keyword}`).join('; '));
  requireValue(plan?.version === 1 && Array.isArray(plan.scenarios) && plan.scenarios.length > 0 && plan.scenarios.length <= 100, 'Expected API cases version=1 and 1..100 scenarios');
  requireValue(Array.isArray(plan.scope) && plan.scope.length > 0 && plan.scope.length <= 10, 'Explicit API target scope required');
  plan.scope.forEach(s => { apiTarget(s.url, [s]); requireValue(typeof s.source_path === 'string' && typeof s.quote === 'string' && s.quote.length > 0, 'Scope must cite task input'); });
  const scenarios = new Set(), requests = new Set();
  for (const scenario of plan.scenarios) {
    requireValue(id(scenario.scenario_id) && !scenarios.has(scenario.scenario_id) && typeof scenario.case_id === 'string' && scenario.case_id.length > 0, 'Unique scenario and source case IDs required');
    scenarios.add(scenario.scenario_id);
    requireValue(typeof scenario.expected === 'string' && scenario.expected.trim() && Array.isArray(scenario.steps) && scenario.steps.length > 0 && scenario.steps.length <= 30, 'Design expectations and 1..30 steps required before execution');
    requireValue(Array.isArray(scenario.source_refs) && scenario.source_refs.length > 0, 'Design source references required');
    for (const step of scenario.steps) {
      requireValue(id(step.request_id) && !requests.has(step.request_id), 'Unique request_id required'); requests.add(step.request_id);
      requireValue([...safeMethods, 'POST', 'PUT', 'PATCH', 'DELETE'].includes(step.method), 'Unsupported HTTP method');
      requireValue(typeof step.url === 'string' && Array.isArray(step.assertions) && step.assertions.length > 0, 'Request URL and predeclared assertions required');
      requireValue(!step.script && !step.multipart && !(step.json !== undefined && step.form !== undefined), 'Scripts/multipart or mixed bodies are unsupported');
      if (!safeMethods.includes(step.method) || step.side_effect === true) requireValue(plan.write_authorization?.quote && Array.isArray(scenario.resources) && scenario.resources.length > 0, 'Write requests need cited authorization and resource keys');
      for (const assertion of step.assertions) {
        requireValue(['status', 'content_type', 'equals', 'exists', 'type', 'schema', 'range', 'length', 'contains'].includes(assertion.type), 'Unsupported API assertion');
        if(['status','content_type','equals','type','schema','contains'].includes(assertion.type)) requireValue(Object.hasOwn(assertion,'value'),'Assertion expected value required');
        if(assertion.type==='content_type') requireValue(typeof assertion.value==='string' && mediaTypePattern.test(assertion.value) && !['path','min','max'].some(k=>Object.hasOwn(assertion,k)), 'Content-Type assertion requires an exact media type without parameters, wildcards or body path');
        if(assertion.type==='status') requireValue(Number.isInteger(assertion.value) && assertion.value>=100 && assertion.value<=599,'Invalid expected HTTP status');
        if(assertion.type==='type') requireValue(['string','number','boolean','object','array','null'].includes(assertion.value),'Invalid expected field type');
        if(['range','length'].includes(assertion.type)) requireValue(Number.isFinite(assertion.min) || Number.isFinite(assertion.max),'A boundary assertion needs min or max');
        if (assertion.type === 'schema') new Ajv({ allErrors: true, strict: true }).compile(assertion.value);
      }
      if (step.auth) requireValue(['bearer', 'basic', 'api_key', 'cookie'].includes(step.auth.type) && (typeof step.auth.ref === 'string' && /^(qa-secret:\/\/|\$\{)/.test(step.auth.ref) || id(step.auth.credential_key)), 'Authentication uses a task-owned secret reference or a named credential waiting slot');
      for (const [name, value] of Object.entries(step.headers ?? {})) requireValue(!sensitive.test(name) || /^qa-secret:\/\//.test(value), 'Sensitive headers must use secret references');
      requireValue(!Object.keys(step.headers ?? {}).some(k => /^(host|content-length|proxy-authorization)$/i.test(k)), 'Transport headers cannot be overridden');
      for (const extraction of step.extract ?? []) requireValue(id(extraction.name) && typeof extraction.path === 'string', 'Invalid response extraction');
      if(step.cleanup_of) {const create=scenario.steps.slice(0,scenario.steps.indexOf(step)).find(s=>s.request_id===step.cleanup_of);requireValue(create?.method==='POST' && create.extract?.some(e=>step.url.includes('${'+e.name+'}')),'Cleanup must reference an earlier creation and its extracted identifier');}
    }
  }
  for (const scenario of plan.scenarios) requireValue((scenario.depends_on ?? []).every(x => scenarios.has(x) && x !== scenario.scenario_id), 'Invalid scenario dependency');
  const visit = (name, stack = []) => { requireValue(!stack.includes(name), 'Cyclic scenario dependencies'); for (const dep of plan.scenarios.find(s => s.scenario_id === name).depends_on ?? []) visit(dep, [...stack, name]); };
  plan.scenarios.forEach(s => visit(s.scenario_id));
  return plan;
}
export function redactApi(value, secrets = []) {
  if (typeof value === 'string') { let v = value; for (const secret of secrets) if (secret) v = v.split(secret).join('[REDACTED]'); return v.replace(/qa-secret:\/\/[^\s"']+/g, '[SECRET_REFERENCE]'); }
  if (Array.isArray(value)) return value.map(v => redactApi(v, secrets));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, sensitive.test(k) ? '[REDACTED]' : redactApi(v, secrets)]));
  return value;
}
function assertResponse(assertion, response) {
  const actual = assertion.type === 'status' ? response.status : assertion.type === 'content_type' ? mediaType(response.contentType) : apiField(response.body, assertion.path);
  let passed = false;
  switch (assertion.type) {
    case 'status': case 'equals': passed = isDeepStrictEqual(actual, assertion.value); break;
    case 'content_type': passed = actual === assertion.value.toLowerCase(); break;
    case 'exists': passed = actual !== undefined && actual !== null; break;
    case 'type': passed = (Array.isArray(actual) ? 'array' : actual === null ? 'null' : typeof actual) === assertion.value; break;
    case 'schema': passed = new Ajv({ allErrors: true, strict: true }).compile(assertion.value)(actual); break;
    case 'range': passed = typeof actual === 'number' && (assertion.min === undefined || actual >= assertion.min) && (assertion.max === undefined || actual <= assertion.max); break;
    case 'length': passed = (typeof actual === 'string' || Array.isArray(actual)) && (assertion.min === undefined || actual.length >= assertion.min) && (assertion.max === undefined || actual.length <= assertion.max); break;
    case 'contains': passed = (typeof actual === 'string' || Array.isArray(actual)) && actual.includes(assertion.value); break;
  }
  // Public receipts contain the declared assertion and verdict, not arbitrary sensitive response values.
  return { type: assertion.type, path: assertion.path ?? '', status: passed ? 'passed' : 'failed', actual_type:Array.isArray(actual)?'array':actual===null?'null':typeof actual, ...((assertion.type==='status' || /(?:^|\.)(code|status|success)$/.test(assertion.path??'')) && ['number','boolean'].includes(typeof actual)?{actual}:{}), ...(assertion.type==='status'?{expected:assertion.value}:{}), ...(assertion.type==='content_type'?{actual,expected:assertion.value.toLowerCase()}:{} ) };
}

// No browser is created. Each scenario owns its cookie jar and variables.
export async function executeApiPlan(plan, { prior = {}, saveReceipt, saveProgress = () => {}, cancelled = () => false, resolveSecret, saveSecret, waitForAuth, onResources = () => true, releaseResources = () => {}, now = () => new Date().toISOString() } = {}) {
  validateApiCases(plan);
  const completed = new Map(), pending = [...plan.scenarios], running = new Map(), receipts = new Map(Object.entries(prior)), variables = new Map();
  const concurrency = Math.max(1, Math.min(4, plan.concurrency ?? 2)), timeout = Math.max(100, Math.min(60000, plan.timeout_ms ?? 15000));
  const started = Date.now(), deadline = Math.max(1000, Math.min(600000, plan.max_duration_ms ?? 300000));
  let lastRequest = 0;
  const stopped = () => cancelled() || Date.now() - started > deadline;
  async function runScenario(scenario) {
    const resources = scenario.resources ?? [], vars = Object.assign({}, ...((scenario.depends_on ?? []).map(x => variables.get(x) ?? {})));
    const secrets = [], assertionRows = [], evidence = [];
    let status = 'passed', reason = null, acquired = false;
    const context = await playwrightRequest.newContext({ ignoreHTTPSErrors: false });
    const interpolate = value => {
      if (typeof value === 'string') return value.replace(/\$\{([A-Za-z0-9_-]+)\}/g, (_, key) => { requireValue(Object.hasOwn(vars, key), 'Scenario variable unavailable'); return String(vars[key]); });
      if (Array.isArray(value)) return value.map(interpolate);
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, interpolate(v)]));
      return value;
    };
    const secret = ref => { const raw = resolveSecret(ref); secrets.push(raw); return raw; };
    const materialize = value => typeof value === 'string' && value.startsWith('qa-secret://') ? secret(value) : Array.isArray(value) ? value.map(materialize) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, materialize(v)])) : value;
    try {
      acquired = await onResources(resources, stopped);
      if (!acquired) return { status: 'blocked', reason: 'resource_conflict_or_cancelled', assertions: [], requests: [] };
      for (const original of scenario.steps) {
        if (stopped()) { status = 'blocked'; reason = 'cancelled_or_time_limit'; break; }
        const digest = apiHash(original), old = receipts.get(original.request_id);
        if (old) {
          requireValue(old.request_sha256 === digest, 'Request ID reused with changed content');
          evidence.push(original.request_id); assertionRows.push(...(old.assertions ?? []));
          if (old.status !== 'passed') { status = old.status === 'started' ? 'unknown' : old.status; reason = 'previous_request_not_replayed'; break; }
          Object.assign(vars, old.extracted ?? {}); continue;
        }
        const step = interpolate(original);
        let expandedUrl = original.url.replace(/\$\{([A-Za-z0-9_-]+)\}/g, (_, key) => { requireValue(Object.hasOwn(vars, key), 'Scenario variable unavailable'); return encodeURIComponent(String(vars[key]).startsWith('qa-secret://') ? secret(vars[key]) : String(vars[key])); });
        for(const [key,value] of Object.entries(materialize(step.path_params??{}))) expandedUrl=expandedUrl.replaceAll(`{${key}}`,encodeURIComponent(String(value)));
        requireValue(!/[{}]/.test(expandedUrl),'Unresolved API path parameter');
        const target = apiTarget(expandedUrl, plan.scope);
        for (const [k, v] of Object.entries(materialize(step.query ?? {}))) {target.searchParams.delete(k);for(const item of Array.isArray(v)?v:[v])target.searchParams.append(k,String(item));}
        const headers = materialize(step.headers ?? {});
        if (step.auth) {
          let value;
          try { value=secret(step.auth.ref); }
          catch { if(!waitForAuth || !step.auth.credential_key) throw new Error('authentication_unavailable'); value=secret(await waitForAuth(step.auth.credential_key,stopped)); }
          if (step.auth.type === 'bearer') headers.Authorization = /^Bearer /i.test(value) ? value : `Bearer ${value}`;
          if (step.auth.type === 'basic') headers.Authorization = /^Basic /i.test(value) ? value : `Basic ${Buffer.from(value).toString('base64')}`;
          if (step.auth.type === 'cookie') headers.Cookie = value;
          if (step.auth.type === 'api_key') { requireValue(typeof step.auth.name==='string' && !/^(host|content-length|proxy-authorization)$/i.test(step.auth.name), 'API keys need a safe header or query name'); if(step.auth.in==='query')target.searchParams.set(step.auth.name,value);else headers[step.auth.name] = value; }
        }
        const spacing = Math.max(0, Math.min(5000, plan.interval_ms ?? 100));
        const reserved = Math.max(Date.now(), lastRequest + spacing); lastRequest = reserved;
        await new Promise(r => setTimeout(r, reserved - Date.now()));
        if (stopped()) { status = 'blocked'; reason = 'cancelled_before_request'; break; }
        if(step.cleanup_of) requireValue(receipts.get(step.cleanup_of)?.status==='passed','Cleanup ownership was not established');
        const receipt = { version: 1, request_id: original.request_id, request_sha256: digest, scenario_id: scenario.scenario_id, source_case_id: scenario.case_id, attempt: 1, method: step.method, side_effect:step.side_effect===true, cleanup_of:step.cleanup_of??null, status: 'started', started_at: now(), assertions: [] };
        await saveReceipt(receipt); receipts.set(original.request_id, receipt); evidence.push(original.request_id);
        const start = Date.now();
        let timer;
        try {
          timer = setInterval(() => { if (stopped()) void context.dispose(); }, 100);
          let response = await context.fetch(target.href, { method: step.method, headers, ...(step.json !== undefined ? { data: materialize(step.json) } : {}), ...(step.form ? { form: materialize(step.form) } : {}), maxRedirects: 0, maxRetries: 0, timeout, failOnStatusCode: false });
          // Redirects never forward credentials; a redirect is evidence requiring an explicit new case.
          if (response.status() >= 300 && response.status() < 400) throw new Error('redirect_not_followed');
          const contentType = response.headers()['content-type'] ?? '', length = Number(response.headers()['content-length'] ?? 0), limit = Math.min(1024 * 1024, plan.max_response_bytes ?? 262144);
          // Preserve known header verdicts even if the body cannot be read or parsed.
          receipt.http_status = response.status();
          receipt.assertions = step.assertions.filter(a => ['status','content_type'].includes(a.type)).map(a => assertResponse(a, { status: response.status(), contentType }));
          if (length > limit) throw new Error('response_size_limit');
          const bytes = await response.body();
          if (bytes.length > limit) throw new Error('response_size_limit');
          let body = null;
          const type = mediaType(contentType);
          if ((type === 'application/json' || type?.endsWith('+json')) && bytes.length) { try { body = JSON.parse(bytes.toString()); } catch { throw new Error('response_parse_failure'); } }
          else if (/text|xml|html/i.test(contentType)) body = bytes.toString();
          else if (bytes.length) body = { binary_bytes: bytes.length, sha256: apiHash(bytes) };
          receipt.http_status = response.status(); receipt.response = { content_type: contentType, bytes: bytes.length, sha256: apiHash(bytes) };
          receipt.assertions = step.assertions.map(a => assertResponse(a, { status: response.status(), contentType, body }));
          receipt.status = receipt.assertions.every(a => a.status === 'passed') ? 'passed' : 'failed';
          receipt.extracted = {};
          for (const extract of step.extract ?? []) {
            const v = apiField(body, extract.path);
            requireValue(['string', 'number', 'boolean'].includes(typeof v), 'extraction_unavailable');
            // All extracted values are encrypted references on disk; public evidence carries no response bodies.
            const ref = saveSecret(String(v)); receipt.extracted[extract.name] = ref;
            vars[extract.name] = ref;
          }
          await response.dispose();
        } catch (error) {
          receipt.status = safeMethods.includes(step.method) && step.side_effect !== true ? 'blocked' : 'unknown';
          receipt.error_category = ['redirect_not_followed', 'response_size_limit', 'response_parse_failure', 'extraction_unavailable'].includes(error.message) ? error.message : /certificate|SSL|TLS/i.test(error.message)?'tls_failure':/ENOTFOUND|EAI_AGAIN/i.test(error.message)?'dns_failure':/ECONNREFUSED|ECONNRESET/i.test(error.message)?'connection_failure':/timeout|timed out/i.test(error.message)?'timeout':stopped()?'cancelled':'transport_failure';
          reason = receipt.error_category;
        } finally { clearInterval(timer); }
        receipt.finished_at = now(); receipt.duration_ms = Date.now() - start;
        // Secret references are needed for restart, and belong only in private state, not public receipts.
        await saveReceipt(receipt); receipts.set(original.request_id, receipt); assertionRows.push(...receipt.assertions);
        if (receipt.status !== 'passed') { status = receipt.status; break; }
      }
    } catch { status = 'blocked'; reason = 'preparation_or_resource_failure'; }
    finally { await context.dispose().catch(() => {}); if(acquired) await releaseResources(resources, status === 'unknown'); }
    variables.set(scenario.scenario_id, vars);
    return { status, reason, assertions: assertionRows, requests: evidence };
  }
  while (pending.length || running.size) {
    for (let i = 0; i < pending.length && running.size < concurrency;) {
      const scenario = pending[i], deps = scenario.depends_on ?? [];
      if (deps.some(d => !completed.has(d))) { i++; continue; }
      pending.splice(i, 1);
      if (stopped() || deps.some(d => completed.get(d).status !== 'passed')) { completed.set(scenario.scenario_id, { status: 'blocked', reason: 'dependency_or_cancelled', requests: [], assertions: [] }); continue; }
      const promise = runScenario(scenario).then(result => { completed.set(scenario.scenario_id, result); running.delete(scenario.scenario_id); saveProgress([...completed]); });
      running.set(scenario.scenario_id, promise);
    }
    if (running.size) await Promise.race(running.values());
    else if (pending.length) throw new Error('Unresolved scenario dependencies');
  }
  return plan.scenarios.map(s => ({ case_id: `api:${s.scenario_id}`, source_case_id: s.case_id, scenario_id: s.scenario_id, title: s.title ?? s.case_id, expected: s.expected, layer: 'api', attempt: 1, evidence_mode: 'real', verification_scope: { layer: 'api_contract' }, ...completed.get(s.scenario_id) }));
}
