import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export const assetKinds = new Set([
  "requirement_rule", "test_data_profile", "ui_locator_bundle",
  "assertion_bundle", "api_contract", "defect_pattern"
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
