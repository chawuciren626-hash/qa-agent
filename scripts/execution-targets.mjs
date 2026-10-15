import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { resourcePath } from './directory-context.mjs';

export function executionScriptFiles(directory) {
  const files = [];
  const walk = path => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error('Symlink in execution scripts');
      const child = resolve(path, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (/\.[cm]?[jt]sx?$/.test(entry.name)) files.push(child);
    }
  };
  walk(directory);
  return files;
}

export function assertExecutionTargets(root, plan, scriptFiles) {
  const environment = JSON.parse(readFileSync(resourcePath(root, plan.environment_config), 'utf8'));
  const base = new URL(environment.base_url).origin;
  const allowed = new Set([base, ...(environment.allowed_test_origins ?? []).map(value => new URL(value).origin)]);
  for (const path of scriptFiles) {
    const source = readFileSync(path, 'utf8');
    for (const match of source.matchAll(/https?:\/\/[^\s"'`<>\\]+/g)) {
      const literal = match[0].replace(/[),;]+$/, '');
      let origin;
      try { origin = new URL(literal).origin; } catch { continue; }
      if (!allowed.has(origin)) throw new Error(`Execution script target ${origin} differs from selected environment ${base}; use a matching run environment or an explicit allowed_test_origins entry`);
    }
  }
}
