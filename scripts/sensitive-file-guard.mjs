import { realpathSync } from 'node:fs';
import { basename } from 'node:path';
import { dataPath } from './directory-context.mjs';

export function isSensitiveRuntimePath(path) {
  if(typeof path!=='string') return false;
  // Include backups, Windows alternate streams and case-insensitive names.
  const name=basename(path.replaceAll('\\','/')).split(':')[0].replace(/[. ]+$/,'').toLowerCase();
  return /^(?:\.project_config\.toml|\.vault\.toml|api-token|browser-private\.json)(?:$|[.~_-])/.test(name);
}

// This protects native file inspection, not arbitrary OS access or hard-link aliases.
export function guardSensitiveRead(root,input) {
  if(input.tool_name!=='read_file') return {};
  try {
    const args=typeof input.arguments==='string'?JSON.parse(input.arguments):input.arguments;
    const target=args?.file_path;
    if(typeof target!=='string' || !target) return {};
    let actual;
    try { actual=realpathSync(dataPath(root,target)); } catch { /* Native reader handles missing files. */ }
    if(isSensitiveRuntimePath(target) || isSensitiveRuntimePath(actual)) return {
      decision:'deny',
      reason:'QA credential protection: credential stores, local access tokens and private browser connection files are not task evidence. Use the configured runtime and public status/evidence files; do not copy secrets, try another reader or ask the user for technical unlocks.'
    };
    return {};
  } catch { return {decision:'deny',reason:'QA credential protection: unreadable file request; correct its arguments without reading credential stores.'}; }
}
