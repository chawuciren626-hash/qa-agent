/**
 * 被测环境（environment）——B1 的落点：地址归环境，不归项目。
 *
 * 为什么单独成表而不是给 project_management 加两列：maps 路径、run 的 env、一 plan
 * 多 variant 全部以 (project, env) 为键，一个项目一个地址的模型撑不到多环境回归。
 *
 * 建档走 Python 的确定性入口 `runtime_cli onboard.bootstrap`（零 LLM），不是 run 内的
 * 阶段工具——建档发生在任何 run 之前，没有 run/stage 可挂。产物落在项目目录
 * `maps/<env>/`，同时把摘要写回本表供列表与详情页读取。
 *
 * 诚实边界：失败只写 failed + last_error，绝不写 registered + pages=0。NULL 表示
 * "没跑过"，0 表示"跑过且确实一个也没有"，两者在 UI 上是不同的字。
 */
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import type { Db } from "../hmr/capabilities.js";
import { HttpError } from "../http/errors.js";

/** 环境标识：小写字母开头，只含小写字母/数字/下划线/连字符。 */
const ENV_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
/** 建档默认超时：Python 侧对 bundle 有硬限流（12 个 × 10s），留足余量。 */
const BOOTSTRAP_TIMEOUT_MS = 120_000;

export interface EnvironmentRow {
  project_id: string;
  env: string;
  base_url: string;
  is_default: number;
  status: "unregistered" | "probing" | "registered" | "failed";
  pages_total: number | null;
  pages_registered: number | null;
  apis_total: number | null;
  api_modules: string | null;
  login_captcha: string | null;
  maps_path: string | null;
  report_path: string | null;
  last_error: string | null;
  probed_at: string | null;
  steps_json: string | null;
  created_at: string;
  revision: number;
}

/**
 * 建档五步的固定清单，与 Python `onboard/bootstrap.py` 的 STEP_NAMES 一一对应。
 *
 * 为什么在 TS 侧也留一份：前端在建档开始之前就要画出五行占位，那时还没有任何
 * Python 事件可读。事件里带 name 时以事件为准（Python 是唯一真源），这里只是
 * 首帧的占位文案。
 */
export const BOOTSTRAP_STEP_NAMES = [
  "可达性探测",
  "抓取前端骨架",
  "提取路由",
  "探测登录与接口",
  "生成环境档案",
] as const;

/** idle 没到这一步 / running 正在做 / done 做完了 / failed 在这步失败。 */
export type BootstrapStepStatus = "idle" | "running" | "done" | "failed";

export interface BootstrapStep {
  index: number;
  name: string;
  status: BootstrapStepStatus;
  /** 已结束步骤的耗时毫秒；没有报过耗时就是 null，不写 0 冒充"瞬间完成"。 */
  ms: number | null;
  /** 人话结论（"HTTP 200" / "12 页 / 34 接口"）；没报就是 null。 */
  detail: string | null;
  /** 结构化事实（bytes / count / finalUrl…），供展开看细节。 */
  facts: Record<string, unknown>;
}

export interface EnvironmentView {
  env: string;
  baseUrl: string;
  isDefault: boolean;
  status: EnvironmentRow["status"];
  /** 没跑过时这三个字段是 null，不是 0。 */
  pages: { total: number; registered: number } | null;
  apis: { total: number; modules: string[] } | null;
  loginCaptcha: string | null;
  probedAt: string | null;
  lastError: string | null;
  mapsPath: string | null;
  reportPath: string | null;
  /** 固定五行，按 index 升序；没跑过的步骤 status=idle。 */
  steps: BootstrapStep[];
  revision: number;
}

function rowToView(row: EnvironmentRow): EnvironmentView {
  return {
    env: row.env,
    baseUrl: row.base_url,
    isDefault: row.is_default === 1,
    status: row.status,
    pages: row.pages_total === null ? null : {
      total: row.pages_total,
      registered: row.pages_registered ?? 0,
    },
    apis: row.apis_total === null ? null : {
      total: row.apis_total,
      modules: parseModules(row.api_modules),
    },
    loginCaptcha: row.login_captcha,
    probedAt: row.probed_at,
    lastError: row.last_error,
    mapsPath: row.maps_path,
    reportPath: row.report_path,
    steps: parseSteps(row.steps_json),
    revision: row.revision,
  };
}

const STEP_STATUSES: readonly BootstrapStepStatus[] = ["idle", "running", "done", "failed"];

/**
 * 把 steps_json 铺成固定五行。
 *
 * 只接受已知的 index 与 status：Python 那边加了新步骤而这里没跟上时，多出来的
 * 事件要被丢掉（不能凭空多一行），缺的步骤补 idle（不能少一行）。
 */
function parseSteps(raw: string | null): BootstrapStep[] {
  const stored = new Map<number, Record<string, unknown>>();
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (item && typeof item === "object" && typeof (item as { index?: unknown }).index === "number") {
            stored.set((item as { index: number }).index, item as Record<string, unknown>);
          }
        }
      }
    } catch {
      // 坏 JSON 当作"还没报过进度"：不做半解析的猜测。
    }
  }
  return BOOTSTRAP_STEP_NAMES.map((fallbackName, offset) => {
    const index = offset + 1;
    const hit = stored.get(index);
    const status = hit && typeof hit.status === "string" && (STEP_STATUSES as readonly string[]).includes(hit.status)
      ? (hit.status as BootstrapStepStatus)
      : "idle";
    return {
      index,
      name: typeof hit?.name === "string" && hit.name ? hit.name : fallbackName,
      status,
      ms: typeof hit?.ms === "number" ? hit.ms : null,
      detail: typeof hit?.detail === "string" && hit.detail ? hit.detail : null,
      facts: hit && typeof hit.facts === "object" && hit.facts !== null && !Array.isArray(hit.facts)
        ? (hit.facts as Record<string, unknown>)
        : {},
    };
  });
}

function parseModules(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

const SELECT = "SELECT * FROM project_environments WHERE project_id=?";

export function listEnvironments(db: Db, projectId: string): EnvironmentView[] {
  const rows = db.prepare(`${SELECT} ORDER BY is_default DESC, env`).all(projectId) as unknown as EnvironmentRow[];
  return rows.map(rowToView);
}

export function findEnvironment(db: Db, projectId: string, env: string): EnvironmentView | null {
  const row = db.prepare(`${SELECT} AND env=?`).get(projectId, env) as unknown as EnvironmentRow | undefined;
  return row ? rowToView(row) : null;
}

/** 项目的默认环境（列表/详情页展示用）；没有环境时返回 null——不是空对象。 */
export function defaultEnvironment(db: Db, projectId: string): EnvironmentView | null {
  const row = db
    .prepare(`${SELECT} ORDER BY is_default DESC, created_at LIMIT 1`)
    .get(projectId) as unknown as EnvironmentRow | undefined;
  return row ? rowToView(row) : null;
}

/** 地址校验：只允许 http(s)，且不允许指向云元数据端点（那是抓别人凭据的口子）。 */
export function normalizeBaseUrl(value: unknown): string {
  if (typeof value !== "string") throw new HttpError(400, "invalid_environment_url", "环境地址格式无效");
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 2048) throw new HttpError(400, "invalid_environment_url", "环境地址长度无效");
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new HttpError(400, "invalid_environment_url", "环境地址必须是完整 URL，例如 http://gateway.example.com");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new HttpError(400, "invalid_environment_url", "环境地址只支持 http / https");
  }
  if (url.username || url.password) {
    throw new HttpError(400, "invalid_environment_url", "环境地址不要内嵌账号口令，凭据请走登录配置");
  }
  if (isMetadataEndpoint(url.hostname)) {
    throw new HttpError(400, "invalid_environment_url", "环境地址指向云元数据端点，已拒绝");
  }
  // 保留路径：有些系统的入口本来就在 /admin 这类子路径上。
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function isMetadataEndpoint(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "169.254.169.254" || host === "metadata.google.internal" || host === "[fd00:ec2::254]";
}

export function normalizeEnvName(value: unknown): string {
  if (value === undefined || value === null || value === "") return "test";
  if (typeof value !== "string") throw new HttpError(400, "invalid_environment_name", "环境标识格式无效");
  const trimmed = value.trim();
  if (!ENV_PATTERN.test(trimmed)) {
    throw new HttpError(400, "invalid_environment_name", "环境标识需以小写字母开头，只含小写字母、数字、下划线或连字符（≤32 位）");
  }
  return trimmed;
}

/**
 * 写入或更新一个环境。首个环境自动成为默认环境；改成默认时把同项目其它环境降级
 * （默认环境是"进项目时看哪个"的展示约定，必须唯一）。
 */
export function upsertEnvironment(
  db: Db,
  projectId: string,
  input: { env?: unknown; baseUrl: unknown; isDefault?: boolean },
): EnvironmentView {
  const env = normalizeEnvName(input.env);
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  const existing = findEnvironment(db, projectId, env);
  const hasDefault = (db.prepare(`${SELECT} AND is_default=1`).get(projectId) as unknown) !== undefined;
  const isDefault = input.isDefault === true || (!existing && !hasDefault);
  const now = new Date().toISOString();
  if (isDefault) {
    // 默认环境全局唯一：先把同项目其它环境的标志降级，再把本环境升上去。
    db.prepare("UPDATE project_environments SET is_default=0 WHERE project_id=? AND is_default=1").run(projectId);
  }
  if (existing) {
    db.prepare(
      "UPDATE project_environments SET base_url=?, is_default=?, revision=revision+1 WHERE project_id=? AND env=?",
    ).run(baseUrl, isDefault ? 1 : 0, projectId, env);
    // 地址变了，旧摘要就不再描述这个地址：清空，等下一次建档重新填。
    if (existing.baseUrl !== baseUrl) {
      db.prepare(
        `UPDATE project_environments SET status='unregistered', pages_total=NULL, pages_registered=NULL,
           apis_total=NULL, api_modules=NULL, login_captcha=NULL, maps_path=NULL, report_path=NULL,
           last_error=NULL, probed_at=NULL, steps_json=NULL WHERE project_id=? AND env=?`,
      ).run(projectId, env);
    }
  } else {
    db.prepare(
      `INSERT INTO project_environments (project_id,env,base_url,is_default,status,created_at)
       VALUES (?,?,?,?,'unregistered',?)`,
    ).run(projectId, env, baseUrl, isDefault ? 1 : 0, now);
  }
  return findEnvironment(db, projectId, env) as EnvironmentView;
}

export interface BootstrapDeps {
  db: Db;
  /** 项目目录的绝对路径（maps 落在这里的 maps/<env>/ 下）。 */
  projectDir: string;
  /** 引擎仓库根目录：Python 包与脚本都在它下面。 */
  engineRoot: string | undefined;
  /** 注入点：测试里替换成假的执行器，生产走子进程。 */
  run?: BootstrapRun;
}

/** 建档执行结果：Python 侧的原始返回，字段透传，不做二次加工。 */
export interface BootstrapRunResult {
  ok: boolean;
  error: string | null;
  report: {
    pages?: { total?: number; registered?: number };
    apis?: { count?: number; modules?: string[] };
    login?: { captcha_type?: string | null };
    warnings?: string[];
  } | null;
  paths?: { maps: string; report: string } | null;
}

export type BootstrapRun = (input: {
  projectId: string; env: string; baseUrl: string; outDir: string;
  /**
   * 进度播报：Python 每写一行 `@@step {...}` 就回调一次。可丢（调用方写库失败
   * 不影响建档结论），但不可用来做判断——结论只看 BootstrapRunResult。
   */
  onStep?: (step: BootstrapStepEvent) => void;
}) => Promise<BootstrapRunResult>;

/** Python 侧原样上报的单步事件；字段可能缺，缺的按"没报"处理。 */
export interface BootstrapStepEvent {
  index: number;
  name?: string;
  status?: string;
  ms?: number;
  detail?: string;
  facts?: Record<string, unknown>;
}

/**
 * 触发建档：先把状态置 probing 并立刻返回，再在后台跑 Python。
 *
 * 同步返回而不是等 Python 跑完：建档最长两分钟，卡在 HTTP 请求里会让前端超时，
 * 也会拖垮代理层的连接池。前端按 status 轮询拿结果。
 */
export function startBootstrap(deps: BootstrapDeps, projectId: string, env: string): EnvironmentView {
  const current = findEnvironment(deps.db, projectId, env);
  if (!current) throw new HttpError(404, "environment_not_found", "环境不存在");
  if (current.status === "probing") throw new HttpError(409, "environment_probing", "该环境正在建档，请等待当前任务结束");
  if (!deps.engineRoot) {
    throw new HttpError(503, "bootstrap_unavailable", "服务端未配置 AITEST_ENGINE_ROOT，无法调用建档工具");
  }
  const outDir = path.join(deps.projectDir, "maps", env);
  // 新一轮从零开始：上一轮的步骤进度不能残留成"这轮已经跑到第几步"。
  deps.db.prepare(
    `UPDATE project_environments SET status='probing', last_error=NULL, steps_json=NULL,
       revision=revision+1 WHERE project_id=? AND env=?`,
  ).run(projectId, env);
  const run = deps.run ?? pythonBootstrapRun(deps.engineRoot);
  const onStep = (step: BootstrapStepEvent): void => recordStep(deps.db, projectId, env, step);
  // 不 await：后台跑，结果写回同一行。任何异常都必须落成 failed，不能留在 probing
  // 让 UI 永远转圈，也不能吞掉错误假装成功。
  void run({ projectId, env, baseUrl: current.baseUrl, outDir, onStep })
    .then((result) => finishBootstrap(deps, projectId, env, result))
    .catch((error: unknown) => finishBootstrap(deps, projectId, env, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      report: null,
      paths: null,
    }));
  return findEnvironment(deps.db, projectId, env) as EnvironmentView;
}

/** 把一次 step 事件合并进 steps_json（只动进度列：不碰 revision，不碰结论字段）。 */
function recordStep(db: Db, projectId: string, env: string, event: BootstrapStepEvent): void {
  const row = db.prepare(`${SELECT} AND env=?`).get(projectId, env) as unknown as EnvironmentRow | undefined;
  if (!row) return; // 环境在跑的过程中被删了：没有可写的地方，静默结束。
  const steps = parseSteps(row.steps_json);
  const target = steps.find((step) => step.index === event.index);
  if (!target) return; // 未知步骤号：宁可丢，不能凭空多一行。
  const status = typeof event.status === "string" && (STEP_STATUSES as readonly string[]).includes(event.status)
    ? (event.status as BootstrapStepStatus)
    : target.status;
  const merged: BootstrapStep = {
    index: target.index,
    name: typeof event.name === "string" && event.name ? event.name : target.name,
    status,
    ms: typeof event.ms === "number" ? event.ms : target.ms,
    detail: typeof event.detail === "string" && event.detail ? event.detail : target.detail,
    facts: event.facts && typeof event.facts === "object" && !Array.isArray(event.facts)
      ? event.facts
      : target.facts,
  };
  const next = steps.map((step) => (step.index === merged.index ? merged : step));
  db.prepare("UPDATE project_environments SET steps_json=? WHERE project_id=? AND env=?")
    .run(JSON.stringify(next), projectId, env);
}

/** 等待当前环境的建档结束（测试与 CLI 用；生产 UI 走轮询）。 */
export async function awaitBootstrap(deps: BootstrapDeps, projectId: string, env: string): Promise<EnvironmentView> {
  const deadline = Date.now() + BOOTSTRAP_TIMEOUT_MS + 5_000;
  while (Date.now() < deadline) {
    const view = findEnvironment(deps.db, projectId, env);
    if (!view) throw new HttpError(404, "environment_not_found", "环境不存在");
    if (view.status !== "probing") return view;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new HttpError(504, "environment_probing_timeout", "建档超时，请稍后在环境页查看结果");
}

function finishBootstrap(deps: BootstrapDeps, projectId: string, env: string, result: BootstrapRunResult): void {
  const projectRoot = deps.projectDir;
  finalizeSteps(deps.db, projectId, env, result);
  const relative = (target: string | undefined): string | null => {
    if (!target) return null;
    const rel = path.relative(projectRoot, target);
    return rel.startsWith("..") ? null : rel.split(path.sep).join("/");
  };
  if (result.ok) {
    const pages = result.report?.pages ?? {};
    const apis = result.report?.apis ?? {};
    deps.db.prepare(
      `UPDATE project_environments SET status='registered', pages_total=?, pages_registered=?, apis_total=?,
         api_modules=?, login_captcha=?, maps_path=?, report_path=?, last_error=NULL, probed_at=?,
         revision=revision+1 WHERE project_id=? AND env=?`,
    ).run(
      typeof pages.total === "number" ? pages.total : null,
      typeof pages.registered === "number" ? pages.registered : null,
      typeof apis.count === "number" ? apis.count : null,
      JSON.stringify(Array.isArray(apis.modules) ? apis.modules : []),
      result.report?.login?.captcha_type ?? null,
      relative(result.paths?.maps),
      relative(result.paths?.report),
      new Date().toISOString(),
      projectId,
      env,
    );
    return;
  }
  // 失败：清空摘要（上一轮的页面数不再代表这个地址），只留原因。
  deps.db.prepare(
    `UPDATE project_environments SET status='failed', pages_total=NULL, pages_registered=NULL, apis_total=NULL,
       api_modules=NULL, login_captcha=NULL, maps_path=NULL, report_path=NULL, last_error=?,
       probed_at=?, revision=revision+1 WHERE project_id=? AND env=?`,
  ).run(result.error ?? "建档失败", new Date().toISOString(), projectId, env);
}

/**
 * 收尾：把"结束这一刻还挂在 running 的步骤"落定。
 *
 * Python 报了结论却漏发某步的 done（或进程死在半路）时，UI 不能留一个永远转的圈：
 * 整体成功 → done，整体失败 → failed（并把失败原因写进这一步的 detail）。
 * 只搬 running 的步骤，已经 done/failed 的历史不动。
 */
function finalizeSteps(db: Db, projectId: string, env: string, result: BootstrapRunResult): void {
  const row = db.prepare(`${SELECT} AND env=?`).get(projectId, env) as unknown as EnvironmentRow | undefined;
  if (!row?.steps_json) return;
  const steps = parseSteps(row.steps_json);
  if (!steps.some((step) => step.status === "running")) return;
  const settledStatus: BootstrapStepStatus = result.ok ? "done" : "failed";
  const next = steps.map((step) => step.status !== "running" ? step : {
    ...step,
    status: settledStatus,
    detail: step.detail ?? (result.ok ? null : result.error ?? "建档中断"),
  });
  db.prepare("UPDATE project_environments SET steps_json=? WHERE project_id=? AND env=?")
    .run(JSON.stringify(next), projectId, env);
}

/** 生产执行器：spawn `python -m aitestharness_tools.runtime_cli onboard.bootstrap`。 */
function pythonBootstrapRun(engineRoot: string): BootstrapRun {
  return async ({ projectId, env, baseUrl, outDir, onStep }) => {
    const packageRoot = path.join(engineRoot, "aitestharness-tools");
    const python = process.env.AITEST_PYTHON ?? (process.platform === "win32" ? "python" : "python3");
    const payload = JSON.stringify({ project: projectId, env, target_url: baseUrl, out: outDir, progress: true });
    // spawn 而不是 execFile：进度在 stderr 上逐行来，必须边跑边读。等进程结束再
    // 一次性拿 buffer，五步进度就退化成"结束瞬间五条一起到"，抽屉里永远是假动画。
    const child = spawn(python, ["-m", "aitestharness_tools.runtime_cli", "onboard.bootstrap"], {
      cwd: engineRoot,
      env: {
        ...process.env,
        PYTHONPATH: [packageRoot, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
        PYTHONUTF8: "1",
        PYTHONIOENCODING: "utf-8",
      },
      windowsHide: true,
    });
    let stdout = "";
    let pending = "";
    // stderr 的非 @@step 行只留尾巴：它是 Python 的 traceback/日志，用来解释"为什么
    // 一个 JSON 都没拿到"，全留会撑爆内存，丢掉又会让报错无从查起。
    let stderrTail = "";
    let timedOut = false;
    const killTimer = setTimeout(() => { timedOut = true; child.kill(); }, BOOTSTRAP_TIMEOUT_MS);
    try {
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => { stdout += chunk; });
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk: string) => {
        pending += chunk;
        // 按行切：一行可能被拆包，半个 JSON 不能解析也不能丢。
        const lines = pending.split(/\r?\n/);
        pending = lines.pop() ?? "";
        for (const line of lines) {
          const text = line.trim();
          if (!text) continue;
          if (text.startsWith("@@step ")) {
            const event = parseStepLine(text.slice("@@step ".length));
            if (event && onStep) {
              try {
                onStep(event);
              } catch {
                // 写进度失败不能中断建档：进度是可丢的播报，结论才是要紧的。
              }
            }
            continue;
          }
          stderrTail = (stderrTail + text + "\n").slice(-2_000);
        }
      });
      await new Promise<void>((resolve, reject) => {
        child.on("error", reject); // spawn 失败（python 不在 PATH）走这里
        child.on("close", () => resolve());
        child.stdin?.end(payload);
      });
    } finally {
      clearTimeout(killTimer);
    }
    await fs.mkdir(outDir, { recursive: true });
    let parsed: { ok?: boolean; result?: BootstrapRunResult; message?: string };
    try {
      parsed = JSON.parse(stdout) as typeof parsed;
    } catch {
      // 非 JSON 多半是 Python 侧直接崩了：把 stderr 尾巴带上，否则只剩"解析失败"。
      const why = stderrTail.trim();
      throw new Error(timedOut
        ? `建档超时（${Math.round(BOOTSTRAP_TIMEOUT_MS / 1000)}s），已终止子进程${why ? `\n${why}` : ""}`
        : `建档工具返回非 JSON：${stdout.slice(0, 200) || "(stdout 为空)"}${why ? `\n${why}` : ""}`);
    }
    if (parsed.ok !== true || !parsed.result) {
      throw new Error(parsed.message ?? "建档工具执行失败");
    }
    return parsed.result;
  };
}

/** 解析一行 `@@step {...}`；坏行返回 null（进度可丢，不值得让整次建档失败）。 */
function parseStepLine(raw: string): BootstrapStepEvent | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const index = (parsed as { index?: unknown }).index;
    if (typeof index !== "number") return null;
    return parsed as BootstrapStepEvent;
  } catch {
    return null;
  }
}
