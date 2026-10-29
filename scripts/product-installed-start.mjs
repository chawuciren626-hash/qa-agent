import {existsSync,readFileSync,mkdirSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {spawn} from 'node:child_process';
import {loadProductLayout,productEnvironment} from './product-layout.mjs';
import {checkProductDesktop} from './product-desktop-adapter.mjs';
import {setupProduct} from './product-setup.mjs';
import {installPenguinRuntime} from './install-penguin-runtime.mjs';
import {checkSourceRuntime} from './source-runtime.mjs';
import {ensureLocalService,registerLocalService} from './local-service.mjs';

try {
  if(process.argv.length!==3)throw new Error('缺少安装配置。');
  const config=resolve(process.argv[2]),layout=loadProductLayout(config);
  if(existsSync(resolve(layout.root,'.source-sync.lock')))throw new Error('本地源码同步正在进行，请稍后重新打开 AITestHarness。');
  if(existsSync(resolve(layout.root,'.product-upgrade/active.json')))throw new Error('安装更新尚未结束。请等待安装器完成；若安装被中断，请重新运行安装包以恢复。');
  if(layout.layout!=='unified'||layout.paths.engine!==resolve(import.meta.dirname,'..'))throw new Error('安装位置与启动入口不一致。');
  const sourceMode=existsSync(resolve(layout.host_app,'aitest-source-runtime.json'));
  if(sourceMode) checkSourceRuntime(layout.host_app,layout.paths.engine);
  else {
  checkProductDesktop(layout.host_app);
  const record=resolve(layout.host_app,'qa-runtime-install.json');
  if(!existsSync(record))setupProduct(config);
  else {
    const installed=JSON.parse(readFileSync(record,'utf8'));
    if(installed.engine_root!==layout.paths.engine)throw new Error('安装目录已移动，请使用迁移工具修复路径。');
    const state=installPenguinRuntime(layout.host_app,layout.paths.engine,'check');
    if(state.status!=='installed'||state.changed)throw new Error('运行组件需要修复，请通过安装器恢复。');
  }
  }
  for(const key of ['host_data','qa_data','desktop_profile','workspaces'])mkdirSync(layout.paths[key],{recursive:true});
  if(sourceMode){registerLocalService(config);await ensureLocalService(config);}
  const child=spawn(layout.paths.host_executable,[],{cwd:dirname(layout.paths.host_executable),env:{...productEnvironment(layout),...(sourceMode?{AITEST_INSTALLATION_CONFIG:config,AITEST_ENGINE_ROOT:layout.paths.engine,AITEST_MANAGED_RUNTIME:'1'}:{}),PENGUIN_SHELL:resolve(process.env.SystemRoot??'C:/Windows','System32/WindowsPowerShell/v1.0/powershell.exe')},detached:true,windowsHide:true,stdio:'ignore'});
  await new Promise((done,reject)=>{child.once('spawn',done);child.once('error',reject);});child.unref();
  console.log(JSON.stringify({status:'desktop_process_started',readiness:'confirmed_by_desktop_bootstrap',pid:child.pid}));
} catch(error) {console.error(error.message);process.exitCode=1;}
