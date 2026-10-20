import test from 'node:test';
import assert from 'node:assert/strict';
import { hostname } from 'node:os';
import { spawnSync } from 'node:child_process';
import { compareProcessIdentity, readProcessIdentity, ownProcessIdentity, ownerHasExited } from '../../scripts/process-identity.mjs';

test('identity comparison distinguishes PID reuse, reboot and unknown ownership',()=>{
  const prior={host:hostname(),pid:42,platform:'win32',process_start:'123456789012345678'};
  assert.equal(compareProcessIdentity(prior,{...prior}),'same');
  assert.equal(compareProcessIdentity(prior,{...prior,process_start:'123456789012345679'}),'replaced');
  for(const other of [null,{...prior,host:'foreign'},{...prior,pid:43},{...prior,process_start:null}])
    assert.equal(compareProcessIdentity(prior,other),'unknown');
  const linux={...prior,platform:'linux',boot_id:'boot-one'};
  assert.equal(compareProcessIdentity(linux,{...linux,boot_id:'boot-two'}),'replaced');
  assert.equal(compareProcessIdentity(linux,{...linux,boot_id:null}),'unknown');
});

test('native identity is stable and an exited owned child is never confused with the current process',()=>{
  const own=ownProcessIdentity();
  if(['win32','linux'].includes(process.platform)) {
    assert.ok(own,'Supported OS must provide creation identity for this regression');
    assert.equal(compareProcessIdentity(own,readProcessIdentity(process.pid)),'same');
    assert.strictEqual(ownProcessIdentity(),own);
    assert.equal(ownerHasExited(process.pid,own),false);
    assert.equal(ownerHasExited(process.pid,{...own,process_start:String(BigInt(own.process_start)-1n)}),true);
  }
  assert.equal(ownerHasExited(process.pid,null),false);
  assert.equal(ownerHasExited(-1,null),false);
  const child=spawnSync(process.execPath,['-e',''],{windowsHide:true});assert.equal(child.status,0);
  assert.equal(ownerHasExited(child.pid,null),true);
  assert.equal(ownerHasExited(child.pid,{host:'foreign-host',pid:child.pid,process_start:'123'}),false);
});
