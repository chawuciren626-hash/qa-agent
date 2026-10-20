import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { patchDesktopBranding } from '../../scripts/install-desktop-branding.mjs';

const source=`app5.setName(identity.name);
  win.once("ready-to-show", () => win?.show());`;
test('desktop branding preserves storage and taskbar identity while updating visible branding',()=>{
  let name='package-name';
  const paths={}; const details=[];
  const identity={name:'PenguinHarness',appUserModelId:'com.prismshadow.penguinharness'};
  vm.runInNewContext(patchDesktopBranding(source),{
    identity,process:{platform:'win32',execPath:'D:\\Program Files\\PenguinHarness\\PenguinHarness.exe'},
    app5:{setName:n=>name=n,getPath:k=>paths[k]??'profile/'+name+'/'+k,setPath:(k,v)=>paths[k]=v,getAppPath:()=>'/app'},
    path9:{join:(...parts)=>parts.join('/')},win:{setAppDetails:d=>details.push(d),once:()=>{}},
  });
  assert.equal(name,'AITestHarness');
  assert.equal(paths.userData,'profile/PenguinHarness/userData');
  assert.equal(paths.sessionData,'profile/PenguinHarness/sessionData');
  assert.equal(details[0].appId,'com.prismshadow.penguinharness');
  assert.equal(details[0].relaunchDisplayName,'AITestHarness');
  assert.equal(details[0].relaunchCommand,'"D:\\Program Files\\PenguinHarness\\PenguinHarness.exe"');
  assert.equal(details[0].appIconPath,'/app/dist/aith-icon.ico');
});
test('unsupported or already patched shells are rejected before installation',()=>{
  assert.throws(()=>patchDesktopBranding('unknown shell'),/Unsupported/);
  assert.throws(()=>patchDesktopBranding(patchDesktopBranding(source)),/Unsupported/);
});
test('Windows icon contains correctly sized PNG images for each desktop scale',()=>{
  const ico=readFileSync(new URL('../../penguin/ui/aith-icon.ico',import.meta.url));
  assert.equal(ico.readUInt16LE(2),1);
  assert.equal(ico.readUInt16LE(4),9);
  for(let i=0;i<9;i++){
    const at=6+i*16,size=ico[at]||256,length=ico.readUInt32LE(at+8),offset=ico.readUInt32LE(at+12);
    assert.ok(offset+length<=ico.length);
    const png=ico.subarray(offset,offset+length);
    assert.equal(png.subarray(1,4).toString(),'PNG');
    assert.equal(png.readUInt32BE(16),size);
    assert.equal(png.readUInt32BE(20),size);
  }
});
