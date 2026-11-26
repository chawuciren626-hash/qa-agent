/** Node-only execution host. No business HTTP service, user database or administrative token. */
import fs from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createAgent, saveProjectConfig, findLatestTraceFile, tracesDir, userText } from "@prismshadow/penguin-core";
import type { Session, AgentAssembly, AmspRecord } from "@prismshadow/penguin-core";

type Job = { id: string; sessionId: string; payload: any };
type Config = { origin: string; cookie: string; clientId: string; proof: string; root: string; engine: string; workspaces: string; python: string; userId: string };
let config: Config;
let stopped = false;
const sessions = new Map<string, Session>();
const jobs = new Map<string, AbortController>();
const approvals = new Map<string, (decision: any) => void>();
let eventTail: Promise<unknown> = Promise.resolve();
const relayToken = randomBytes(32).toString("hex");
const apiTokens = new Map<string, string>();
const sessionJobs = new Map<string, Job>();
const descendants = new Map<string, Set<string>>();
const completedControls = new Set<string>();
const jobControlHandlers = new Map<string, (value: any) => void>();
let relayOrigin = "";
const pathWithin = (base: string, file: string) => file.startsWith(path.resolve(base) + path.sep);

function rebase<T>(value: T, bundle: any): T {
  if (typeof value === "string") {
    return value.split(bundle.engine ?? "\0").join(config.engine.replaceAll("\\", "/"))
      .split(bundle.root).join(config.root.replaceAll("\\", "/")) as T;
  }
  if (Array.isArray(value)) return value.map(item => rebase(item, bundle)) as T;
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rebase(item, bundle)])) as T;
  return value;
}
async function request(endpoint: string, body: unknown, signal?: AbortSignal): Promise<Response> {
  const response = await fetch(`${config.origin}/api/sessions/local-execution${endpoint}`, {
    method: "POST", headers: { "content-type": "application/json", cookie: config.cookie,
      "x-aitest-execution-client": config.clientId, "x-aitest-execution-proof": config.proof },
    body: JSON.stringify(body), signal: signal ?? AbortSignal.timeout(20_000), redirect: "error",
  });
  if (!response.ok) throw new Error(`执行通道 ${response.status}: ${(await response.text()).slice(0, 1000)}`);
  return response;
}
async function writeFiles(base: string, files: { path: string; content: string }[], bundle: any): Promise<void> {
  for (const file of files) {
    if (file.path.split(/[\\/]/).some(part => part === "..") || file.path.includes(":")) throw new Error("Invalid execution resource path");
    const target = path.resolve(base, file.path);
    if (!pathWithin(base, target)) throw new Error("Execution resource escapes project");
    await fs.mkdir(path.dirname(target), { recursive: true });
    for (let parent = target; pathWithin(base, parent); parent = path.dirname(parent)) {
      if ((await fs.lstat(parent).catch(() => null))?.isSymbolicLink()) throw new Error("Linked execution resource");
    }
    let content = Buffer.from(file.content, "base64");
    if ((file.path.includes("/agent_state/") || file.path.startsWith(".bridge-resources/")) && /\.(mjs|js|json|yaml|yml|toml|md|txt)$/.test(file.path)) content = Buffer.from(rebase(content.toString("utf8"), bundle));
    await fs.writeFile(target, content, { mode: 0o600 });
  }
}
function state(session: Session): any {
  return { provider: session.provider, modelId: session.modelId, workspaceDir: session.workspaceDir,
    metaMessage: session.metaMessage, compactability: session.compactability(),
    hasPendingInput: session.hasPendingInput(), contextOpenPending: session.contextOpenPending(),
    commands: session.listBackgroundCommands(), subagents: session.listBackgroundSubagents(), runningSubagents: session.hasRunningBackgroundSubagents(),
    permissions: Object.fromEntries(["exec_command", "input_command", "read_file", "write_file", "edit_file", "run_subagent", "input_subagent"].map(name => [name, session.toolPermission(name)])) };
}
function enqueueEvent(sessionId: string, event: unknown): Promise<unknown> {
  const eventId = randomUUID();
  eventTail = eventTail.then(async () => {
    // A retry carries the same event id; the server deduplicates the acknowledgement.
    let last: unknown;
    for (let attempt = 0; attempt < 3 && !stopped; attempt++) {
      try { return await request("/events", { eventId, sessionId, event }); }
      catch (error) { last = error; await new Promise(resolve => setTimeout(resolve, 500)); }
    }
    throw last;
  }).catch(error => { process.send?.({ type: "execution-error", sessionId, message: String(error) }); });
  return eventTail;
}
async function getSession(job: Job): Promise<Session> {
  const bundle = job.payload.bundle;
  sessionJobs.set(job.sessionId, job);
  const base = path.join(config.root, bundle.projectId);
  await writeFiles(base, bundle.files, bundle);
  const cfg = rebase(bundle.projectConfig, bundle);
  cfg.providers = {};
  cfg.models = cfg.models.map((model: any) => ({ ...model, api_key: relayToken,
    base_url: `${relayOrigin}/${encodeURIComponent(job.sessionId)}/${encodeURIComponent(model.provider)}/${encodeURIComponent(model.model_id)}` }));
  await saveProjectConfig(config.root, bundle.projectId, cfg);
  await fs.writeFile(path.join(base, "qa-project.json"), JSON.stringify({ status: "ready", version: 1 }));
  const cached = sessions.get(job.sessionId);
  if (cached) return cached;
  const assembly: AgentAssembly = {
    publishedDefinition: async context => {
      const response = await request("/definition", { ...context, rootSessionId: job.sessionId });
      const data = await response.json() as any;
      if (context.sessionId !== job.sessionId) {
        const owned = descendants.get(job.sessionId) ?? new Set<string>();
        owned.add(context.sessionId); descendants.set(job.sessionId, owned);
      }
      if (data.resourceFiles) await writeFiles(base, data.resourceFiles, bundle);
      return rebase(data.definition, bundle);
    },
    // Central authorization is checked for every tool and on each model request.
    authorizeTool: async context => {
      await request("/authorize", { ...context, rootSessionId: job.sessionId });
    },
  };
  const apiToken = randomBytes(32).toString("hex");
  apiTokens.set(apiToken, job.sessionId);
  const agent = await createAgent({ root: config.root, projectId: bundle.projectId, agentId: bundle.agentId, assembly,
    controlEnv: context => ({ PENGUIN_API_URL: relayOrigin, PENGUIN_API_TOKEN: apiToken, PENGUIN_PROJECT_ID: context.projectId,
      PENGUIN_AGENT_ID: context.agentId, PENGUIN_SESSION_ID: context.sessionId,
      PENGUIN_AGENT_ROOT: path.join(config.root, context.projectId, "agents") }),
  });
  const trace = await findLatestTraceFile(tracesDir(config.root, bundle.projectId, bundle.agentId), job.sessionId);
  if (!trace && bundle.requireLocalTrace) throw new Error("本机会话轨迹已缺失，请检查本机执行缓存或新建会话；不会从服务端重建执行历史");
  const session = trace ? await agent.resumeSession({ sessionId: job.sessionId, ownerUserId: config.userId }) : await agent.createSession({
    sessionId: job.sessionId, modelId: bundle.modelId, provider: bundle.provider,
    ownerUserId: config.userId, source: "user", thinkingLevel: bundle.thinkingLevel,
  });
  const persistentApprove = async (toolCall: any) => {
    const response = await request("/approval", { sessionId: job.sessionId, toolCall }, AbortSignal.timeout(10 * 60_000));
    return (await response.json() as any).decision;
  };
  session.setSubagentApprovalFallback(persistentApprove);
  session.onBackgroundMessage(message => { void enqueueEvent(job.sessionId, { type: "message", message }); });
  const publishState = () => { void enqueueEvent(job.sessionId, { type: "state", state: state(session) }); };
  session.onBackgroundState(publishState);
  session.onSubagentState(publishState);
  session.onBackgroundNotice(() => {
    void (async () => {
      await snapshot(job, session, frame => enqueueEvent(job.sessionId, { type: "file", frame }).then(() => {}));
      await enqueueEvent(job.sessionId, { type: "state", state: state(session) });
      await enqueueEvent(job.sessionId, { type: "notice", messages: session.takeBackgroundNotices() });
    })().catch(error => process.send?.({ type: "execution-error", message: String(error) }));
  });
  sessions.set(job.sessionId, session);
  return session;
}

async function snapshot(job: Job, session: Session, emit: (frame: any) => Promise<void>): Promise<void> {
  const base = path.join(config.root, job.payload.bundle.projectId);
  const agents = path.join(base, "agents");
  const owned = new Set([job.sessionId, ...descendants.get(job.sessionId) ?? [], ...session.listBackgroundSubagents().map(child => child.sessionId)]);
  const files: { file: string; relative: string }[] = [];
  let total = 0;
  async function walk(dir: string, prefix: string, filter: (relative: string) => boolean): Promise<void> {
    for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (entry.isSymbolicLink() || ["node_modules", ".git"].includes(entry.name)) continue;
      const relative = `${prefix}${entry.name}`, file = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(file, relative + "/", filter);
      else if (entry.isFile() && filter(relative)) files.push({ file, relative });
    }
  }
  await walk(agents, "agents/", relative => {
    const trace = /\/traces\/\d{4}-\d{2}-\d{2}\/(session-[a-zA-Z0-9_-]+)_\d+\.jsonl$/.exec(relative);
    const scratch = /\/scratchpad\/(session-[a-zA-Z0-9_-]+)\//.exec(relative);
    return trace ? owned.has(trace[1]!) : !!scratch && owned.has(scratch[1]!);
  });
  await walk(session.workspaceDir, "workspace/", relative => relative !== "workspace/.qa-session.json");
  for (const { file, relative } of files) {
    const stat = await fs.stat(file);
    if (stat.size > 16 * 1024 * 1024 || (total += stat.size) > 100 * 1024 * 1024) throw new Error("本机产物超出同步上限，文件保留在本机，请清理后重试");
    const bytes = await fs.readFile(file), hash = createHash("sha256").update(bytes).digest("hex");
    for (let offset = 0; offset < Math.max(bytes.length, 1); offset += 384 * 1024) {
      const chunk = bytes.subarray(offset, offset + 384 * 1024);
      await emit({ type: "bridge_file", path: relative, content: chunk.toString("base64"), hash, offset, final: offset + chunk.length >= bytes.length });
    }
  }
}


async function uploadExplorationTree(base: string, prefix: string, emit: (frame: any) => Promise<void>): Promise<void> {
  let total = 0;
  async function walk(dir: string, relative: string): Promise<void> {
    for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (entry.isSymbolicLink() || /^(credentials|answer|session|storage-state)\.json(l)?$/.test(entry.name) || entry.name === "login-config.json") continue;
      const file = path.join(dir, entry.name), name = relative + entry.name;
      if (entry.isDirectory()) await walk(file, name + "/");
      else if (entry.isFile()) {
        const size = (await fs.stat(file)).size;
        if (size > 16 * 1024 * 1024 || (total += size) > 100 * 1024 * 1024) throw new Error("探索产物超出传输限额，文件已保留在本机");
        const bytes = await fs.readFile(file), hash = createHash("sha256").update(bytes).digest("hex");
        for (let offset = 0; offset < Math.max(bytes.length, 1); offset += 384 * 1024) {
          const chunk = bytes.subarray(offset, offset + 384 * 1024);
          await emit({ type: "bridge_exploration_file", path: prefix + name, content: chunk.toString("base64"), hash, offset, final: offset + chunk.length >= bytes.length });
        }
      }
    }
  }
  await walk(base, "");
}
async function mergeExploration(job: Job, emit: (frame: any) => Promise<void>, abort: AbortController): Promise<unknown> {
  const args = job.payload.args;
  if (!/^[a-zA-Z0-9_-]+$/.test(args.env) || !/^[a-zA-Z0-9_-]+$/.test(args.projectId) || !/^explore\/[a-zA-Z0-9_-]+\/round-\d+$/.test(args.outPrefix)) throw new Error("探索合并路径无效");
  if (!config.python || config.python === "unconfigured") throw new Error("本机 Python 未配置，无法合并探索地图");
  const base = path.join(config.workspaces, ".explorations", job.id);
  await fs.mkdir(base, { recursive: true });
  await writeFiles(base, args.files, { root: "\0", engine: "\0" });
  const exploreDir = path.join(base, "explore"), mapsDir = path.join(base, "maps");
  const argv = [path.join(config.engine, "scripts", "merge-explore-maps.py"), "--project", args.projectId, "--env", args.env,
    "--target-route", args.targetRoute, "--explore-dir", exploreDir, "--report-out", path.join(mapsDir, `env-report-${args.env}.md`)];
  if (await fs.stat(path.join(exploreDir, "pages.json")).then(() => true, () => false)) argv.push("--pages", path.join(exploreDir, "pages.json"));
  const bootstrap = path.join(mapsDir, `maps-${args.env}.yaml`);
  if (await fs.stat(bootstrap).then(() => true, () => false)) argv.push("--bootstrap-maps", bootstrap);
  if (typeof args.round === "number") argv.push("--round", String(args.round));
  if (args.publicMode) argv.push("--public-mode");
  await promisify(execFile)(config.python, argv, { cwd: config.engine, windowsHide: true, timeout: 150_000, signal: abort.signal,
    env: { ...process.env, PYTHONPATH: [path.join(config.engine, "aitestharness-tools"), process.env.PYTHONPATH].filter(Boolean).join(path.delimiter), PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" } });
  await uploadExplorationTree(exploreDir, args.outPrefix + "/", emit);
  await uploadExplorationTree(mapsDir, `maps/${args.env}/`, emit);
  const maps = JSON.parse(await fs.readFile(path.join(exploreDir, `maps-${args.env}.json`), "utf8"));
  return { mapsPath: `${args.outPrefix}/maps-${args.env}.json`, maps };
}

async function runExploration(job: Job, emit: (frame: any) => Promise<void>, abort: AbortController): Promise<void> {
  const args = job.payload.args ?? {};
  const outDir = path.join(config.workspaces, ".explorations", job.id);
  await fs.mkdir(outDir, { recursive: true });
  const creds = path.join(outDir, "credentials.json");
  const configFile = args.loginConfig ? path.join(outDir, "login-config.json") : null;
  const answerPath = path.join(outDir, "answer.json");
  await fs.writeFile(creds, JSON.stringify({ username: args.username ?? "", password: args.password ?? "" }), { mode: 0o600 });
  if (configFile) await fs.writeFile(configFile, JSON.stringify(args.loginConfig, null, 2), { mode: 0o600 });
  const script = path.join(config.engine, "scripts", "explore-authenticated.mjs");
  const argv = [script, "--login-url", args.loginUrl ?? args.targetUrl, "--target-url", args.targetUrl,
    "--creds", creds, "--out", outDir, "--session", path.join(outDir, "session.jsonl"), "--captcha-strategy", "auto"];
  if (configFile) argv.push("--config", configFile);
  if (!configFile) argv.push("--discover-login");
  if (args.publicMode) argv.push("--public"); else argv.push("--mode", "site");
  let child: ReturnType<typeof spawn> | null = null;
  let aborted = false;
  jobControlHandlers.set(job.id, value => {
    if (value?.type === "exploration_answer") void fs.writeFile(answerPath, JSON.stringify({ answer: value.answer }));
    if (value?.type === "exploration_abort") { aborted = true; child?.kill(); }
  });
  try {
    child = spawn(process.execPath, argv, { cwd: config.engine, windowsHide: true, env: { ...process.env, QA_PYTHON: config.python } });
    let pending = "", stderrTail = "", stdoutTail = "";
    let progress: Promise<void> = Promise.resolve();
    const handleLine = async (line: string) => {
      const text = line.trim(); if (!text) return;
      if (text.startsWith("@@step ") || text.startsWith("@@captcha ")) {
        const kind = text.startsWith("@@step ") ? "step" : "captcha";
        try {
          const event = JSON.parse(text.slice(kind === "step" ? 7 : 10));
          if (kind === "captcha" && typeof event.path === "string") {
            const local = path.isAbsolute(event.path) ? event.path : path.join(outDir, event.path);
            if (await fs.stat(local).then(() => true, () => false)) {
              const bytes = await fs.readFile(local), hash = createHash("sha256").update(bytes).digest("hex");
              for (let offset = 0; offset < Math.max(bytes.length, 1); offset += 384 * 1024) {
                const chunk = bytes.subarray(offset, offset + 384 * 1024);
                await emit({ type: "bridge_exploration_file", path: path.basename(local), content: chunk.toString("base64"), hash, offset, final: offset + chunk.length >= bytes.length });
              }
              event.path = path.basename(local);
            }
          }
          await emit({ type: "bridge_exploration_event", event: { kind, ...event } });
        } catch (error) { throw new Error(`探索事件传输失败：${String(error)}`); }
      } else stderrTail = (stderrTail + text + "\n").slice(-2000);
    };
    child.stderr?.setEncoding("utf8"); child.stderr?.on("data", chunk => { pending += chunk; const lines = pending.split(/\r?\n/); pending = lines.pop() ?? ""; for (const line of lines) progress = progress.then(() => handleLine(line)); });
    child.stdout?.setEncoding("utf8"); child.stdout?.on("data", chunk => { stdoutTail = (stdoutTail + chunk).slice(-4000); });
    const code = await new Promise<number | null>(resolve => { child!.on("error", () => resolve(-1)); child!.on("close", resolve); abort.signal.addEventListener("abort", () => child?.kill(), { once: true }); });
    if (pending.trim()) progress = progress.then(() => handleLine(pending));
    await progress;
    await uploadExplorationTree(outDir, "", emit);
    if (aborted || abort.signal.aborted) throw new Error("操作员中止");
    if (code !== 0) throw new Error((stderrTail || stdoutTail).trim() || `探索脚本以非零状态退出（${code}）`);
  } finally {
    jobControlHandlers.delete(job.id);
    await fs.rm(creds, { force: true }).catch(() => {});
    await fs.rm(answerPath, { force: true }).catch(() => {});
  }
}
async function execute(job: Job): Promise<void> {
  const abort = new AbortController(); jobs.set(job.id, abort);
  let sequence = 0;
  const emit = async (frame: any) => {
    await request(`/jobs/${job.id}`, { sequence: sequence++, events: [frame], done: false }, abort.signal);
  };
  let session: Session | undefined;
  try {
    const { operation, args, bundle } = job.payload;
    let result: unknown;
    if (operation === "exploration" || operation === "explorationMerge") {
      result = operation === "exploration" ? await runExploration(job, emit, abort) : await mergeExploration(job, emit, abort);
      await emit({ type: "bridge_result", value: result });
      await request(`/jobs/${job.id}`, { sequence: sequence++, events: [], done: true });
      return;
    }
    session = await getSession(job);
    const approve = async (toolCall: any) => {
      const response = await request("/approval", { sessionId: job.sessionId, toolCall }, AbortSignal.any([abort.signal, AbortSignal.timeout(10 * 60_000)]));
      return (await response.json() as any).decision;
    };
    if (operation === "run") {
      if (args.thinkingLevel) session.thinkingLevel = args.thinkingLevel;
      for await (const event of session.run(rebase(args.messages, bundle), { signal: abort.signal, approve })) await emit(event);
    } else if (operation === "compact") {
      for await (const event of session.compact({ signal: abort.signal })) await emit(event);
    } else if (operation === "switchModel") {
      for await (const event of session.switchModel({ ...args, signal: abort.signal })) await emit(event);
    } else if (operation === "title") result = await session.generateTitle({ ...args, signal: abort.signal });
    else if (operation === "hook") result = await session.runUserPromptHook(args.name, args.prompt, args.extras);
    else if (operation === "subagentInput") result = await session.sendToBackgroundSubagent(args.sessionId, rebase(args.messages, bundle), args.opts);
    else if (operation === "humanActions") {
      const human = (await import("node:module")).createRequire(import.meta.url)(path.join(config.engine, "scripts/browser-human-action.mjs"));
      result = human.listHumanActions(session.workspaceDir, job.sessionId, path.join(config.root, bundle.projectId, "agents"));
    }
    else if (operation === "humanAnswer") {
      const human = (await import("node:module")).createRequire(import.meta.url)(path.join(config.engine, "scripts/browser-human-action.mjs"));
      result = await human.answerHumanAction({ workspace: session.workspaceDir, parent: job.sessionId,
        agentRoot: path.join(config.root, bundle.projectId, "agents"), runId: args.body.run_id, actionId: args.body.action_id, decision: args.body.decision,
        send: (child: string, text: string, _decision: string, channel: string) => session!.sendToBackgroundSubagent(child,
          [userText(text), userText(channel === "api" ? args.apiInstruction : args.browserInstruction, "harness")], { qaHumanContinuation: true } as any),
      });
    }
    else if (operation === "openDeliverable") {
      if (!/^output\/runs\/run-[a-zA-Z0-9-]+\/(?:design|report)\/[^/\\]+\.(?:xlsx|xmind)$/i.test(args.path)) throw new Error("Not a supported delivery document");
      const delivery = (await import("node:module")).createRequire(import.meta.url)(path.join(config.engine, "scripts/open-deliverable.mjs"));
      const file = path.resolve(session.workspaceDir, args.path);
      if (!pathWithin(session.workspaceDir, file) || await fs.realpath(file) !== file) throw new Error("Linked document");
      await delivery.openDeliverable(file);
    }
    else if (operation === "engineAction") {
      if (!["update-case-review.mjs", "approve-design-stage.mjs", "manage-defect-lifecycle.mjs", "request-stage-revision.mjs"].includes(args.script)) throw new Error("Engine action is not allowlisted");
      const marker = await fs.readFile(path.join(session.workspaceDir, ".qa-session.json"), "utf8");
      const env = { ...process.env, QA_DIRECTORY_CONTEXT: marker, PENGUIN_AGENT_ROOT: path.join(config.root, bundle.projectId, "agents"),
        ...(typeof args.environment?.QA_CASE_REVIEW === "string" ? { QA_CASE_REVIEW: args.environment.QA_CASE_REVIEW } : {}),
        ...(typeof args.environment?.QA_STAGE_FEEDBACK === "string" ? { QA_STAGE_FEEDBACK: args.environment.QA_STAGE_FEEDBACK } : {}) };
      result = await promisify(execFile)(process.execPath, [path.join(config.engine, "scripts", args.script), ...args.argv], { env, cwd: config.engine, windowsHide: true, timeout: 150_000, maxBuffer: 64 * 1024, signal: abort.signal });
    }
    else if (operation === "state") result = state(session);
    else if (operation !== "initialize") throw new Error("Unknown execution operation");
    if (!["initialize", "state", "title", "humanActions", "openDeliverable"].includes(operation)) await snapshot(job, session, emit);
    await emit({ type: "bridge_state", state: state(session) });
    await emit({ type: "bridge_result", value: result });
    await request(`/jobs/${job.id}`, { sequence: sequence++, events: [], done: true });
  } catch (error) {
    if (session) await snapshot(job, session, frame => enqueueEvent(job.sessionId, { type: "file", frame }).then(() => {})).catch(() => {});
    // Never retry an execution job: a lost acknowledgement may follow a successful side effect.
    await request(`/jobs/${job.id}`, { sequence, events: [], done: true, error: String(error) }).catch(() => {});
    process.send?.({ type: "execution-error", sessionId: job.sessionId, message: String(error).slice(0, 1500) });
  } finally { jobs.delete(job.id); }
}

async function start(options: Config): Promise<void> {
  config = options;
  process.env.PENGUIN_HOME = config.root;
  // qa-runtime reads these on module import; the parent sets AITEST_ENGINE_ROOT before spawning us.
  process.env.QA_WORKSPACE_ROOT = config.workspaces;
  const relay = http.createServer(async (req, res) => {
    try {
      const token = req.headers.authorization?.replace(/^Bearer /, "") ?? String(req.headers["x-api-key"] ?? "");
      const url = new URL(req.url!, "http://localhost");
      const apiSessionId = apiTokens.get(token);
      if (apiSessionId && url.pathname.startsWith("/api/")) {
        const job = sessionJobs.get(apiSessionId)!;
        const projectPrefix = `/api/projects/${encodeURIComponent(job.payload.bundle.projectId)}`;
        const scoped = url.pathname === "/api/me" || url.pathname === projectPrefix || url.pathname.startsWith(projectPrefix + "/") ||
          url.pathname.startsWith(`/api/sessions/${apiSessionId}/`);
        if (!scoped) { res.writeHead(403).end("Execution API is scoped to this project and session"); return; }
        const mutating = !["GET", "HEAD"].includes(req.method ?? "GET");
        if (mutating) await snapshot(job, sessions.get(apiSessionId)!, frame => enqueueEvent(apiSessionId, { type: "file", frame }).then(() => {}));
        const chunks: Buffer[] = []; let size = 0;
        for await (const chunk of req) { size += chunk.length; if (size > 16 * 1024 * 1024) throw new Error("API request too large"); chunks.push(chunk); }
        const controller = new AbortController(); res.on("close", () => controller.abort());
        const upstream = await fetch(config.origin + url.pathname + url.search, {
          method: req.method, headers: { "content-type": "application/json", cookie: config.cookie,
            "x-aitest-execution-client": config.clientId, "x-aitest-execution-proof": config.proof },
          ...(mutating ? { body: Buffer.concat(chunks) } : {}), signal: controller.signal, redirect: "error",
        });
        res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json" });
        for await (const chunk of upstream.body as any) { if (!res.write(Buffer.from(chunk))) await new Promise(resolve => res.once("drain", resolve)); }
        res.end(); return;
      }
      if (req.method !== "POST" || token !== relayToken) { res.writeHead(403).end(); return; }
      const parts = url.pathname.split("/").filter(Boolean);
      const [sessionId, provider, modelId, ...tail] = parts;
      if (!sessionId || !sessions.has(decodeURIComponent(sessionId)) || !provider || !modelId) { res.writeHead(404).end(); return; }
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > 16 * 1024 * 1024) throw new Error("Model request too large"); chunks.push(chunk); }
      const controller = new AbortController(); res.on("close", () => controller.abort());
      const upstream = await request(`/model/${sessionId}/${provider}/${modelId}/${tail.join("/")}`, JSON.parse(Buffer.concat(chunks).toString()), controller.signal);
      res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json" });
      for await (const chunk of upstream.body as any) { if (!res.write(Buffer.from(chunk))) await new Promise(resolve => res.once("drain", resolve)); }
      res.end();
    } catch (error) { if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { message: String(error).slice(0, 1000) } })); }
  });
  await new Promise<void>(resolve => relay.listen(0, "127.0.0.1", resolve));
  relayOrigin = `http://127.0.0.1:${(relay.address() as any).port}`;
  const register = () => request("/register", { platform: process.platform, node: process.execPath, python: config.python,
    engine: config.engine, workspaces: config.workspaces });
  await register();
  await request("/poll", { active: [] });
  process.send?.({ type: "execution-ready" });
  let lastSuccess = Date.now();
  let offline = false;
  while (!stopped) {
    try {
      const acknowledged = [...completedControls];
      const response = await request("/poll", { active: [...jobs.keys()], completedControls: acknowledged });
      const body = await response.json() as any;
      for (const id of acknowledged) completedControls.delete(id);
      for (const control of body.sessionControls ?? []) {
        if (completedControls.has(control.id)) continue;
        const session = sessions.get(control.sessionId);
        const args = control.args;
        if (session) {
          if (control.operation === "dispose") { session.dispose(); sessions.delete(control.sessionId); }
          else if (control.operation === "abortSubagent") session.abortBackgroundSubagentRun(args.sessionId);
          else if (control.operation === "killCommand") session.killBackgroundCommand(args.processId);
          else if (control.operation === "subagentThinking") session.setBackgroundSubagentThinkingLevel(args.sessionId, args.level);
          else if (control.operation === "retry") session.skipReconnectWait();
          else if (control.operation === "steer") session.steer(args.messages);
          void enqueueEvent(control.sessionId, { type: "state", state: state(session) });
        }
        completedControls.add(control.id);
      }
      lastSuccess = Date.now();
      if (offline) { offline = false; process.send?.({ type: "execution-ready" }); }
      for (const id of body.cancelled) jobs.get(id)?.abort();
      for (const item of body.controls) {
        if (item.value?.type === "exploration_answer" || item.value?.type === "exploration_abort") jobControlHandlers.get(item.jobId)?.(item.value);
        else {
          const { approvalId, decision } = item.value;
          if (["allow", "deny"].includes(decision)) approvals.get(approvalId)?.(decision);
        }
      }
      for (const job of body.jobs) void execute(job);
    } catch (error) {
      if (Date.now() - lastSuccess > 15_000) {
        for (const job of jobs.values()) job.abort(); for (const session of sessions.values()) session.dispose();
        sessions.clear();
        if (!offline) process.send?.({ type: "execution-offline", message: String(error).slice(0, 500) });
        offline = true;
        await register().catch(() => {});
      }
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  relay.close();
}
function stop(): void {
  stopped = true;
  for (const job of jobs.values()) job.abort();
  for (const resolve of approvals.values()) resolve("deny");
  for (const session of sessions.values()) session.dispose();
  setTimeout(() => process.exit(0), 1000).unref();
}
process.on("disconnect", stop);
process.on("message", (message: any) => {
  if (message.type === "start" && !config) void start(message.config).catch(error => { process.send?.({ type: "execution-fatal", message: String(error) }); stop(); });
  else if (message.type === "stop") stop();
});
