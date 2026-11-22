import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export const assetKinds = new Set([
  "requirement_rule", "test_data_profile", "ui_locator_bundle",
  "assertion_bundle", "api_contract", "defect_pattern", "execution_script"
]);
export const assetStatuses = new Set(["candidate", "verified", "deprecated"]);

export function readCatalog(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function validateCatalog(catalog) {
  const errors = [];
  if (catalog?.catalog_version !== 2) errors.push("catalog_version 必须为 2。");
  if (!Array.isArray(catalog?.assets)) return ["assets 必须为数组。"];
  const ids = new Set();
  for (const asset of catalog.assets) {
    const label = asset?.id ?? "<缺少 id>";
    for (const field of ["id", "kind", "name", "version", "status", "scope", "tags", "source", "data"]) {
      if (asset?.[field] === undefined) errors.push(`${label}: 缺少 ${field}。`);
    }
    if (!/^[a-z0-9][a-z0-9-]*$/.test(asset?.id ?? "")) errors.push(`${label}: id 仅可使用小写字母、数字和连字符。`);
    if (ids.has(asset?.id)) errors.push(`${label}: id 重复。`);
    ids.add(asset?.id);
    if (!assetKinds.has(asset?.kind)) errors.push(`${label}: kind 不受支持。`);
    if (!assetStatuses.has(asset?.status)) errors.push(`${label}: status 不受支持。`);
    if (!Array.isArray(asset?.tags)) errors.push(`${label}: tags 必须为数组。`);
    if (asset?.status === "verified" && !asset?.validation?.validated_at) errors.push(`${label}: verified 资产必须包含 validation.validated_at。`);
    const serialized = JSON.stringify(asset?.data ?? {}).toLowerCase();
    if (/("password"|"token"|"verification_code"|"api_key")\s*:\s*"(?!从已授权环境配置读取)/.test(serialized)) {
      errors.push(`${label}: data 中疑似包含凭据；请改为环境配置引用或生成策略。`);
    }
  }
  return errors;
}

export function catalogPath(root, suppliedPath) {
  return suppliedPath ? resolve(root, suppliedPath) : resolve(root, "config/test-assets.json");
}
import { writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

/**
 * 探索成功后自动派生 ui_locator_bundle 候选（B4-2）：合并地图里每个控件指纹 ≥2 的页面
 * 生成一个候选资产，控件 fingerprints 原样进入 data，供执行期引用与人工晋升 verified。
 * 幂等：id 由 env+route 哈希派生，已存在的跳过（不覆盖人工/评审状态）。
 */
export function deriveExplorationCandidates(catalog, { env, endType = "", maps, capturedAt }) {
  const existing = new Set((catalog.assets ?? []).map(asset => asset.id));
  const added = [];
  for (const page of (maps?.pages ?? [])) {
    const controls = (page.controls ?? []).filter(control =>
      control && Object.values(control.fingerprints ?? {}).some(Boolean));
    if (controls.length < 2) continue;
    const route = page.route ?? page.url ?? "";
    const id = `ui-${env}-${createHash("sha256").update(`${env}\n${route}`).digest("hex").slice(0, 8)}`;
    if (existing.has(id)) continue;
    catalog.assets.push({
      id,
      kind: "ui_locator_bundle",
      name: `页面定位器：${route || id}`.slice(0, 120),
      version: "1.0.0",
      status: "candidate",
      scope: { application: env, modules: [page.module ?? "default"], environments: [env] },
      tags: ["exploration", env, ...(endType ? [endType] : [])],
      source: { type: "observed_ui", reference: "探索自动派生（candidate，待人工晋升 verified）", captured_at: capturedAt },
      data: { route, controls: controls.slice(0, 60) },
    });
    added.push(id);
  }
  return added;
}

/** 读目录 → 派生 → 原子写回；只追加新候选，绝不覆盖已有条目。 */
export function registerExplorationCandidates(root, { env, endType = "", maps, capturedAt }) {
  const catalogPath = catalogPath(root);
  const catalog = readCatalog(catalogPath);
  const added = deriveExplorationCandidates(catalog, { env, endType, maps, capturedAt });
  if (added.length) {
    const errors = validateCatalog(catalog);
    if (errors.length) throw new Error(`候选派生后目录校验失败：${errors.slice(0, 3).join("；")}`);
    writeFileSync(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);
  }
  return { added };
}
