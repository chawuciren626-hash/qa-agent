/** Short-lived TCP relay from one WSL peer to one authorized Windows loopback port. */
import { spawnSync } from 'node:child_process';
import { networkInterfaces } from 'node:os';
import { createConnection, createServer } from 'node:net';

function ipv4(value) {
  return /^(?:\d{1,3}\.){3}\d{1,3}$/.test(value) && value.split('.').every(part => Number(part) <= 255);
}

export function wslNetworkAddresses(wsl, distro, env = process.env) {
  const interfaces = Object.entries(networkInterfaces()).filter(([name]) => /WSL/i.test(name));
  const hosts = interfaces.flatMap(([, rows]) => rows ?? []).filter(row => row.family === 'IPv4' && !row.internal).map(row => row.address);
  if (hosts.length !== 1 || !ipv4(hosts[0])) throw new Error('Expected one Windows WSL virtual adapter address');
  const command = (program, args) => spawnSync(wsl, ['-d', distro, '-u', 'root', '--cd', '/', '--exec', program, ...args], {
    encoding: 'utf8', windowsHide: true, timeout: 10000,
    env: Object.fromEntries(Object.entries(env).filter(([key]) => ['SystemRoot', 'WINDIR', 'PATH', 'PATHEXT'].some(name => name.toLowerCase() === key.toLowerCase()))),
  });
  const resolver = command('/bin/cat', ['/etc/resolv.conf']);
  const nameservers = [...(resolver.stdout ?? '').matchAll(/^nameserver\s+(\S+)/gm)].map(match => match[1]);
  if (resolver.status !== 0 || !nameservers.includes(hosts[0])) throw new Error('WSL resolver does not identify the Windows virtual adapter');
  const peer = command('/bin/hostname', ['-I']);
  const peers = (peer.stdout ?? '').trim().split(/\s+/).filter(ipv4);
  if (peer.status !== 0 || peers.length !== 1) throw new Error('Cannot identify the WSL peer address');
  return { host: hosts[0], peer: peers[0] };
}

export async function startWslLoopbackRelay({ host, peer, targetHost, targetPort }) {
  if (![host, peer].every(ipv4) || !['127.0.0.1', '::1'].includes(targetHost) ||
      !Number.isSafeInteger(targetPort) || targetPort < 1 || targetPort > 65535) throw new Error('Invalid WSL loopback relay target');
  const sockets = new Set();
  const server = createServer(client => {
    sockets.add(client);
    client.once('close', () => sockets.delete(client));
    if (client.remoteAddress !== peer) { client.destroy(); return; }
    const upstream = createConnection({ host: targetHost, port: targetPort });
    sockets.add(upstream);
    upstream.once('close', () => sockets.delete(upstream));
    client.on('error', () => upstream.destroy());
    upstream.on('error', () => client.destroy());
    client.on('close', () => upstream.destroy());
    upstream.on('close', () => client.destroy());
    client.pipe(upstream);
    upstream.pipe(client);
  });
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, host, resolve); });
  } catch (error) { server.close(); throw error; }
  let closed = false;
  return { host, port: server.address().port, close: async () => {
    if (closed) return;
    closed = true;
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  } };
}
