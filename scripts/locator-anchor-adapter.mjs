import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { catalogPath, readCatalog } from "./test-asset-catalog.mjs";

export const MIN_ANCHOR_FINGERPRINTS = 2;

const text = (value) => (typeof value === "string" ? value.trim() : "");
const slug = (value) =>
  String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);

/**
 * 指纹 token 与 grounding-driver 的 anchorTokens / nodeTokens 对齐：
 * css / role / testid / text / name 五类独立指纹，同一类只算一次。
 */
export function fingerprintTokens(control) {
  const fingerprints = control?.fingerprints ?? {};
  const tokens = [];
  const css = text(fingerprints.css);
  const role = text(fingerprints.role);
  const testid = text(fingerprints.testid);
  const label = text(control?.text) || text(fingerprints.text);
  const name = text(control?.name) || text(fingerprints.name);
  if (css) tokens.push(`css:${css}`);
  if (role) tokens.push(`role:${role}`);
  if (testid) tokens.push(`testid:${testid}`);
  if (label) tokens.push(`text:${label}`);
  if (name) tokens.push(`name:${name}`);
  return [...new Set(tokens)];
}

/**
 * 单个控件 → 结构锚点。少于 2 个独立指纹的控件不可作为锚点（返回 null），
 * 与 D6 结构层「≥2 指纹才命中」的约束保持一致。
 */
export function controlAnchor(control, { bundleId = "bundle", route = null } = {}) {
  const fingerprints = fingerprintTokens(control);
  if (fingerprints.length < MIN_ANCHOR_FINGERPRINTS) return null;
  const identity = slug(control?.name) || slug(control?.text) || createHash("sha256").update(fingerprints.join("|")).digest("hex").slice(0, 8);
  return {
    anchor_id: `${bundleId}:${identity}`,
    control: control?.name ?? null,
    control_type: control?.control_type ?? null,
    role: text(control?.fingerprints?.role) || null,
    testid: text(control?.fingerprints?.testid) || null,
    name: text(control?.name) || text(control?.fingerprints?.name) || null,
    text: text(control?.text) || text(control?.fingerprints?.text) || null,
    css_path: text(control?.fingerprints?.css) || null,
    route,
    fingerprints,
  };
}

export function bundleAnchors(bundle) {
  if (bundle?.kind !== "ui_locator_bundle") throw new Error(`${bundle?.id ?? "<缺少 id>"}: 只有 ui_locator_bundle 可以派生锚点。`);
  return (bundle.data?.controls ?? [])
    .map((control) => controlAnchor(control, { bundleId: bundle.id, route: bundle.data?.route ?? null }))
    .filter(Boolean);
}

function controlMatches(control, selector) {
  if (typeof selector !== "string" || !selector) return false;
  return [
    control?.name,
    control?.text,
    control?.fingerprints?.css,
    control?.fingerprints?.text,
    control?.fingerprints?.role,
  ].some((value) => value === selector);
}

/**
 * 用例声明 target_controls（控件 name / 全文本 / css 选择器，或 {asset_id, control}），
 * 适配器把它解析为 asset_refs + 结构 anchors。解析不到或指纹不足直接报错，
 * 不允许“静默降级成空锚点”。
 */
export function bindCaseAnchors(designCase, catalog) {
  const targets = designCase?.target_controls ?? [];
  if (!Array.isArray(targets)) throw new Error(`${designCase?.case_id}: target_controls 必须是数组。`);
  if (!targets.length) return designCase;
  const bundles = (catalog?.assets ?? []).filter((asset) => asset.kind === "ui_locator_bundle");
  const refs = new Map();
  const anchors = [];
  for (const target of targets) {
    const selector = typeof target === "string" ? target : target?.control;
    const assetId = typeof target === "string" ? null : target?.asset_id ?? null;
    const candidates = assetId ? bundles.filter((bundle) => bundle.id === assetId) : bundles;
    let hit = null;
    for (const bundle of candidates) {
      const control = (bundle.data?.controls ?? []).find((row) => controlMatches(row, selector));
      if (control) { hit = { bundle, control }; break; }
    }
    if (!hit) throw new Error(`${designCase.case_id}: 目标控件 ${selector ?? "<缺少 control>"} 未在资产目录的 ui_locator_bundle 中找到。`);
    const anchor = controlAnchor(hit.control, { bundleId: hit.bundle.id, route: hit.bundle.data?.route ?? null });
    if (!anchor) throw new Error(`${designCase.case_id}: 控件 ${selector} 独立指纹不足 ${MIN_ANCHOR_FINGERPRINTS} 个，不能作为结构锚点。`);
    refs.set(`${hit.bundle.id}@${hit.bundle.version}`, { id: hit.bundle.id, version: hit.bundle.version, kind: hit.bundle.kind });
    anchors.push(anchor);
  }
  const existing = (designCase.asset_refs ?? []).map((ref) => ({ id: ref.id, version: ref.version, kind: ref.kind ?? null }));
  const merged = new Map([...existing, ...refs.values()].map((ref) => [`${ref.id}@${ref.version}`, ref]));
  return { ...designCase, asset_refs: [...merged.values()], anchors };
}

export function applyAnchorBindings(cases, catalog) {
  return cases.map((designCase) => bindCaseAnchors(designCase, catalog));
}

/** 读取当前目录解析规则下的 catalog；不存在时返回 null，调用方按“无资产目录”处理。 */
export function loadCatalog(root) {
  const path = catalogPath(root);
  return { path, catalog: existsSync(path) ? readCatalog(path) : null };
}
