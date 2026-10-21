import { readFileSync } from 'node:fs';
import { dirname, resolve, basename, delimiter } from 'node:path';
import { createHash } from 'node:crypto';
import Ajv from 'ajv';
import { assertPlainPath, within } from './application-data.mjs';

const schema = JSON.parse(readFileSync(new URL('../schemas/product-installation.schema.json', import.meta.url), 'utf8'));
const validate = new Ajv({allErrors: true}).compile(schema);
export function resolveProductLayout(value, configFile) {
  if (!validate(value)) throw new Error('Invalid installation configuration: '+validate.errors.map(e=>`${e.instancePath || '/'} ${e.message}`).join('; '));
  const inputs=[value.root,...Object.values(value.paths)];
  if(inputs.some(p=>/[\x00-\x1f]/.test(p) || p.trim()!==p)) throw new Error('Installation paths contain control characters or surrounding whitespace');
  const root=assertPlainPath(resolve(dirname(resolve(configFile)),value.root));
  const paths=Object.fromEntries(Object.entries(value.paths).map(([key,p])=>[key,assertPlainPath(resolve(root,p))]));
  if(basename(paths.host_executable).toLowerCase()!=='penguinharness.exe') throw new Error('Expected PenguinHarness.exe');
  if(value.layout==='unified' && Object.values(paths).some(p=>!within(root,p))) throw new Error('Unified installation paths must stay inside the product root');
  const stores=['host_data','qa_data','desktop_profile','workspaces'];
  const overlaps=(a,b)=>within(a,b)||within(b,a);
  for(let i=0;i<stores.length;i++) {
    const key=stores[i],p=paths[key];
    for(const other of stores.slice(i+1)) if(overlaps(p,paths[other])) throw new Error(`Data directories overlap: ${key}/${other}`);
    for(const program of [paths.engine,dirname(paths.host_executable),dirname(paths.node),...(paths.python?[dirname(paths.python)]:[]),...(paths.browsers?[paths.browsers]:[])]) {
      if(overlaps(p,program)) throw new Error(`Data directory overlaps program files: ${key}`);
    }
  }
  const layout={version:1,installation_id:value.installation_id,layout:value.layout,root,project_id:value.project_id,paths,
    host_app:resolve(dirname(paths.host_executable),'resources/app'),agent_root:resolve(paths.host_data,value.project_id,'agents')};
  return {...layout,fingerprint:createHash('sha256').update(JSON.stringify(layout)).digest('hex')};
}
export function loadProductLayout(file) {
  return resolveProductLayout(JSON.parse(readFileSync(file,'utf8').replace(/^\uFEFF/,'')),file);
}
export function productEnvironment(layout,env=process.env) {
  const result={...env};
  // Do not retain a caller's per-session ownership when starting the desktop application.
  delete result.QA_DIRECTORY_CONTEXT;
  delete result.PENGUIN_DESKTOP_TOKEN;
  delete result.PENGUIN_PORT_FILE;
  delete result.PENGUIN_WEB_DB;
  delete result.PENGUIN_WEB_DIST;
  const pathKey=Object.keys(result).find(k=>k.toLowerCase()==='path') ?? 'PATH';
  result[pathKey]=[dirname(layout.paths.node),...(layout.paths.python?[dirname(layout.paths.python)]:[]),result[pathKey]??''].filter(Boolean).join(delimiter);
  return {...result,PENGUIN_HOME:layout.paths.host_data,PENGUIN_AGENT_ROOT:layout.agent_root,QA_APP_DATA_ROOT:layout.paths.qa_data,
    QA_WORKSPACE_ROOT:layout.paths.workspaces,PYTHONUTF8:'1',PYTHONIOENCODING:'utf-8',
    ...(layout.paths.python?{QA_PYTHON:layout.paths.python}:{}),...(layout.paths.browsers?{PLAYWRIGHT_BROWSERS_PATH:layout.paths.browsers}:{})};
}
