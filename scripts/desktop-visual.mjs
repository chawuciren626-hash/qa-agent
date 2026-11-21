/**
 * 桌面视觉层（computer-use 核心）：Midscene @midscene/computer 集成 + 锚点降级。
 *
 * 职责边界（v2 方案 §3.5）：
 *   - 视觉层只回答"现在屏幕上哪里是目标、把它点掉/填掉"——截图 → VLM 定位 → 动作；
 *   - **每次视觉动作命中后立刻调 Python 探针（probe/desktop_probe.py）反查 UIA 锚点**：
 *     锚点进回执（可进剧本），坐标只留在证据截图与 receipt 里，绝不进产物——
 *     "产出必须当场降级为结构化锚点"的硬约束在代码里就这一行出口；
 *   - 模型配置不落在代码里：优先进程环境（MIDSCENE_* / OPENAI_*），其次引擎根目录
 *     config/desktop-visual.json（管理员维护，密钥用本机密钥库引用时由部署侧注入环境）。
 *
 * 为什么 Midscene 走单例：屏幕是整机独占资源（exec/pools.py 的 desktop_pool 容量为 1），
 * 两个 ComputerAgent 同时驱动一台屏等于互相点击对方的窗口。生命周期用懒初始化 +
 * 引用计数释放，进程退出由 destroy 兜底。
 */
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pythonCandidates } from './command-runtime.mjs';

const CONFIG_REL = 'config/desktop-visual.json';
let agentPromise = null;

export const desktopVisualOperations = ['locate', 'tap', 'input', 'act', 'assert', 'screenshot'];

export function desktopVisualError(error, phase) {
  const message = error?.message ?? String(error);
  if (/Cannot find package|ERR_MODULE_NOT_FOUND/.test(message)) {
    return { category: 'midscene_unavailable', phase, message: '@midscene/computer 未安装：npm install @midscene/computer（引擎根目录）。' };
  }
  if (/MIDSCENE_(MODEL_NAME|OPENAI)|model_name|baseUrl|base_url|api[_ ]?key/i.test(message)) {
    return { category: 'visual_model_unconfigured', phase, message: '视觉模型未配置：设置 MIDSCENE_MODEL_NAME / MIDSCENE_OPENAI_BASE_URL / MIDSCENE_OPENAI_API_KEY，或维护 config/desktop-visual.json。' };
  }
  return { category: 'desktop_visual_failed', phase, message };
}

/**
 * 模型配置：环境优先（部署侧注入，密钥不落盘），配置文件其次（管理员维护的
 * 非密钥字段）。两者都缺 → 明确报错，绝不"看起来能跑"。
 */
export function resolveVisualModelConfig(root, env = process.env) {
  const modelName = env.MIDSCENE_MODEL_NAME ?? '';
  const baseUrl = env.MIDSCENE_OPENAI_BASE_URL ?? env.OPENAI_BASE_URL ?? '';
  const apiKey = env.MIDSCENE_OPENAI_API_KEY ?? env.OPENAI_API_KEY ?? '';
  if (modelName && baseUrl && apiKey) return { source: 'env', modelName, baseUrl };
  const configPath = resolve(root, CONFIG_REL);
  if (existsSync(configPath)) {
    try {
      const config = JSON.parse(readFileSync(configPath, 'utf8'));
      const name = config.model_name ?? config.modelName ?? '';
      const url = config.base_url ?? config.baseUrl ?? '';
      if (name && url && apiKey) return { source: 'config', modelName: name, baseUrl: url };
      return { source: 'config', modelName: name, baseUrl: url, missing: !apiKey ? ['api_key'] : (!name ? ['model_name'] : ['base_url']) };
    } catch (error) {
      throw new Error(`config/desktop-visual.json 不是合法 JSON：${error.message}`);
    }
  }
  throw new Error('视觉模型未配置：需要 MIDSCENE_MODEL_NAME / MIDSCENE_OPENAI_BASE_URL / MIDSCENE_OPENAI_API_KEY 环境变量，或 config/desktop-visual.json 配合密钥环境变量。');
}

async function withAgent(root, env, fn) {
  if (!agentPromise) {
    agentPromise = (async () => {
      const midscene = await import('@midscene/computer');
      const config = resolveVisualModelConfig(root, env);
      // overrideAIConfig 是 Midscene 官方提供的进程内模型配置入口；env 已配置时幂等。
      if (config.source === 'config' || env.MIDSCENE_MODEL_NAME) {
        midscene.overrideAIConfig({
          MIDSCENE_MODEL_NAME: config.modelName,
          MIDSCENE_OPENAI_BASE_URL: config.baseUrl,
          ...(env.MIDSCENE_OPENAI_API_KEY || env.OPENAI_API_KEY ? { MIDSCENE_OPENAI_API_KEY: env.MIDSCENE_OPENAI_API_KEY ?? env.OPENAI_API_KEY } : {}),
        });
      }
      const agent = await midscene.agentForComputer({ displayId: '0' });
      return { midscene, agent };
    })().catch(error => { agentPromise = null; throw error; });
  }
  const { agent } = await agentPromise;
  return fn(agent);
}

/**
 * 锚点降级出口：屏幕坐标 → UIA 指纹。坐标只存在于返回值的 evidence 字段，
 * `anchor` 是唯一允许进入剧本的部分；`anchor.ok=false` 时如实标 unresolved。
 */
export function degradeToAnchor(root, env, point) {
  const candidates = pythonCandidates(env, root);
  if (!candidates.length) return { ok: false, anchor: null, reason: 'no_python_runtime' };
  const packageRoot = resolve(root, 'aitestharness-tools');
  const script = [
    'import sys,json',
    `sys.path.insert(0,${JSON.stringify(packageRoot.replaceAll('\\', '/'))})`,
    'from aitestharness_tools.probe.desktop_probe import DesktopProbe',
    'p=DesktopProbe()',
    `print(json.dumps(p.element_from_point(${Math.round(point.x)},${Math.round(point.y)})))`,
  ].join(';');
  const run = spawnSync(candidates[0], ['-c', script], { cwd: root, env: { ...env, PYTHONUTF8: '1' }, encoding: 'utf8', windowsHide: true, timeout: 20000 });
  if (run.status !== 0) return { ok: false, anchor: null, reason: `probe_failed:${(run.stderr || run.error?.message || '').slice(0, 160)}` };
  try {
    const parsed = JSON.parse(run.stdout);
    return { ok: parsed.ok === true, anchor: parsed.anchor ?? null, reason: parsed.reason ?? null, rect: parsed.rect ?? null };
  } catch {
    return { ok: false, anchor: null, reason: 'probe_output_unparseable' };
  }
}

/**
 * 执行一个视觉动作。request 写证据（截图 PNG）与回执（含降级锚点）到 run 目录。
 * 返回 {status, result} —— 与 android/browser 操作回执同构，调用方直接落 receipt。
 */
export async function runVisualOperation({ root, dir, operation, env = process.env }) {
  const request = operation;
  const requestPath = resolve(dir, 'execution', 'desktop');
  mkdirSync(requestPath, { recursive: true });
  mkdirSync(resolve(dir, 'execution', 'desktop-receipts'), { recursive: true });
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const action = request.action ?? '';
  if (!desktopVisualOperations.includes(action)) throw new Error(`unknown visual action ${action}`);
  // 截图是纯探针操作：不碰 Midscene、不要求模型配置——排障第一入口不能被配置挡住。
  if (action === 'screenshot') {
    const screenshotPath = `execution/desktop/${request.request_id}.png`;
    mkdirSync(resolve(dir, 'execution', 'desktop'), { recursive: true });
    writeEvidence(root, env, resolve(dir, screenshotPath));
    const result = { request_id: request.request_id, type: request.type, action, ok: true,
      screenshot: screenshotPath, started_at: startedAt, duration_ms: Math.round(performance.now() - started) };
    try { writeFileSync(resolve(dir, 'execution', 'desktop-receipts', `${request.request_id}.json`), JSON.stringify(result, null, 2), { flag: 'wx', mode: 0o600 }); } catch { /* 尽量落 */ }
    return { status: 'ok', result };
  }
  try {
    return await withAgent(root, env, async (agent) => {
      let point = null;
      let anchor = { ok: false, anchor: null, reason: 'not_located' };
      let detail = {};
      const locate = async target => {
        const hit = await agent.aiLocate(target);
        // Midscene 的定位返回形状跨版本有差异：容忍 {x,y} / {point:{x,y}} / [x,y]。
        const candidate = hit?.point ?? hit;
        const x = Array.isArray(candidate) ? candidate[0] : candidate?.x ?? hit?.x;
        const y = Array.isArray(candidate) ? candidate[1] : candidate?.y ?? hit?.y;
        if (!Number.isFinite(Number(x)) || !Number.isFinite(Number(y))) {
          throw new Error(`visual locate did not return a point for ${JSON.stringify(target).slice(0, 120)}`);
        }
        point = { x: Number(x), y: Number(y) };
        anchor = degradeToAnchor(root, env, point);
        return point;
      };
      switch (action) {
        case 'locate':
          await locate(request.target);
          detail = { target: request.target };
          break;
        case 'tap':
          await locate(request.target);
          await agent.aiTap(request.target);
          detail = { target: request.target, acted: 'tap' };
          break;
        case 'input':
          await locate(request.target);
          await agent.aiInput(request.text ?? '');
          detail = { target: request.target, chars: String(request.text ?? '').length };
          break;
        case 'act':
          await agent.aiAct(request.instruction ?? '');
          detail = { instruction: request.instruction };
          break;
        case 'assert':
          await agent.aiAssert(request.expectation ?? '');
          detail = { expectation: request.expectation };
          break;
        default:
          throw new Error(`unhandled visual action ${action}`);
      }
      // 截图证据用探针截（同屏同源），Midscene 的 agent 不必暴露截图接口。
      const screenshotPath = `execution/desktop/${request.request_id}.png`;
      writeEvidence(root, env, resolve(dir, screenshotPath));
      const result = {
        request_id: request.request_id, type: request.type, action, ok: true,
        // anchor 是唯一允许进剧本的部分；坐标（point）只进证据。
        anchor: anchor.anchor, anchor_ok: anchor.ok, anchor_reason: anchor.reason,
        ...(anchor.rect ? { anchor_rect: anchor.rect } : {}),
        ...(point ? { evidence_point: point } : {}),
        screenshot: screenshotPath,
        started_at: startedAt, duration_ms: Math.round(performance.now() - started),
        ...detail,
      };
      writeFileSync(resolve(dir, 'execution', 'desktop-receipts', `${request.request_id}.json`),
        JSON.stringify(result, null, 2), { flag: 'wx', mode: 0o600 });
      return { status: 'ok', result };
    });
  } catch (error) {
    const diagnostic = desktopVisualError(error, action);
    const result = { request_id: request.request_id, type: request.type, action, ok: false,
      error: diagnostic.message, category: diagnostic.category, started_at: startedAt,
      duration_ms: Math.round(performance.now() - started) };
    try { writeFileSync(resolve(dir, 'execution', 'desktop-receipts', `${request.request_id}.json`), JSON.stringify(result, null, 2), { flag: 'wx', mode: 0o600 }); } catch { /* 失败回执尽量落，但不遮蔽原错误 */ }
    return { status: diagnostic.category === 'desktop_visual_failed' ? 'failed' : 'unavailable', result };
  }
}

function writeEvidence(root, env, targetPath) {
  const candidates = pythonCandidates(env, root);
  if (!candidates.length) return;
  const packageRoot = resolve(root, 'aitestharness-tools');
  const script = [
    'import sys',
    `sys.path.insert(0,${JSON.stringify(packageRoot.replaceAll('\\', '/'))})`,
    'from aitestharness_tools.probe.desktop_probe import DesktopProbe',
    `open(${JSON.stringify(targetPath.replaceAll('\\', '/'))},'wb').write(DesktopProbe().screenshot())`,
  ].join(';');
  spawnSync(candidates[0], ['-c', script], { cwd: root, env: { ...env, PYTHONUTF8: '1' }, windowsHide: true, timeout: 15000 });
}

/** 退出/重建时的释放口。desktop-task 的 finish 会调用。 */
export async function destroyVisualAgent() {
  if (!agentPromise) return;
  const promise = agentPromise;
  agentPromise = null;
  try {
    const { agent } = await promise;
    await agent.destroy();
  } catch { /* 释放失败不影响主流程：屏幕状态由下一轮 agent 重建 */ }
}

export const desktopVisualSelfTest = {
  resolveVisualModelConfig,
  degradeToAnchor,
};
