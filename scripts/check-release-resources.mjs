import { readFileSync, lstatSync, realpathSync } from 'node:fs';
import { resolve, isAbsolute, dirname, relative, extname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isSkillResource } from './skill-resources.mjs';

export function releaseResources(root,policy) {
  if(policy.version!==1 || !Array.isArray(policy.files) || !policy.files.length) throw new Error('Invalid release allowlist');
  const seen=new Set();
  for(const file of policy.files) {
    if(typeof file!=='string' || isAbsolute(file) || file.includes('\\') || file.split('/').some(p=>['.','..',''].includes(p)) || seen.has(file)) throw new Error('Invalid or duplicate release path');
    const skill = file.match(/^skills\/([a-z0-9]+(?:-[a-z0-9]+)*)\/(.+)$/);
    const skillResource = skill && isSkillResource(skill[2]);
    if(!skillResource && !/^platform\/plugins\/goal\/hooks\/(hooks\.json|lib\.mjs|start\.mjs|stop\.mjs)$/.test(file) && !/^(scripts\/[^/]+\.(mjs|py)|acceptance\/(server\.mjs|site\.html)|schemas\/[^/]+\.json|docs\/[^/]+\.md|penguin\/.*\.(json|md|mjs)|penguin\/ui\/[^/]+\.(css|svg|png|ico)|config\/[^/]+\.json|package(-lock)?\.json|playwright\.config\.ts|tsconfig\.playwright\.json)$/.test(file)) throw new Error(`Runtime data is not a release resource: ${file}`);
    if(/^(config\/(test-env|test-environments|test-assets|session-workspaces|product-installation\.local)\.json|penguin\/.*\/project\.json)$/.test(file) || /\/(tmp-|check-path|run-retest|run-tms-tests|update-test-results)/.test(file)) throw new Error('Local configuration or historical helper cannot be released');
    const path=resolve(root,file);
    if(!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink() || realpathSync(path)!==path) throw new Error('Release source missing or linked');
    seen.add(file);
  }
  return {status:'allowlist_valid',files:seen.size,exe_ready:false};
}

/** Check local module imports for the complete runtime policy, not small validation fixtures. */
export function assertReleaseImportClosure(root, files) {
  const included = new Set(files);
  for (const file of included) {
    if (extname(file) !== '.mjs') continue;
    const source = readFileSync(resolve(root, file), 'utf8');
    const imports = /^\s*(?:import\s+(?:[^;\n]*?\bfrom\s*)?|export\s+[^;\n]*?\bfrom\s*)['"](\.[^'"\s]+)['"]/gm;
    for (const match of source.matchAll(imports)) {
      const specifier = match[1];
      if (/[?#]/.test(specifier)) continue;
      const target = resolve(dirname(resolve(root, file)), specifier);
      const name = relative(root, target).replaceAll('\\', '/');
      if (!isAbsolute(name) && !name.startsWith('../') && !included.has(name)) {
        throw new Error(`Runtime import missing from release resources: ${file} -> ${name}`);
      }
    }
  }
  return { status: 'import_closure_valid', files: included.size };
}

if(process.argv[1] && pathToFileURL(resolve(process.argv[1])).href===import.meta.url) {
  const root=resolve(import.meta.dirname,'..');
  const policy=JSON.parse(readFileSync(resolve(root,'config/release-resources.json'),'utf8'));
  const result=releaseResources(root,policy);
  assertReleaseImportClosure(root,[...policy.files,'scripts/qa-project-bootstrap.mjs','scripts/trace-outcome.mjs','scripts/source-runtime.mjs']);
  console.log(JSON.stringify(result));
}
