/** Run the compiled source platform with explicitly isolated data; never patches a bundle. */
import {spawn} from 'node:child_process';
import {existsSync,mkdirSync} from 'node:fs';
import {resolve,dirname,delimiter,isAbsolute} from 'node:path';
import {pathToFileURL} from 'node:url';
import {assertPlainPath,within} from './application-data.mjs';

export function sourcePlatformLaunch({engine=resolve(import.meta.dirname,'..'),dataRoot,port=7378,env=process.env}={}) {
  if(Number(process.versions.node.split('.')[0])<24) throw Error('Source platform requires Node.js 24 or newer');
  if(!dataRoot || !isAbsolute(dataRoot)) throw Error('Pass --data-root=<absolute development directory>');
  dataRoot=assertPlainPath(dataRoot);
  if(within(engine,dataRoot) || within(dataRoot,engine)) throw Error('Development data must be separate from source');
  // Never silently open the installed application's DB or workspace.
  if(existsSync(resolve(dataRoot,'installation.json')) || existsSync(resolve(dataRoot,'web.db'))) throw Error('Choose a dedicated source development directory, not an existing installation or host-data directory');
  if(!Number.isInteger(port) || port<0 || port>65535) throw Error('Invalid port');
  const entry=resolve(engine,'platform/packages/server/dist/index.js');
  const web=resolve(engine,'platform/packages/web/dist');
  if(!existsSync(entry) || !existsSync(resolve(web,'index.html'))) throw Error('Build source server and web first; see platform/INTEGRATION.md');
  const childEnv={...env};
  for(const key of ['QA_DIRECTORY_CONTEXT','PENGUIN_DESKTOP_TOKEN','PENGUIN_PORT_FILE','PENGUIN_WEB_DB','PENGUIN_CLI_ENTRY','PENGUIN_AGENT_ROOT']) delete childEnv[key];
  const pathKey=Object.keys(childEnv).find(k=>k.toLowerCase()==='path') ?? 'PATH';
  childEnv[pathKey]=dirname(process.execPath)+delimiter+(childEnv[pathKey]??'');
  return {entry,cwd:engine,env:{...childEnv,AITEST_ENGINE_ROOT:engine,PENGUIN_HOME:resolve(dataRoot,'host'),QA_APP_DATA_ROOT:resolve(dataRoot,'qa'),QA_WORKSPACE_ROOT:resolve(dataRoot,'workspaces'),PENGUIN_WEB_DIST:web,PENGUIN_PORT_FILE:resolve(dataRoot,'server-port.json'),HOST:'127.0.0.1',PORT:String(port)}};
}

if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  const args=new Map(process.argv.slice(2).map(arg=>{const match=/^--(data-root|port)=(.+)$/.exec(arg);if(!match) throw Error('Use --data-root=<absolute directory> [--port=7378]');return [match[1],match[2]];}));
  const launch=sourcePlatformLaunch({dataRoot:args.get('data-root'),port:Number(args.get('port')??7378)});
  mkdirSync(dirname(launch.env.PENGUIN_PORT_FILE),{recursive:true});
  const child=spawn(process.execPath,[launch.entry],{cwd:launch.cwd,env:launch.env,stdio:'inherit',windowsHide:true});
  child.once('error',error=>{console.error(error.message);process.exitCode=1;});
  child.once('exit',code=>{process.exitCode=code??1;});
}
