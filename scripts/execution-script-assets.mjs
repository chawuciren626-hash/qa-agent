import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { directoryContext, resourcePath } from './directory-context.mjs';
import { extractCases } from './execution-plan.mjs';
import { readCatalog, validateCatalog } from './test-asset-catalog.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const canonical = value => sha(Buffer.from(JSON.stringify(value ?? null)));
const safePart = value => /^[A-Za-z0-9_-]+$/.test(value ?? '');

/**
 * 脚本资产目录（D1）：优先落在项目自动化目录，避免把执行产物写进引擎级 config。
 * 与 test-asset-catalog 的候选登记同模式，但作用域是“项目 × 端 × 环境”。
 */
export function scriptCatalogPath(root) {
  const context = directoryContext(root);
  const dataRoot = process.env.QA_APP_DATA_ROOT;
  if (context.mode === 'isolated' && dataRoot && safePart(context.project_id)) {
    return resolve(dataRoot, 'projects', context.project_id, 'automation', 'test-assets.json');
  }
  return resolve(root, 'config', 'test-assets.json');
}

export function emptyCatalog() {
  return { catalog_version: 2, assets: [] };
}

function loadCatalog(path) {
  return existsSync(path) ? readCatalog(path) : emptyCatalog();
}

/** 用例版本 = 设计用例内容的稳定指纹；改一个字都算新版本。 */
export function caseVersion(designCase) {
  return canonical(designCase);
}

/** 锚点版本 = 用例引用锚点/资产的排序指纹；没有锚点也给出确定性空值。 */
export function anchorVersion(designCase) {
  const refs = [...(designCase?.asset_refs ?? []), ...(designCase?.anchor_refs ?? []), ...(designCase?.anchors ?? [])]
    .map(item => (typeof item === 'string' ? item : JSON.stringify(item)));
  return canonical([...new Set(refs)].sort());
}

/** 环境版本 = 运行环境配置文件字节指纹（含 base_url、账号策略等）。 */
export function environmentVersion(root, plan) {
  return sha(readFileSync(resourcePath(root, plan.environment_config)));
}

export function scriptAssetId(caseId, version) {
  const slug = String(caseId).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'case';
  return `script-${slug}-${sha(`${caseId}\n${version}`).slice(0, 8)}`;
}

export function scriptBinding(root, { plan, designCase }) {
  const environment = JSON.parse(readFileSync(resourcePath(root, plan.environment_config), 'utf8'));
  return {
    case_version: caseVersion(designCase),
    anchor_version: anchorVersion(designCase),
    environment_version: environmentVersion(root, plan),
    environment_id: environment.environment ?? null,
    origin: new URL(environment.base_url).origin,
  };
}

/**
 * 首跑通过后派生 candidate 脚本资产：一个用例一条，绑定 用例版本 + 锚点版本 + 环境版本。
 * 只在候选不存在时追加，绝不覆盖人审后的 verified / deprecated 状态。
 */
export function deriveScriptAssets(root, { runId, plan, bundleId, files, capturedAt }) {
  const designRows = new Map(extractCases(JSON.parse(readFileSync(resourcePath(root, plan.source), 'utf8'))).map(row => [row.case_id, row]));
  const environment = JSON.parse(readFileSync(resourcePath(root, plan.environment_config), 'utf8'));
  return plan.cases.map(testCase => {
    const designCase = designRows.get(testCase.case_id);
    if (!designCase) throw new Error(`Missing designed case ${testCase.case_id} for script asset binding`);
    const binding = scriptBinding(root, { plan, designCase });
    return {
      id: scriptAssetId(testCase.case_id, binding.case_version),
      kind: 'execution_script',
      name: `执行脚本：${testCase.case_id}`,
      version: '1.0.0',
      status: 'candidate',
      scope: {
        application: binding.origin,
        modules: [designCase.module ?? 'default'],
        environments: [binding.environment_id ?? binding.origin],
      },
      tags: ['execution_script', 'web', ...(binding.environment_id ? [binding.environment_id] : [])],
      source: {
        type: 'execution_result',
        reference: `run ${runId} / bundle ${bundleId}`,
        captured_at: capturedAt ?? new Date().toISOString(),
      },
      data: {
        bundle_id: bundleId,
        case_id: testCase.case_id,
        case_version: binding.case_version,
        anchor_version: binding.anchor_version,
        environment_version: binding.environment_version,
        environment_id: binding.environment_id,
        origin: binding.origin,
        files: files.map(file => file.path),
      },
    };
  });
}

export function registerScriptAssetCandidates(root, input) {
  const path = scriptCatalogPath(root);
  const catalog = loadCatalog(path);
  const existing = new Set((catalog.assets ?? []).map(asset => asset.id));
  const added = [];
  for (const asset of deriveScriptAssets(root, input)) {
    if (existing.has(asset.id)) continue;
    catalog.assets.push(asset);
    existing.add(asset.id);
    added.push(asset.id);
  }
  if (added.length) {
    const errors = validateCatalog(catalog);
    if (errors.length) throw new Error(`脚本资产登记后目录校验失败：${errors.slice(0, 3).join('；')}`);
    writeFileSync(path, `${JSON.stringify(catalog, null, 2)}\n`);
  }
  return { added, catalog: path };
}

function assetBindingMatches(asset, binding) {
  return asset?.data?.case_version === binding.case_version
    && asset?.data?.anchor_version === binding.anchor_version
    && asset?.data?.environment_version === binding.environment_version;
}

/**
 * 复跑决策：verified 且三版本全匹配 → 零生成复用；任一版本漂移 → 只把受影响用例列入增量再生。
 * candidate 尚未人审，不作为复用来源（复用仍走 web-script-library 的 verified bundle）。
 */
export function scriptAssetStatus(root, plan) {
  const path = scriptCatalogPath(root);
  const catalog = loadCatalog(path);
  const designRows = new Map(extractCases(JSON.parse(readFileSync(resourcePath(root, plan.source), 'utf8'))).map(row => [row.case_id, row]));
  const byCase = new Map((catalog.assets ?? []).filter(asset => asset.kind === 'execution_script').map(asset => [asset.data?.case_id, asset]));
  const reused = [];
  const regenerate = [];
  for (const testCase of plan.cases) {
    const asset = byCase.get(testCase.case_id);
    if (!asset) { regenerate.push({ case_id: testCase.case_id, reason: 'no_script_asset' }); continue; }
    if (asset.status !== 'verified') { regenerate.push({ case_id: testCase.case_id, reason: `asset_${asset.status}` }); continue; }
    const designCase = designRows.get(testCase.case_id);
    if (!designCase) { regenerate.push({ case_id: testCase.case_id, reason: 'missing_design_case' }); continue; }
    const binding = scriptBinding(root, { plan, designCase });
    if (!assetBindingMatches(asset, binding)) {
      const changed = ['case_version', 'anchor_version', 'environment_version'].filter(key => asset.data?.[key] !== binding[key]);
      regenerate.push({ case_id: testCase.case_id, reason: `stale_${changed.join('_')}` });
      continue;
    }
    reused.push({ case_id: testCase.case_id, asset_id: asset.id, bundle_id: asset.data.bundle_id });
  }
  return { catalog: path, reused, regenerate };
}

/** 某 bundle 的脚本资产是否因环境版本变化而失效（供复用路径剔除旧 bundle）。 */
export function bundleAssetStale(root, { plan, bundle }) {
  const catalog = loadCatalog(scriptCatalogPath(root));
  const designRows = new Map(extractCases(JSON.parse(readFileSync(resourcePath(root, plan.source), 'utf8'))).map(row => [row.case_id, row]));
  const assets = (catalog.assets ?? []).filter(asset => asset.kind === 'execution_script' && asset.data?.bundle_id === bundle.id);
  for (const asset of assets) {
    const designCase = designRows.get(asset.data.case_id);
    if (!designCase) continue;
    if (!assetBindingMatches(asset, scriptBinding(root, { plan, designCase }))) return { stale: true, asset_id: asset.id };
  }
  return { stale: false };
}
