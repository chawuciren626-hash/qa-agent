/**
 * grounding 三后端 driver 抽象（D6，依据 v2.3 §5.2）：
 *   结构层（零模型，DOM/UIA 控件树 + ≥2 指纹锚点）
 *   → 语义层（Midscene 类混合 grounding，命中必须降级为结构锚点）
 *   → 视觉层（computer-use 坐标兜底，命中必须反查结构锚点）。
 * 结构层命中时绝不触发模型调用；任何一次非结构命中都落回一棵结构树节点，
 * 保证回归重放只依赖确定性锚点。
 */

const DEFAULT_MIN_FINGERPRINTS = 2;

export function flattenTree(tree, output = []) {
  if (!tree) return output;
  output.push(tree);
  for (const child of tree.children ?? []) flattenTree(child, output);
  return output;
}

export function findNode(tree, { node_id, selector } = {}) {
  const nodes = flattenTree(tree);
  if (node_id) return nodes.find(node => node.id === node_id || node.node_id === node_id) ?? null;
  if (selector) return nodes.find(node => node.css_path === selector || node.selector === selector) ?? null;
  return null;
}

/** 锚点指纹 token：role / name / text / testid / css / tag / attr:k=v。 */
export function anchorTokens(anchor) {
  const tokens = new Set();
  if (anchor?.role) tokens.add(`role:${anchor.role}`);
  if (anchor?.testid) tokens.add(`testid:${anchor.testid}`);
  if (anchor?.name) tokens.add(`name:${anchor.name}`);
  if (anchor?.text) tokens.add(`text:${anchor.text}`);
  if (anchor?.tag) tokens.add(`tag:${anchor.tag}`);
  if (anchor?.css_path) tokens.add(`css:${anchor.css_path}`);
  for (const [key, value] of Object.entries(anchor?.attrs ?? {})) tokens.add(`attr:${key}=${value}`);
  for (const raw of anchor?.fingerprints ?? []) tokens.add(String(raw));
  return [...tokens].sort();
}

export function nodeTokens(node) {
  const tokens = new Set();
  if (node?.role) tokens.add(`role:${node.role}`);
  if (node?.testid) tokens.add(`testid:${node.testid}`);
  if (node?.name) tokens.add(`name:${node.name}`);
  if (node?.text) tokens.add(`text:${node.text}`);
  if (node?.tag) tokens.add(`tag:${node.tag}`);
  if (node?.css_path) tokens.add(`css:${node.css_path}`);
  for (const [key, value] of Object.entries(node?.attrs ?? {})) tokens.add(`attr:${key}=${value}`);
  return tokens;
}

export function matchFingerprints(node, anchor) {
  const present = nodeTokens(node);
  return anchorTokens(anchor).filter(token => present.has(token));
}

function candidateNodes(tree, anchor) {
  const tokens = anchorTokens(anchor);
  if (!tokens.length) return [];
  return flattenTree(tree)
    .map(node => ({ node, matched: matchFingerprints(node, anchor) }))
    .filter(row => row.matched.length)
    .sort((left, right) => right.matched.length - left.matched.length);
}

/**
 * 结构层解析：至少 minFingerprints 个独立指纹同时命中才算命中。
 * 只会命中最高分节点，分数相同视为歧义（宁可不解析，也不猜）。
 */
export function resolveStructural(tree, anchor, { minFingerprints = DEFAULT_MIN_FINGERPRINTS } = {}) {
  const candidates = candidateNodes(tree, anchor);
  if (!candidates.length) return { resolved: false, reason: 'no_fingerprint_match', candidates: [] };
  const [best, second] = candidates;
  if (best.matched.length < minFingerprints) return { resolved: false, reason: `insufficient_fingerprints:${best.matched.length}/${minFingerprints}`, candidates };
  if (second && second.matched.length === best.matched.length) return { resolved: false, reason: 'ambiguous_fingerprint_match', candidates };
  return { resolved: true, node: best.node, matched: best.matched, candidates };
}

function inBounds(node, point) {
  const bounds = node?.bounds;
  if (!bounds || typeof point?.x !== 'number' || typeof point?.y !== 'number') return false;
  return point.x >= bounds.x && point.y >= bounds.y && point.x <= bounds.x + bounds.width && point.y <= bounds.y + bounds.height;
}

/**
 * 视觉/坐标命中反查：点落入多个节点时取面积最小的（最深）节点，并至少有一个指纹与锚点一致。
 * 找不到结构节点就判定未解析，视觉坐标不允许直接进入产物。
 */
export function reverseLookup(tree, located, anchor) {
  if (!located) return null;
  if (located.node_id || located.selector) {
    const node = findNode(tree, located);
    return node && matchFingerprints(node, anchor).length ? { node, matched: matchFingerprints(node, anchor) } : null;
  }
  if (typeof located.x !== 'number' || typeof located.y !== 'number') return null;
  const hits = flattenTree(tree)
    .filter(node => inBounds(node, located))
    .sort((left, right) => (left.bounds.width * left.bounds.height) - (right.bounds.width * right.bounds.height));
  for (const node of hits) {
    const matched = matchFingerprints(node, anchor);
    if (matched.length) return { node, matched };
  }
  return null;
}

/** 把任意后端命中固化成结构锚点，供资产库/回归重放使用。 */
export function toStructuralAnchor(node, sourceAnchor, matched, backend) {
  return {
    anchor_id: sourceAnchor?.id ? `${sourceAnchor.id}@structural` : `anchor-${node.id ?? node.node_id}`,
    role: node.role ?? sourceAnchor?.role ?? null,
    name: node.name ?? sourceAnchor?.name ?? null,
    text: node.text ?? sourceAnchor?.text ?? null,
    testid: node.testid ?? null,
    css_path: node.css_path ?? node.selector ?? null,
    fingerprints: [...new Set(matched)].sort(),
    origin_backend: backend,
    verified: true,
    node_id: node.id ?? node.node_id ?? null,
  };
}

export function createGroundingDriver({ semantic = null, visual = null, minFingerprints = DEFAULT_MIN_FINGERPRINTS } = {}) {
  const backends = ['structural', ...(semantic ? ['semantic'] : []), ...(visual ? ['visual'] : [])];
  return {
    backends,
    async resolve({ tree, anchor, screenshot } = {}) {
      const attempts = [];
      const structural = resolveStructural(tree, anchor, { minFingerprints });
      if (structural.resolved) {
        return { resolved: true, backend: 'structural', model_calls: 0, node: structural.node, anchor: toStructuralAnchor(structural.node, anchor, structural.matched, 'structural'), matched_fingerprints: structural.matched, attempts: [{ backend: 'structural', outcome: 'hit' }] };
      }
      attempts.push({ backend: 'structural', outcome: 'miss', reason: structural.reason });
      if (semantic) {
        const suggestion = await semantic.resolve({ anchor, tree, text: anchor?.text ?? anchor?.name ?? null });
        const node = suggestion ? findNode(tree, suggestion) : null;
        const matched = node ? matchFingerprints(node, anchor) : [];
        if (node && matched.length) {
          attempts.push({ backend: 'semantic', outcome: 'hit_downgraded' });
          return { resolved: true, backend: 'semantic', model_calls: 1, node, anchor: toStructuralAnchor(node, anchor, matched, 'semantic'), matched_fingerprints: matched, downgraded: true, attempts };
        }
        attempts.push({ backend: 'semantic', outcome: 'rejected', reason: node ? 'structural_anchor_unverified' : 'no_structural_node' });
      }
      if (visual) {
        const located = await visual.locate({ anchor, screenshot, tree });
        const hit = reverseLookup(tree, located, anchor);
        if (hit) {
          attempts.push({ backend: 'visual', outcome: 'hit_reverse_verified' });
          return { resolved: true, backend: 'visual', model_calls: 1, node: hit.node, anchor: toStructuralAnchor(hit.node, anchor, hit.matched, 'visual'), matched_fingerprints: hit.matched, downgraded: true, attempts };
        }
        attempts.push({ backend: 'visual', outcome: 'rejected', reason: 'no_structural_anchor' });
      }
      return { resolved: false, backend: null, model_calls: 0, reason: 'no_backend_resolved', attempts };
    },
  };
}
