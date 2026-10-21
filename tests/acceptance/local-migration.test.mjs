import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
import {probePython} from '../../scripts/command-runtime.mjs';
test('offline migration preserves credentials and delivery bytes while rebinding explicit metadata, including long Windows paths',{skip:process.platform!=='win32'},()=>{
  const python=probePython();assert.equal(python.status,'ready');
  const result=spawnSync(python.executable,[resolve(import.meta.dirname,'local_migration_contract.py')],{encoding:'utf8',windowsHide:true,timeout:60000});
  assert.equal(result.status,0,result.stdout+'\n'+result.stderr);
});
