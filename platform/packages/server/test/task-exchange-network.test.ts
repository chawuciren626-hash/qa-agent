import { createServer } from 'node:http';
import type { lookup } from 'node:dns';
import { expect, it } from 'vitest';
import { checkCallbackUrl, guardedCallbackFetch, guardedLookup } from '../src/taskexchange/ssrf.js';

it('refuses mapped IPv6, reserved ranges and embedded credentials', () => {
  for (const url of ['http://[::ffff:7f00:1]/', 'http://224.0.0.1/', 'https://user:secret@example.com/'])
    expect(checkCallbackUrl(url, { allowedHosts: new Set() }).ok).toBe(false);
});

it('checks the addresses passed directly to the socket, including mixed DNS answers', async () => {
  const resolve = ((host: string, options: unknown, cb: Function) => cb(null, [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }])) as unknown as typeof lookup;
  await expect(new Promise((yes, no) => guardedLookup(new Set(), resolve)('example.com', { all: true }, (error, addresses) => error ? no(error) : yes(addresses)))).rejects.toThrow('blocked_callback_target');
  const approved = await new Promise((yes, no) => guardedLookup(new Set(['example.com']), resolve)('example.com', { all: true }, (error, addresses) => error ? no(error) : yes(addresses)));
  expect(approved).toHaveLength(2);
});

it('delivers to an explicitly approved test endpoint and cancels an unfinished response body', async () => {
  const server = createServer((req, res) => { req.resume(); res.writeHead(200); res.write('partial'); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  try {
    const url = `http://127.0.0.1:${address.port}/callback`;
    const init = { method: 'POST' as const, headers: {}, body: '{}', redirect: 'manual' as const, signal: AbortSignal.timeout(3000) };
    await expect(guardedCallbackFetch(url, init, new Set())).rejects.toThrow('blocked_callback_target');
    expect(await guardedCallbackFetch(url, init, new Set(['127.0.0.1']))).toMatchObject({ status: 200 });
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
