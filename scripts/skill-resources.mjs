import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { resolve, relative, isAbsolute, dirname } from 'node:path';

export function contained(base, path) {
  const rel = relative(resolve(base), resolve(path));
  return !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`);
}

export function assertUnlinked(base, target) {
  if (!contained(base, target)) throw new Error(`Path escapes resource root: ${target}`);
  const parts = relative(resolve(base), resolve(target)).split(/[\\/]/).filter(Boolean);
  let path = resolve(base);
  for (const part of ['', ...parts]) {
    if (part) path = resolve(path, part);
    if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error(`Linked resource path: ${path}`);
  }
}

// Only maintained skill content is distributed; runtime output and caches are not resources.
export function isSkillResource(file) {
  return /^(SKILL\.md|LICENSE(?:\.txt)?|(?:references|templates|scripts|assets)\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_.-]+\.(?:md|txt|json|csv|ts|js|mjs|py|ps1|sh|xml|html|css|png|jpg|jpeg|svg|webp))$/.test(file)
    && !file.split('/').some(part => part.startsWith('.') || ['node_modules', '__pycache__', 'output'].includes(part));
}

export function skillResources(root, name) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 64) throw new Error(`Invalid skill name: ${name}`);
  const base = resolve(root, 'skills', name);
  assertUnlinked(root, base);
  const files = [];
  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name))) {
      const path = resolve(dir, entry.name);
      assertUnlinked(base, path);
      if (entry.isDirectory()) walk(path);
      else {
        const file = relative(base, path).replaceAll('\\', '/');
        if (!entry.isFile() || !isSkillResource(file)) throw new Error(`Unsupported skill resource: ${name}/${file}`);
        files.push({ source: path, relative: file });
      }
    }
  }
  walk(base);
  if (!files.some(file => file.relative === 'SKILL.md')) throw new Error(`Missing SKILL.md: ${name}`);
  return files;
}

export function validateSkillResources(root, name) {
  const files = skillResources(root, name);
  const base = resolve(root, 'skills', name);
  const content = readFileSync(resolve(base, 'SKILL.md'), 'utf8').replaceAll('\r\n', '\n');
  const frontmatter = content.match(/^---\n([\s\S]*?)\n---/);
  const field = key => frontmatter?.[1].match(new RegExp(`^${key}:\\s*(.+)$`, 'm'))?.[1].trim().replace(/^['"]|['"]$/g, '');
  if (field('name') !== name || !field('description') || field('description').length > 1024) throw new Error(`Invalid skill frontmatter: ${name}`);
  if (content.split('\n').length > 500) throw new Error(`Skill entry exceeds 500 lines: ${name}`);
  const known = new Set(files.map(file => file.source));
  for (const file of files.filter(file => file.relative.endsWith('.md'))) {
    const text = readFileSync(file.source, 'utf8');
    for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      const link = match[1].trim();
      if (/^(?:https?:|mailto:|#)/i.test(link)) continue;
      const path = resolve(dirname(file.source), link.split('#')[0]);
      if (!contained(base, path) || !known.has(path)) throw new Error(`Broken or non-local skill link: ${name}/${file.relative} -> ${link}`);
    }
  }
  return files;
}
