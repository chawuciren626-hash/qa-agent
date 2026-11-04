import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { startWslLoopbackRelay } from '../../scripts/wsl-loopback-relay.mjs';

test('short lived relay reaches one target and closes after the attempt', async () => {
  const target = createServer((request, response) => response.end('authorized target'));
  await new Promise(resolve => target.listen(0, '127.0.0.1', resolve));
  const relay = await startWslLoopbackRelay({ host: '127.0.0.1', peer: '127.0.0.1', targetHost: '127.0.0.1', targetPort: target.address().port });
  try {
    const response = await fetch(`http://127.0.0.1:${relay.port}/`);
    assert.equal(await response.text(), 'authorized target');
  } finally { await relay.close(); await new Promise(resolve => target.close(resolve)); }
  await assert.rejects(new Promise((resolve, reject) => {
    const socket = connect(relay.port, '127.0.0.1');
    socket.once('connect', resolve); socket.once('error', reject);
  }));
});
