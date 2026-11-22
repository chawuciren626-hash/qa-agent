/**
 * 结构快照：在页面内采集可交互控件树，供 D6 结构层零模型定位。
 * 输出字段与 grounding-driver 的 nodeTokens 对齐：
 *   role / name / text / testid / tag / css_path / attrs / bounds。
 * 该函数会被 page.evaluate 序列化执行，必须自包含。
 */
export function collectControlTree() {
  const escape = (value) => (window.CSS?.escape ? CSS.escape(value) : String(value).replace(/[^a-zA-Z0-9_-]/g, '\\$&'));
  const selector = [
    'button', 'a[href]', 'input', 'select', 'textarea',
    '[role="button"]', '[role="link"]', '[role="checkbox"]', '[role="combobox"]',
    '[role="tab"]', '[role="menuitem"]', '[role="switch"]',
  ].join(',');

  const implicitRole = (tag, type) => {
    if (tag === 'button') return 'button';
    if (tag === 'a') return 'link';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      if (['button', 'submit', 'reset'].includes(type)) return 'button';
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      return 'textbox';
    }
    return null;
  };

  const cssPath = (element) => {
    if (element.id && document.querySelectorAll(`#${escape(element.id)}`).length === 1) return `#${element.id}`;
    const parts = [];
    let current = element;
    while (current && current.nodeType === 1 && parts.length < 6) {
      let part = current.tagName.toLowerCase();
      const parent = current.parentElement;
      if (parent) {
        const siblings = [...parent.children].filter(child => child.tagName === current.tagName);
        if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
      }
      parts.unshift(part);
      current = parent;
    }
    return `body > ${parts.join(' > ')}`;
  };

  const visible = (element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  };

  const nodes = [];
  for (const element of document.querySelectorAll(selector)) {
    if (!visible(element)) continue;
    const tag = element.tagName.toLowerCase();
    const type = (element.getAttribute('type') || '').toLowerCase();
    const text = (element.innerText || element.textContent || '').trim().replace(/\s+/g, ' ');
    const name = (element.getAttribute('aria-label') || element.getAttribute('title') || text || element.getAttribute('placeholder') || '').trim();
    const path = cssPath(element);
    const rect = element.getBoundingClientRect();
    nodes.push({
      id: path,
      node_id: path,
      tag,
      role: element.getAttribute('role') || implicitRole(tag, type),
      name,
      text,
      testid: element.getAttribute('data-test') || element.getAttribute('data-testid'),
      css_path: path,
      attrs: type ? { type } : {},
      bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      children: [],
    });
  }
  return { id: 'dom-root', node_id: 'dom-root', role: 'root', name: null, text: null, tag: 'html', css_path: null, attrs: {}, bounds: null, children: nodes };
}
