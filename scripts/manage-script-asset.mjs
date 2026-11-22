import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { readCatalog, validateCatalog } from './test-asset-catalog.mjs';
import { emptyCatalog, scriptCatalogPath } from './execution-script-assets.mjs';

const root = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const option = name => args.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);

const path = scriptCatalogPath(root);
const catalog = existsSync(path) ? readCatalog(path) : emptyCatalog();
const assets = catalog.assets ?? [];

function persist() {
  const errors = validateCatalog(catalog);
  if (errors.length) throw new Error(`目录校验失败：${errors.slice(0, 3).join('；')}`);
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(catalog, null, 2)}\n`, { flag: 'wx' });
  renameSync(temp, path);
}

function scriptAsset(id) {
  const asset = assets.find(row => row.id === id);
  if (!asset) throw new Error(`未找到脚本资产 ${id}（目录：${path}）。`);
  if (asset.kind !== 'execution_script') throw new Error(`${id} 不是 execution_script 资产。`);
  return asset;
}

try {
  const promote = option('promote');
  const deprecate = option('deprecate');
  if (args.includes('--list') || (!promote && !deprecate)) {
    const rows = assets.filter(asset => asset.kind === 'execution_script').map(asset => ({
      id: asset.id, status: asset.status, case_id: asset.data?.case_id ?? null,
      bundle_id: asset.data?.bundle_id ?? null, validated_at: asset.validation?.validated_at ?? null,
    }));
    console.log(JSON.stringify({ catalog: path, assets: rows }, null, 2));
  } else if (promote) {
    const asset = scriptAsset(promote);
    const evidence = option('evidence');
    if (!evidence || !evidence.trim()) throw new Error('晋升 verified 必须提供 --evidence=<人工验证说明>。');
    asset.status = 'verified';
    asset.validation = { validated_at: new Date().toISOString(), environment: asset.data?.environment_id ?? null, evidence: evidence.trim() };
    persist();
    console.log(JSON.stringify({ status: 'promoted', id: asset.id, catalog: path, validation: asset.validation }, null, 2));
  } else {
    const asset = scriptAsset(deprecate);
    asset.status = 'deprecated';
    persist();
    console.log(JSON.stringify({ status: 'deprecated', id: asset.id, catalog: path }, null, 2));
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 2;
}
