import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAcceptanceServer } from '../../acceptance/server.mjs';

test('fixture API contract, isolation, reset and controlled failure', async () => {
  const server = createAcceptanceServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const root = `http://127.0.0.1:${server.address().port}`;
  const call = (scenario, resource, scope, data, method) => fetch(`${root}/api/${scenario}/${resource}?scope=${scope}`, {
    method: method ?? (data ? 'POST' : 'GET'), headers: {'content-type':'application/json'}, body: data ? JSON.stringify(data) : undefined
  });
  try {
    assert.equal((await (await fetch(`${root}/health`)).json()).service, 'qa-acceptance-v1');
    for (const [title, budget] of [['', 1], ['X'.repeat(41), 1], ['draft', -1], ['draft', 0.5], ['draft', null]]) {
      assert.equal((await call('healthy', 'items', 'scope1', {title,budget})).status, 422);
    }
    assert.equal((await call('healthy','items','scope1',{title:'draft',budget:0})).status,201);
    assert.equal((await (await call('healthy','items','scope1')).json()).items.length,2);
    assert.equal((await (await call('healthy','items','scope2')).json()).items.length,1);
    await call('healthy','reset','scope1',{});
    assert.equal((await (await call('healthy','items','scope1')).json()).items.length,1);
    assert.equal((await call('defect','items','scope1',{title:'negative',budget:-1})).status,201);
    assert.equal((await call('unavailable','items','scope1',{title:'draft',budget:1})).status,503);
    assert.equal((await call('healthy','items/1','scope1',undefined,'DELETE')).status,200);
    assert.equal((await (await call('healthy','items','scope1')).json()).items.length,0);
    assert.equal((await fetch(`${root}/api/healthy/reset?scope=x`,{method:'POST',headers:{origin:'https://other.invalid'}})).status,403);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
