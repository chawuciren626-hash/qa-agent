const EMPTY_NODE = () => ({
  text: '',
  resourceId: '',
  contentDesc: '',
  className: '',
  packageName: '',
  checkable: false,
  checked: false,
  clickable: false,
  enabled: true,
  focusable: false,
  focused: false,
  scrollable: false,
  selected: false,
  bounds: null,
  children: [],
  path: '',
  depth: 0
});

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeEntities(value) {
  return String(value).replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (whole, entity) => {
    if (entity[0] === '#') {
      const code = entity[1] === 'x' || entity[1] === 'X'
        ? Number.parseInt(entity.slice(2), 16)
        : Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[entity] ?? whole;
  });
}

function parseAttributes(source) {
  const attrs = {};
  for (const match of String(source).matchAll(/([A-Za-z_:][A-Za-z0-9_:.-]*)\s*=\s*"([^"]*)"/g)) {
    attrs[match[1]] = decodeEntities(match[2]);
  }
  return attrs;
}

export function parseBounds(value) {
  const match = /^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/.exec(String(value ?? ''));
  if (!match) return null;
  const [left, top, right, bottom] = match.slice(1).map(Number);
  const width = Math.max(0, right - left);
  const height = Math.max(0, bottom - top);
  return { left, top, right, bottom, width, height, center_x: Math.round(left + width / 2), center_y: Math.round(top + height / 2) };
}

function nodeFromAttributes(attrs) {
  return {
    ...EMPTY_NODE(),
    text: attrs.text ?? '',
    resourceId: attrs['resource-id'] ?? '',
    contentDesc: attrs['content-desc'] ?? '',
    className: attrs.class ?? '',
    packageName: attrs.package ?? '',
    checkable: attrs.checkable === 'true',
    checked: attrs.checked === 'true',
    clickable: attrs.clickable === 'true',
    enabled: attrs.enabled !== 'false',
    focusable: attrs.focusable === 'true',
    focused: attrs.focused === 'true',
    scrollable: attrs.scrollable === 'true',
    selected: attrs.selected === 'true',
    bounds: parseBounds(attrs.bounds)
  };
}

export function parseUiHierarchy(xml) {
  const source = String(xml ?? '');
  if (!/<hierarchy[\s>]/.test(source)) throw new Error('uiautomator output does not contain a hierarchy element');
  const root = { ...EMPTY_NODE(), className: 'hierarchy', path: '', depth: -1 };
  const stack = [root];
  const tag = /<\s*(\/?)\s*(node|hierarchy)\b([^>]*?)(\/?)\s*>/g;
  let match;
  while ((match = tag.exec(source))) {
    const [, closing, name, rawAttrs, selfClosing] = match;
    if (name === 'hierarchy') continue;
    if (closing) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const parent = stack.at(-1);
    const node = nodeFromAttributes(parseAttributes(rawAttrs));
    node.depth = parent.depth + 1;
    node.path = `${parent.path ? `${parent.path}/` : ''}${parent.children.length}`;
    parent.children.push(node);
    if (!selfClosing) stack.push(node);
  }
  if (!root.children.length) throw new Error('uiautomator hierarchy contains no nodes');
  return root;
}

export function flattenUi(root) {
  const nodes = [];
  const walk = node => {
    for (const child of node.children) {
      nodes.push(child);
      walk(child);
    }
  };
  walk(root);
  return nodes;
}

function normalizedTarget(target) {
  if (!target || typeof target !== 'object') throw new Error('UI target is required');
  const by = target.by;
  if (!['text', 'id', 'desc', 'class'].includes(by)) throw new Error(`Unsupported UI locator: ${by}`);
  const value = String(target.value ?? '');
  if (!value.trim()) throw new Error('UI locator value is empty');
  const match = target.match === undefined ? 'exact' : target.match;
  if (!['exact', 'contains'].includes(match)) throw new Error(`Unsupported UI match mode: ${match}`);
  const index = target.index === undefined ? null : target.index;
  if (index !== null && (!Number.isSafeInteger(index) || index < 0)) throw new Error('UI locator index must be a non-negative integer');
  return { by, value, match, index };
}

function textMatches(actual, expected, match) {
  return match === 'contains' ? actual.includes(expected) : actual === expected;
}

function attributeMatches(actual, expected, match) {
  if (match === 'contains') return actual.includes(expected);
  if (actual === expected) return true;
  if (expected.includes(':') || expected.includes('/')) return false;
  return actual.endsWith(`:id/${expected}`) || actual.endsWith(`/${expected}`);
}

export function findUiNodes(root, target) {
  const locator = normalizedTarget(target);
  const all = flattenUi(root);
  const matches = all.filter(node => {
    if (locator.by === 'text') return textMatches(node.text, locator.value, locator.match);
    if (locator.by === 'desc') return textMatches(node.contentDesc, locator.value, locator.match);
    if (locator.by === 'id') return attributeMatches(node.resourceId, locator.value, locator.match);
    return attributeMatches(node.className, locator.value, locator.match);
  });
  return {
    locator,
    matches,
    total: matches.length,
    selected: locator.index !== null ? (matches[locator.index] ?? null) : (matches.length === 1 ? matches[0] : null),
    ambiguous: locator.index === null && matches.length > 1
  };
}

export function describeUiNode(node) {
  return {
    path: node.path,
    text: node.text.slice(0, 200),
    resource_id: node.resourceId,
    content_desc: node.contentDesc,
    class: node.className,
    package: node.packageName,
    clickable: node.clickable,
    enabled: node.enabled,
    checked: node.checked,
    selected: node.selected,
    focused: node.focused,
    scrollable: node.scrollable,
    bounds: node.bounds,
    depth: node.depth
  };
}

export function describeUiTree(root, { limit = 120 } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 400) throw new Error('UI description limit must be between 1 and 400');
  const all = flattenUi(root);
  const visible = all.filter(node => {
    const area = (node.bounds?.width ?? 0) * (node.bounds?.height ?? 0);
    return area > 0 && (node.text || node.resourceId || node.contentDesc || node.clickable || node.scrollable || node.focusable);
  });
  const selected = visible.slice(0, limit).map(describeUiNode);
  const packages = [...new Set(all.map(node => node.packageName).filter(Boolean))];
  return {
    node_count: all.length,
    visible_node_count: visible.length,
    truncated: visible.length > selected.length,
    packages,
    nodes: selected
  };
}

export function uiTextValues(root) {
  return [...new Set(flattenUi(root).map(node => node.text).filter(Boolean))];
}
