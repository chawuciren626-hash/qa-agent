import { readFileSync, lstatSync, realpathSync } from 'node:fs';
import { resolve, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isSkillResource } from './skill-resources.mjs';

export function releaseResources(root,policy) {
  if(policy.version!==1 || !Array.isArray(policy.files) || !policy.files.length) throw new Error('Invalid release allowlist');
  const seen=new Set();
  for(const file of policy.files) {
    if(typeof file!=='string' || isAbsolute(file) || file.includes('\\') || file.split('/').some(p=>['.','..',''].includes(p)) || seen.has(file)) throw new Error('Invalid or duplicate release path');
    const skill = file.match(/^skills\/([a-z0-9]+(?:-[a-z0-9]+)*)\/(.+)$/);
    const skillResource = skill && isSkillResource(skill[2]);
    if(!skillResource && !/^(scripts\/[^/]+\.(mjs|py)|schemas\/[^/]+\.json|penguin\/.*\.(json|md|mjs)|config\/[^/]+\.json|package(-lock)?\.json|playwright\.config\.ts|tsconfig\.playwright\.json)$/.test(file)) throw new Error(`Runtime data is not a release resource: ${file}`);
    if(/^(config\/(test-env|test-environments|test-assets|session-workspaces)\.json|penguin\/.*\/project\.json)$/.test(file) || /\/(tmp-|check-path|run-retest|run-tms-tests|update-test-results)/.test(file)) throw new Error('Local configuration or historical helper cannot be released');
    const path=resolve(root,file);
    if(!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink() || realpathSync(path)!==path) throw new Error('Release source missing or linked');
    seen.add(file);
  }
  return {status:'allowlist_valid',files:seen.size,exe_ready:false};
}

if(process.argv[1] && pathToFileURL(resolve(process.argv[1])).href===import.meta.url) {
  const root=resolve(import.meta.dirname,'..');
  console.log(JSON.stringify(releaseResources(root,JSON.parse(readFileSync(resolve(root,'config/release-resources.json'),'utf8')))));
}
