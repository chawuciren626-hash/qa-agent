/**
 * 环境探索派发（原批次 3 未派单缺口 1）：从环境页点一次，服务端代建一轮真实探索。
 *
 * 与建档的分工（批次 2 定下的三层职责，别再混）：
 *   建档 `onboard.bootstrap` —— 「有哪些地址」，零浏览器、零模型，同步产出 maps；
 *   探索 本服务            —— 「地址怎么走通」，开真浏览器登录后采集页面/接口。
 *
 * 为什么是确定性任务而不是给智能体发一句话：探索脚本（explore-authenticated.mjs）是
 * 已验证的能力，登录、验证码策略链、只读白名单都在里面写死；让模型「自由发挥」反而
 * 会把已验证的行为变成不确定行为。代价是没有 run/Trace —— 这一点在 UI 上如实说明，
 * 不建空会话冒充执行痕迹。
 *
 * 诚实边界（与建档同口径）：
 *   - 失败轮不写任何探索资产（四层知识保持上一轮），只落 last_error；
 *   - 失败轮/中止轮都占 round 号，轮次账目可对；
 *   - 凭据只在派发瞬间落到 0600 临时文件，进程结束即删，绝不进库；
 *   - 服务重启后残留的 running 行按「已中断」落 failed，不让界面永远转圈。
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Db } from "../hmr/capabilities.js";
import { HttpError } from "../http/errors.js";
import { replaceKnowledgeLayer, type KnowledgeEntryInput, type KnowledgeLayer } from "./environment-knowledge-service.js";
import { findEnvironment, type EnvironmentView } from "./project-environment-service.js";
import type { ExplorationKnowledgeBuildInfo, ExplorationKnowledgeSync } from "./exploration-knowledge-sync.js";

/** 探索六步：前五步与脚本事件一一对应，第六步由服务端合并回写后落定。 */
export const EXPLORATION_STEP_NAMES = ["准备配置", "拉起浏览器", "登录", "采集页面", "采集接口", "合并回写"] as const;
export type ExplorationStepStatus = "idle" | "running" | "done" | "failed";
export type ExplorationStatus = "running" | "waiting_human" | "succeeded" | "failed" | "aborted";
export type ExplorationLoginMode = "authenticated" | "public";

export interface ExplorationStep {
  index: number;
  name: string;
  status: ExplorationStepStatus;
  detail: string | null;
}

export interface ExplorationSummary {
  targetUrl: string;
  /** 探索模式：site=登录后逐页全站采集；page=仅目标页（公开页/兼容口径）。 */
  mode: "site" | "page" | null;
  controls: number | null;
  tables: number | null;
  apis: number | null;
  /** 全站模式：pages_ok / pages_failed（到过但没采到的页面，如实计数）。 */
  pagesOk: number | null;
  pagesFailed: number | null;
  structureDigest: string | null;
  sessionReused: boolean | null;
  mapsPath: string | null;
  knowledgeLayers: KnowledgeLayer[];
  captchaStrategy: string | null;
  limitations: string[];
  /** B1 联动结果：成功带构建信息；失败如实带 error，不改探索结论。 */
  knowledgeBuild: ExplorationKnowledgeBuildInfo | { error: string } | null;
}

export interface ExplorationView {
  explorationId: string;
  round: number;
  status: ExplorationStatus;
  targetUrl: string;
  loginUrl: string | null;
  loginMode: ExplorationLoginMode;
  steps: ExplorationStep[];
  summary: ExplorationSummary | null;
  lastError: string | null;
  startedAt: string;
  finishedAt: string | null;
  /** 只有 waiting_human 且截图还在时才非 null：前端据此显示人工填答卡片。 */
  captcha: { available: boolean; strategies: string[] } | null;
}

interface ExplorationRow {
  exploration_id: string;
  project_id: string;
  env: string;
  round: number;
  status: ExplorationStatus;
  target_url: string;
  login_url: string | null;
  login_mode: ExplorationLoginMode;
  steps_json: string | null;
  summary_json: string | null;
  last_error: string | null;
  started_at: string;
  finished_at: string | null;
  updated_at: string;
}

/** 脚本 → 服务端的事件；字段可缺，缺的按「没报」处理。 */
export type ExplorationEvent =
  | { kind: "step"; index: number; status: string; detail?: string }
  | { kind: "captcha"; status: "waiting" | "auto_solved" | "unresolved" | "answered"; path?: string; strategies?: string[] };

export interface ExplorationRunInput {
  targetUrl: string;
  loginUrl: string | null;
  username: string | null;
  password: string | null;
  /** 显式登录配置 JSON；为空时由脚本按 DOM 识别（authenticated 模式）。 */
  loginConfig: Record<string, unknown> | null;
  publicMode: boolean;
  outDir: string;
  sessionFile: string;
  configFile: string | null;
  credsFile: string;
  onEvent: (event: ExplorationEvent) => void;
}

export interface ExplorationRunHandle {
  done: Promise<{ ok: boolean; error: string | null }>;
  /** 人工验证码答案送达浏览器脚本。 */
  answer(answer: string): Promise<void>;
  abort(): void;
}

export type ExplorationRun = (input: ExplorationRunInput) => ExplorationRunHandle;

export interface ExplorationDeps {
  db: Db;
  /** 项目目录绝对路径；探索产物落 <projectDir>/explore/<env>/round-<n>/。 */
  projectDir: string;
  engineRoot: string | undefined;
  /** 测试注入：替换脚本执行器。 */
  run?: ExplorationRun;
  /** 测试注入：替换 maps 合并（生产走 python merge-explore-maps.py）。 */
  merge?: ExplorationMerge;
  /** 探索成功后把资产联动进项目资料知识库（B1）；缺省时摘要里如实留空。 */
  knowledgeSync?: ExplorationKnowledgeSync | null;
}

export interface ExplorationMergeInput {
  projectId: string;
  env: string;
  targetRoute: string;
  exploreDir: string;
  engineRoot: string;
}

export interface ExplorationMergeResult {
  mapsPath: string;
  maps: {
    pages?: { route?: string; registered?: boolean; control_count?: number }[];
    apis?: { method?: string; path?: string; module?: string; required?: string[] }[];
    login?: { captcha_type?: string | null; form_detected?: boolean } | null;
    stats?: { pages?: number; pages_registered?: number; apis?: number; controls?: number };
  };
}

export type ExplorationMerge = (input: ExplorationMergeInput) => Promise<ExplorationMergeResult>;

export interface StartExplorationInput {
  targetUrl?: unknown;
  loginUrl?: unknown;
  username?: unknown;
  password?: unknown;
  loginConfig?: unknown;
}

/** 活着的探索进程：只有它存在时 waiting_human 才成立（重启后残留行按中断处理）。 */
interface LiveJob {
  handle: ExplorationRunHandle;
  captchaPath: string | null;
  strategies: string[];
}
const jobs = new Map<string, LiveJob>();

const SELECT = "SELECT * FROM qa_environment_explorations";

export function listExplorations(db: Db, projectId: string, env: string): ExplorationView[] {
  const rows = db
    .prepare(`${SELECT} WHERE project_id=? AND env=? ORDER BY round DESC`)
    .all(projectId, env) as unknown as ExplorationRow[];
  return rows.map((row) => rowToView(db, row));
}

export function latestExploration(db: Db, projectId: string, env: string): ExplorationView | null {
  const row = db
    .prepare(`${SELECT} WHERE project_id=? AND env=? ORDER BY round DESC LIMIT 1`)
    .get(projectId, env) as unknown as ExplorationRow | undefined;
  return row ? rowToView(db, row) : null;
}

/** 派发一轮探索：校验 → 建行 → 后台拉浏览器脚本。立即返回，前端按 status 轮询。 */
export function startExploration(
  deps: ExplorationDeps,
  projectId: string,
  env: string,
  input: StartExplorationInput,
): ExplorationView {
  const environment = findEnvironment(deps.db, projectId, env);
  if (!environment) throw new HttpError(404, "environment_not_found", "环境不存在");
  if (environment.status !== "registered") {
    throw new HttpError(409, "environment_not_registered", "该环境尚未建档（或建档失败），先完成建档再派发探索");
  }
  const latest = latestExploration(deps.db, projectId, env);
  const live = latest ? jobs.get(latest.explorationId) : undefined;
  if (latest && (latest.status === "running" || latest.status === "waiting_human") && live) {
    throw new HttpError(409, "exploration_running", "该环境有一轮探索正在执行，等它结束或先中止");
  }
  if (!deps.engineRoot) {
    throw new HttpError(503, "exploration_unavailable", "服务端未配置 AITEST_ENGINE_ROOT，无法调用探索工具");
  }

  const targetUrl = normalizeTargetUrl(input.targetUrl, environment.baseUrl, projectId);
  const loginUrl = optionalHttpUrl(input.loginUrl, "登录页地址");
  const username = optionalText(input.username, "用户名", 200);
  const password = optionalText(input.password, "密码", 500);
  const loginConfig = parseLoginConfig(input.loginConfig);

  const authenticated = loginUrl !== null && username !== null && password !== null;
  if (loginUrl !== null && !authenticated) {
    throw new HttpError(400, "invalid_login_credentials", "填了登录页地址就要同时给用户名和密码；只探公开页请把登录页地址留空");
  }
  if (authenticated && loginConfig !== null) {
    // 显式配置与登录地址并存时以配置为准，但地址仍决定导航目标 —— 两者不一致是配置错误。
    throw new HttpError(400, "ambiguous_login_config", "登录页地址与显式登录配置只能给一个（配置里不含地址）");
  }

  const round = latest ? latest.round + 1 : 1;
  const explorationId = randomUUID();
  const outDir = path.join(deps.projectDir, "explore", env, `round-${round}`);
  const sessionFile = path.join(deps.projectDir, "explore", env, "session.json");
  const now = new Date().toISOString();
  deps.db
    .prepare(
      `INSERT INTO qa_environment_explorations
         (exploration_id, project_id, env, round, status, target_url, login_url, login_mode,
          steps_json, summary_json, last_error, started_at, finished_at, updated_at)
       VALUES (?,?,?,?,'running',?,?,?,?,NULL,NULL,?,NULL,?)`,
    )
    .run(
      explorationId,
      projectId,
      env,
      round,
      targetUrl,
      authenticated ? loginUrl : null,
      authenticated ? "authenticated" : "public",
      JSON.stringify(initialSteps()),
      now,
      now,
    );

  const run = deps.run ?? spawnExplorationRun(deps.engineRoot);
  const job: LiveJob = { handle: { done: Promise.resolve({ ok: false, error: "未启动" }), answer: async () => {}, abort: () => {} }, captchaPath: null, strategies: [] };
  let handle: ExplorationRunHandle;
  try {
    handle = run({
      targetUrl,
      loginUrl: authenticated ? loginUrl : null,
      username,
      password,
      loginConfig,
      publicMode: !authenticated,
      outDir,
      sessionFile,
      configFile: loginConfig ? path.join(outDir, "login-config.json") : null,
      credsFile: path.join(outDir, "credentials.json"),
      onEvent: (event) => recordEvent(deps.db, explorationId, job, event),
    });
  } catch (error) {
    finishExploration(deps, projectId, env, explorationId, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
    return latestExploration(deps.db, projectId, env) as ExplorationView;
  }
  job.handle = handle;
  jobs.set(explorationId, job);
  const settle = (result: { ok: boolean; error: string | null }): void => {
    try {
      finishExploration(deps, projectId, env, explorationId, result);
    } catch {
      // 进程收尾时库可能已关闭（重启/测试清理）：这一轮的状态留给残留校验去落 failed。
    }
  };
  void handle.done
    .then(settle)
    .catch((error: unknown) => settle({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }));
  return latestExploration(deps.db, projectId, env) as ExplorationView;
}

/** 人工验证码答案：只接受 waiting_human 的那一轮，答案写入脚本等待的 answer 文件。 */
export async function answerCaptcha(
  deps: ExplorationDeps,
  projectId: string,
  env: string,
  explorationId: string,
  answer: unknown,
): Promise<ExplorationView> {
  const row = requireExploration(deps.db, projectId, env, explorationId);
  if (row.status !== "waiting_human") {
    throw new HttpError(409, "exploration_not_waiting", "这一轮当前不在等验证码答案");
  }
  const job = jobs.get(explorationId);
  if (!job) throw new HttpError(409, "exploration_interrupted", "探索进程已不存在（服务重启或已终止）");
  const text = optionalText(answer, "验证码答案", 64);
  if (!text) throw new HttpError(400, "invalid_captcha_answer", "请填写验证码答案");
  await job.handle.answer(text);
  deps.db
    .prepare("UPDATE qa_environment_explorations SET status='running', updated_at=? WHERE exploration_id=?")
    .run(new Date().toISOString(), explorationId);
  return requireView(deps.db, projectId, env, explorationId);
}

/** 人工中止：封存已采部分（status=aborted），不算成功也不算失败。 */
export function abortExploration(
  deps: ExplorationDeps,
  projectId: string,
  env: string,
  explorationId: string,
): ExplorationView {
  const row = requireExploration(deps.db, projectId, env, explorationId);
  if (row.status !== "running" && row.status !== "waiting_human") {
    throw new HttpError(409, "exploration_not_running", "这一轮已经结束，无需中止");
  }
  jobs.get(explorationId)?.handle.abort();
  const now = new Date().toISOString();
  deps.db
    .prepare(
      `UPDATE qa_environment_explorations SET status='aborted', finished_at=?, updated_at=?,
         last_error=? WHERE exploration_id=?`,
    )
    .run(now, now, "操作员中止：已采到的部分随本轮封存，未回写知识层", explorationId);
  settleSteps(deps.db, explorationId, "failed", "操作员中止");
  jobs.delete(explorationId);
  return requireView(deps.db, projectId, env, explorationId);
}

/** 验证码截图：只在 waiting_human 且文件存在时可取（不设缓存、不做图片代理缓存）。 */
export function captchaImagePath(
  deps: ExplorationDeps,
  projectId: string,
  env: string,
  explorationId: string,
): string | null {
  const row = requireExploration(deps.db, projectId, env, explorationId);
  if (row.status !== "waiting_human") return null;
  const job = jobs.get(explorationId);
  const candidate = job?.captchaPath;
  if (!candidate || !existsSync(candidate)) return null;
  return candidate;
}

function requireExploration(db: Db, projectId: string, env: string, explorationId: string): ExplorationRow {
  const row = db
    .prepare(`${SELECT} WHERE project_id=? AND env=? AND exploration_id=?`)
    .get(projectId, env, explorationId) as unknown as ExplorationRow | undefined;
  if (!row) throw new HttpError(404, "exploration_not_found", "探索记录不存在");
  return row;
}

function requireView(db: Db, projectId: string, env: string, explorationId: string): ExplorationView {
  return rowToView(db, requireExploration(db, projectId, env, explorationId));
}

function rowToView(db: Db, row: ExplorationRow): ExplorationView {
  // 服务重启后残留的 running/waiting 行：进程已不在，如实落 failed，不让界面永远转圈。
  if ((row.status === "running" || row.status === "waiting_human") && !jobs.has(row.exploration_id)) {
    const now = new Date().toISOString();
    db.prepare(
      `UPDATE qa_environment_explorations SET status='failed', finished_at=?, updated_at=?, last_error=?
         WHERE exploration_id=? AND (status='running' OR status='waiting_human')`,
    ).run(now, now, "服务重启导致探索中断（浏览器进程已不存在）；本轮未回写知识层", row.exploration_id);
    settleSteps(db, row.exploration_id, "failed", "服务重启中断");
    const refreshed = db.prepare(`${SELECT} WHERE exploration_id=?`).get(row.exploration_id) as unknown as ExplorationRow;
    return viewOf(refreshed);
  }
  return viewOf(row);
}

function viewOf(row: ExplorationRow): ExplorationView {
  const job = jobs.get(row.exploration_id);
  const summary = parseSummary(row.summary_json);
  return {
    explorationId: row.exploration_id,
    round: row.round,
    status: row.status,
    targetUrl: row.target_url,
    loginUrl: row.login_url,
    loginMode: row.login_mode,
    steps: parseSteps(row.steps_json),
    summary,
    lastError: row.last_error,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    captcha: row.status === "waiting_human" && job?.captchaPath
      ? { available: true, strategies: job.strategies }
      : row.status === "waiting_human"
        ? { available: false, strategies: [] }
        : null,
  };
}

function initialSteps(): ExplorationStep[] {
  return EXPLORATION_STEP_NAMES.map((name, offset) => ({
    index: offset + 1,
    name,
    // 第 1 步（准备配置）在派发时就已完成：配置写盘是同步的。
    status: offset === 0 ? "done" : offset === 1 ? "running" : "idle",
    detail: offset === 0 ? "登录配置与凭据已就位（凭据不落库，结束即删）" : null,
  }));
}

const STEP_STATUSES: readonly ExplorationStepStatus[] = ["idle", "running", "done", "failed"];

function parseSteps(raw: string | null): ExplorationStep[] {
  const stored = new Map<number, Partial<ExplorationStep>>();
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (item && typeof item === "object" && typeof (item as { index?: unknown }).index === "number") {
            stored.set((item as { index: number }).index, item as Partial<ExplorationStep>);
          }
        }
      }
    } catch {
      // 坏 JSON 按「没报过进度」处理
    }
  }
  return EXPLORATION_STEP_NAMES.map((fallbackName, offset) => {
    const index = offset + 1;
    const hit = stored.get(index);
    const status = hit && typeof hit.status === "string" && (STEP_STATUSES as readonly string[]).includes(hit.status)
      ? (hit.status as ExplorationStepStatus)
      : "idle";
    return {
      index,
      name: typeof hit?.name === "string" && hit.name ? hit.name : fallbackName,
      status,
      detail: typeof hit?.detail === "string" && hit.detail ? hit.detail : null,
    };
  });
}

function recordEvent(db: Db, explorationId: string, job: LiveJob, event: ExplorationEvent): void {
  try {
    if (event.kind === "step") {
      const row = db.prepare(`${SELECT} WHERE exploration_id=?`).get(explorationId) as unknown as ExplorationRow | undefined;
      if (!row) return;
      const steps = parseSteps(row.steps_json);
      const target = steps.find((step) => step.index === event.index);
      if (!target) return;
      const status = (STEP_STATUSES as readonly string[]).includes(event.status)
        ? (event.status as ExplorationStepStatus)
        : target.status;
      const next = steps.map((step) => (step.index === target.index
        ? { ...step, status, detail: event.detail ?? step.detail }
        : step));
      db.prepare("UPDATE qa_environment_explorations SET steps_json=?, updated_at=? WHERE exploration_id=?")
        .run(JSON.stringify(next), new Date().toISOString(), explorationId);
      return;
    }
    if (event.kind === "captcha") {
      if (event.path) job.captchaPath = event.path;
      if (event.strategies) job.strategies = event.strategies;
      const status: ExplorationStatus | null = event.status === "waiting"
        ? "waiting_human"
        : event.status === "answered" ? "running" : null;
      if (status) {
        db.prepare("UPDATE qa_environment_explorations SET status=?, updated_at=? WHERE exploration_id=?")
          .run(status, new Date().toISOString(), explorationId);
      }
    }
  } catch {
    // 进度写库失败不能中断探索：进度是可丢的播报，结论才是要紧的。
  }
}

function settleSteps(db: Db, explorationId: string, status: ExplorationStepStatus, detail: string): void {
  const row = db.prepare(`${SELECT} WHERE exploration_id=?`).get(explorationId) as unknown as ExplorationRow | undefined;
  if (!row?.steps_json) return;
  const steps = parseSteps(row.steps_json);
  if (!steps.some((step) => step.status === "running")) return;
  const next = steps.map((step) => (step.status !== "running" ? step : { ...step, status, detail: step.detail ?? detail }));
  db.prepare("UPDATE qa_environment_explorations SET steps_json=? WHERE exploration_id=?")
    .run(JSON.stringify(next), explorationId);
}

function finishExploration(
  deps: ExplorationDeps,
  projectId: string,
  env: string,
  explorationId: string,
  result: { ok: boolean; error: string | null },
): void {
  const job = jobs.get(explorationId);
  jobs.delete(explorationId);
  const row = deps.db.prepare(`${SELECT} WHERE exploration_id=?`).get(explorationId) as unknown as ExplorationRow | undefined;
  if (!row) return;
  // 中止已经落库的轮次：不再改状态（结论以操作员中止为准），只清掉活动进程。
  if (row.status === "aborted") return;
  const now = new Date().toISOString();
  if (!result.ok) {
    deps.db
      .prepare(
        `UPDATE qa_environment_explorations SET status='failed', last_error=?, finished_at=?, updated_at=?
           WHERE exploration_id=?`,
      )
      .run(result.error ?? "探索失败", now, now, explorationId);
    settleSteps(deps.db, explorationId, "failed", result.error ?? "探索失败");
    // 凭据临时文件必须删掉：失败也要删。
    void removeCredentials(deps, row, job);
    return;
  }
  // 成功：先合并 maps 再写知识；任何一步失败都落 failed，不写半份知识冒充成功。
  void completeSuccess(deps, projectId, env, row).catch((error: unknown) => {
    try {
    const stamp = new Date().toISOString();
    deps.db
      .prepare(
        `UPDATE qa_environment_explorations SET status='failed', last_error=?, finished_at=?, updated_at=?
           WHERE exploration_id=?`,
      )
      .run(
        `探索已完成，但合并/回写失败：${error instanceof Error ? error.message : String(error)}`,
        stamp,
        stamp,
        explorationId,
      );
    settleSteps(deps.db, explorationId, "failed", "合并回写失败");
    } catch {
      // 库已关闭：同上，交给残留校验。
    }
  }).finally(() => {
    void removeCredentials(deps, row, job);
  });
}

async function completeSuccess(
  deps: ExplorationDeps,
  projectId: string,
  env: string,
  row: ExplorationRow,
): Promise<void> {
  const outDir = path.join(deps.projectDir, "explore", env, `round-${row.round}`);
  const receipt = readJsonFile<Record<string, unknown>>(path.join(outDir, "explore-receipt.json")) ?? {};
  const route = routeOf(row.target_url);
  const engineRoot = deps.engineRoot;
  if (!engineRoot) throw new HttpError(503, "exploration_unavailable", "服务端未配置 AITEST_ENGINE_ROOT");
  const merge = deps.merge ?? pythonMerge(engineRoot);
  const merged = await merge({ projectId, env, targetRoute: route, exploreDir: outDir, engineRoot });

  const layers = deriveKnowledge(merged.maps);
  for (const layer of layers) {
    replaceKnowledgeLayer(deps.db, projectId, env, layer.layer, layer.entries, { round: row.round, sessionId: null });
  }
  // B1 联动：探索资产同步进项目资料知识库。失败不改探索结论——
  // 探索的契约（合并 + 四层回写）已完成，联动失败如实记进摘要。
  let knowledgeBuild: ExplorationKnowledgeBuildInfo | { error: string } | null = null;
  if (deps.knowledgeSync) {
    try {
      knowledgeBuild = await deps.knowledgeSync({
        projectId, env, round: row.round, targetUrl: row.target_url, layers,
      });
    } catch (error) {
      knowledgeBuild = { error: error instanceof Error ? error.message : String(error) };
    }
  }
  const summary: ExplorationSummary = {
    targetUrl: row.target_url,
    mode: receipt.mode === "site" ? "site" : receipt.mode === "page" ? "page" : null,
    controls: numberOrNull(receipt.controls),
    tables: numberOrNull(receipt.tables),
    apis: numberOrNull(receipt.apis),
    pagesOk: numberOrNull(receipt.pages_ok),
    pagesFailed: numberOrNull(receipt.pages_failed),
    structureDigest: typeof receipt.structure_digest === "string" ? receipt.structure_digest : null,
    sessionReused: typeof receipt.session_reused === "boolean" ? receipt.session_reused : null,
    mapsPath: merged.mapsPath,
    knowledgeLayers: layers.map((layer) => layer.layer),
    captchaStrategy: typeof receipt.captcha_strategy === "string" ? receipt.captcha_strategy : null,
    limitations: Array.isArray(receipt.limitations)
      ? receipt.limitations.filter((item): item is string => typeof item === "string")
      : [],
    knowledgeBuild,
  };
  const now = new Date().toISOString();
  deps.db
    .prepare(
      `UPDATE qa_environment_explorations SET status='succeeded', summary_json=?, last_error=NULL,
         finished_at=?, updated_at=? WHERE exploration_id=?`,
    )
    .run(JSON.stringify(summary), now, now, row.exploration_id);
  const steps = parseSteps(row.steps_json);
  const done = steps.map((step) => ({ ...step, status: "done" as ExplorationStepStatus, detail: step.detail ?? null }));
  deps.db
    .prepare("UPDATE qa_environment_explorations SET steps_json=? WHERE exploration_id=?")
    .run(JSON.stringify(done), row.exploration_id);
}

/** maps IR → 四层知识。只写本轮真能派生的层；flow 需要多页遍历，单页探索给不出就不写。 */
export function deriveKnowledge(maps: ExplorationMergeResult["maps"]): { layer: KnowledgeLayer; entries: KnowledgeEntryInput[] }[] {
  const layers: { layer: KnowledgeLayer; entries: KnowledgeEntryInput[] }[] = [];
  const pages = Array.isArray(maps.pages) ? maps.pages : [];
  const apis = Array.isArray(maps.apis) ? maps.apis : [];

  if (pages.length > 0) {
    layers.push({
      layer: "module",
      entries: pages.slice(0, 200).map((page) => ({
        key: (page.route ?? "/").slice(0, 128),
        summary: `${page.registered ? "已渲染" : "仅路由·未采控件"} · ${page.control_count ?? 0} 控件`,
      })),
    });
  }
  if (apis.length > 0) {
    layers.push({
      layer: "interface",
      entries: apis.slice(0, 500).map((api) => ({
        key: `${(api.method ?? "GET").toUpperCase()} ${api.path ?? "/"}`.slice(0, 128),
        // 必填参数名列出来而不是只给个数：知识项、项目资料页都直接可用。
        summary: `模块 ${api.module ?? "default"}${api.required?.length ? ` · 必填 ${api.required.join("、")}` : ""}`,
      })),
    });
  }
  const login = maps.login ?? null;
  if (login && (login.captcha_type || login.form_detected)) {
    const wallEntries: KnowledgeEntryInput[] = [];
    if (login.captcha_type && login.captcha_type !== "none") {
      wallEntries.push({ key: "login-captcha", summary: `登录图形码类型：${login.captcha_type}（策略链：测试码→算术识别→已配置服务→代理视觉自动识别）` });
    }
    if (login.form_detected) {
      wallEntries.push({ key: "login-required", summary: "业务页需登录：未登录访问会被重定向到登录页" });
    }
    if (wallEntries.length > 0) layers.push({ layer: "wall", entries: wallEntries });
  }
  return layers;
}

function parseSummary(raw: string | null): ExplorationSummary | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as ExplorationSummary) : null;
  } catch {
    return null;
  }
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readJsonFile<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

/** 目标路由：去掉协议与域名，去前导斜杠（合并脚本自己补，避免 Windows 路径改写）。 */
export function routeOf(targetUrl: string): string {
  try {
    const url = new URL(targetUrl);
    return url.pathname.replace(/^\/+/, "") || "";
  } catch {
    return "";
  }
}

function normalizeTargetUrl(value: unknown, baseUrl: string, projectId: string): string {
  if (value === undefined || value === null || value === "") return baseUrl;
  if (typeof value !== "string") throw new HttpError(400, "invalid_exploration_target", "目标页地址格式无效");
  const trimmed = value.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new HttpError(400, "invalid_exploration_target", "目标页地址必须是完整 URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new HttpError(400, "invalid_exploration_target", "目标页地址只支持 http / https");
  }
  if (url.username || url.password) {
    throw new HttpError(400, "invalid_exploration_target", "目标页地址不要内嵌账号口令");
  }
  // 站内子域允许（受控站点常见 local./pre. 前缀差异）；是否跨站由派发人自己判断，
  // 这里只保证地址本身是合法的 http(s)，且 baseUrl 仅作默认值。
  void baseUrl;
  void projectId;
  url.hash = "";
  return url.toString();
}

function optionalHttpUrl(value: unknown, label: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new HttpError(400, "invalid_exploration_login", `${label}格式无效`);
  const trimmed = value.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new HttpError(400, "invalid_exploration_login", `${label}必须是完整 URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new HttpError(400, "invalid_exploration_login", `${label}只支持 http / https`);
  }
  return url.toString();
}

function optionalText(value: unknown, label: string, max: number): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new HttpError(400, "invalid_exploration_input", `${label}格式无效`);
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > max) throw new HttpError(400, "invalid_exploration_input", `${label}过长`);
  return trimmed;
}

function parseLoginConfig(value: unknown): Record<string, unknown> | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "invalid_login_config", "登录配置必须是对象");
  }
  return value as Record<string, unknown>;
}

/**
 * 构造探索脚本 argv。
 * 无值开关（--discover-login / --public）必须放末尾：老版脚本按 i+=2 两两配对，
 * 若后面还有 --mode site 会把 site 当 key 报 "Unexpected argument site"（全站模式首次实跑撞到）。
 * 新脚本已支持无值 flag，此处仍保持兼容。
 */
export function buildExplorationArgv(
  input: Pick<ExplorationRunInput, "targetUrl" | "loginUrl" | "credsFile" | "outDir" | "sessionFile" | "configFile" | "publicMode">,
  script: string,
): string[] {
  const argv = [
    script,
    "--login-url", input.loginUrl ?? input.targetUrl,
    "--target-url", input.targetUrl,
    "--creds", input.credsFile,
    "--out", input.outDir,
    "--session", input.sessionFile,
    "--captcha-strategy", "auto",
  ];
  if (input.configFile) argv.push("--config", input.configFile);
  // 登录态探索默认全站模式：登录后按路由清单逐页采集（项目地图是测试任务的打底资料）。
  if (!input.publicMode) argv.push("--mode", "site");
  if (!input.configFile) argv.push("--discover-login");
  if (input.publicMode) argv.push("--public");
  return argv;
}

/**
 * 生产执行器：写配置/凭据临时文件 → spawn node 跑探索脚本 → 逐行解析 @@ 事件。
 * 凭据文件 0600、结束即删；stdout 只留尾巴用于解释失败原因。
 */
export function spawnExplorationRun(engineRoot: string): ExplorationRun {
  return (input) => {
    let child: ChildProcessWithoutNullStreams | null = null;
    let aborted = false;
    let answerPath: string | null = null;
    let stdoutTail = "";
    let stderrTail = "";
    const done = (async (): Promise<{ ok: boolean; error: string | null }> => {
      await fs.mkdir(input.outDir, { recursive: true });
      if (input.configFile && input.loginConfig) {
        await fs.writeFile(input.configFile, JSON.stringify(input.loginConfig, null, 2), { mode: 0o600 });
      }
      await fs.writeFile(
        input.credsFile,
        JSON.stringify({ username: input.username ?? "", password: input.password ?? "" }),
        { mode: 0o600 },
      );
      answerPath = path.join(input.outDir, "answer.json");
      const script = path.join(engineRoot, "scripts", "explore-authenticated.mjs");
      const argv = buildExplorationArgv(input, script);
      child = spawn(process.execPath, argv, { cwd: engineRoot, windowsHide: true });
      let pending = "";
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        stdoutTail = (stdoutTail + chunk).slice(-4_000);
      });
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk: string) => {
        pending += chunk;
        const lines = pending.split(/\r?\n/);
        pending = lines.pop() ?? "";
        for (const line of lines) {
          const text = line.trim();
          if (!text) continue;
          if (text.startsWith("@@step ")) {
            const event = parseEventLine("step", text.slice("@@step ".length));
            if (event) input.onEvent(event);
            continue;
          }
          if (text.startsWith("@@captcha ")) {
            const event = parseEventLine("captcha", text.slice("@@captcha ".length));
            if (event) input.onEvent(event);
            continue;
          }
          stderrTail = (stderrTail + text + "\n").slice(-2_000);
        }
      });
      const code = await new Promise<number | null>((resolve) => {
        child?.on("error", () => resolve(-1));
        child?.on("close", (exitCode) => resolve(exitCode));
      });
      if (aborted) return { ok: false, error: "操作员中止" };
      if (code !== 0) {
        const why = lastFailureMessage(stdoutTail) ?? (stderrTail.trim() || "探索脚本以非零状态退出");
        return { ok: false, error: why };
      }
      return { ok: true, error: null };
    })();
    return {
      done,
      async answer(answer: string) {
        if (!answerPath) throw new Error("探索进程尚未进入等待状态");
        await fs.writeFile(answerPath, JSON.stringify({ answer }));
      },
      abort() {
        aborted = true;
        child?.kill();
      },
    };
  };
}

function parseEventLine(kind: "step" | "captcha", raw: string): ExplorationEvent | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    if (kind === "step") {
      const index = (parsed as { index?: unknown }).index;
      const status = (parsed as { status?: unknown }).status;
      if (typeof index !== "number" || typeof status !== "string") return null;
      return { kind: "step", index, status, detail: typeof (parsed as { detail?: unknown }).detail === "string" ? (parsed as { detail: string }).detail : undefined };
    }
    const status = (parsed as { status?: unknown }).status;
    if (status !== "waiting" && status !== "auto_solved" && status !== "unresolved" && status !== "answered") return null;
    return {
      kind: "captcha",
      status,
      path: typeof (parsed as { path?: unknown }).path === "string" ? (parsed as { path: string }).path : undefined,
      strategies: Array.isArray((parsed as { strategies?: unknown }).strategies)
        ? ((parsed as { strategies: unknown[] }).strategies.filter((x): x is string => typeof x === "string"))
        : undefined,
    };
  } catch {
    return null;
  }
}

function lastFailureMessage(stdoutTail: string): string | null {
  const lines = stdoutTail.split(/\r?\n/).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const line = lines[i];
      if (!line) continue;
      const parsed = JSON.parse(line) as { msg?: string; data?: { error?: string } };
      if (parsed.msg === "failed" && parsed.data?.error) return parsed.data.error;
    } catch {
      // 非 JSON 行跳过
    }
  }
  return null;
}

/** 生产合并器：python merge-explore-maps.py → 读 maps-<env>.json。 */
export function pythonMerge(engineRoot: string): ExplorationMerge {
  return async ({ projectId, env, targetRoute, exploreDir }) => {
    const python = process.env.AITEST_PYTHON ?? (process.platform === "win32" ? "python" : "python3");
    const script = path.join(engineRoot, "scripts", "merge-explore-maps.py");
    const argv = [
      script,
      "--project", projectId,
      "--env", env,
      "--target-route", targetRoute,
      "--explore-dir", exploreDir,
    ];
    // 全站探索产物存在时按多页登记；没有就是单页口径，行为不变。
    const pagesFile = path.join(exploreDir, "pages.json");
    if (existsSync(pagesFile)) argv.push("--pages", pagesFile);
    const child = spawn(python, argv, {
      cwd: engineRoot,
      env: {
        ...process.env,
        PYTHONPATH: [path.join(engineRoot, "aitestharness-tools"), process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
        PYTHONUTF8: "1",
        PYTHONIOENCODING: "utf-8",
      },
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => { stdout = (stdout + chunk).slice(-4_000); });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-2_000); });
    const code = await new Promise<number | null>((resolve) => {
      child.on("error", () => resolve(-1));
      child.on("close", (exitCode) => resolve(exitCode));
    });
    if (code !== 0) {
      throw new Error(`合并 maps 失败（python 退出码 ${code}）：${(stderr || stdout).trim().slice(-400) || "无输出"}`);
    }
    const mapsFile = path.join(exploreDir, `maps-${env}.json`);
    const parsed = readJsonFile<ExplorationMergeResult["maps"]>(mapsFile);
    if (!parsed) throw new Error("合并完成但未找到 maps 文件");
    return { mapsPath: path.relative(path.dirname(exploreDir), mapsFile).split(path.sep).join("/"), maps: parsed };
  };
}

async function removeCredentials(deps: ExplorationDeps, row: ExplorationRow, job: LiveJob | undefined): Promise<void> {
  void job;
  // 凭据文件按轮目录定位：路径可由行推出，不依赖内存里的 job（重启后也要能删）。
  const file = path.join(deps.projectDir, "explore", row.env, `round-${row.round}`, "credentials.json");
  try {
    await fs.unlink(file);
  } catch {
    // 文件可能本来就没写成（进程启动前就失败了）：删除失败不改变结论。
  }
}
