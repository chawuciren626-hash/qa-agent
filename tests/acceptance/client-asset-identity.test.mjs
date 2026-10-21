import test from 'node:test';
import assert from 'node:assert/strict';
import { versionClientIndex } from '../../scripts/client-asset-identity.mjs';

const source='<head><script>window.theme="dark"</script><script type="module" crossorigin src="/assets/index-host.js"></script></head>';
test('entry and lazy chunk back-imports resolve to one versioned module identity',()=>{
  const html=versionClientIndex(source,'index-host.js','abcdef12');
  const map=JSON.parse(html.match(/<script type="importmap">(.*?)<\/script>/)[1]);
  const entry=html.match(/src="([^"]+)"/)[1];
  assert.equal(map.imports['/assets/index-host.js'],entry);
  for(const parent of ['highlighter.js','mermaid.js','xterm.js','nested/diagram.js']) {
    const relative=parent.includes('/')?'../index-host.js':'./index-host.js';
    const requested=new URL(relative,'https://client.test/assets/'+parent).pathname;
    assert.equal(map.imports[requested],entry);
  }
  assert.ok(html.indexOf('type="importmap"')<html.indexOf('type="module"'));
  assert.ok(html.includes('<script>window.theme="dark"</script>'));
});
test('updating revision changes both entry and dependency identity without stale aliases',()=>{
  const old=versionClientIndex(source,'index-host.js','aaaa');
  const next=versionClientIndex(source,'index-host.js','bbbb');
  assert.ok(old.includes('?qa-delivery=aaaa'));
  assert.ok(!next.includes('aaaa'));
  assert.equal((next.match(/\?qa-delivery=bbbb/g)??[]).length,2);
});
test('unknown and ambiguous indexes fail before installing an inconsistent graph',()=>{
  assert.throws(()=>versionClientIndex(source+source,'index-host.js','a'),/not unique/);
  assert.throws(()=>versionClientIndex('<head></head>','index-host.js','a'),/not unique/);
  assert.throws(()=>versionClientIndex(source,'../index-host.js','a'),/Invalid/);
  assert.throws(()=>versionClientIndex(source,'index-host.js','<script>'),/Invalid/);
  assert.throws(()=>versionClientIndex(versionClientIndex(source,'index-host.js','a'),'index-host.js','b'),/import map/);
});
