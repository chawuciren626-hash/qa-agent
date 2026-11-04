/** Runs inside bwrap, forwarding only this attempt's local target to the Windows relay. */
import { spawn } from 'node:child_process';
import { createConnection, createServer } from 'node:net';

const [cli, ...args] = process.argv.slice(2);
const host = process.env.QA_WSL_RELAY_HOST;
const port = Number(process.env.QA_WSL_RELAY_PORT);
const localPort = Number(process.env.QA_WSL_LOCAL_PORT);
if (!cli || !/^(?:\d{1,3}\.){3}\d{1,3}$/.test(host ?? '') ||
    ![port, localPort].every(value => Number.isSafeInteger(value) && value > 0 && value <= 65535)) {
  throw new Error('Invalid local Playwright gateway configuration');
}
const sockets = new Set();
const server = createServer(client => {
  sockets.add(client);
  client.once('close', () => sockets.delete(client));
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(client.remoteAddress)) { client.destroy(); return; }
  const upstream = createConnection({ host, port });
  sockets.add(upstream);
  upstream.once('close', () => sockets.delete(upstream));
  client.on('error', () => upstream.destroy());
  upstream.on('error', () => client.destroy());
  client.on('close', () => upstream.destroy());
  upstream.on('close', () => client.destroy());
  client.pipe(upstream);
  upstream.pipe(client);
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen({ port: localPort, host: '::', ipv6Only: false }, resolve); });
const child = spawn('/usr/local/bin/node', [cli, ...args], { stdio: 'inherit', env: process.env });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve(code ?? (signal ? 128 : 1))); });
for (const socket of sockets) socket.destroy();
await new Promise(resolve => server.close(resolve));
process.exitCode = code;
