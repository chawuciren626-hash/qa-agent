/** Callback targets are checked at configuration time and again at socket lookup. */
import { BlockList, isIP } from 'node:net';
import { lookup } from 'node:dns';
import { Agent, fetch } from 'undici';

const blocked = new BlockList();
for (const [ip, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 3],
] as const) blocked.addSubnet(ip, bits, 'ipv4');
const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
blocked.addSubnet('2001::', 23, 'ipv6');
blocked.addSubnet('2001:db8::', 32, 'ipv6');
blocked.addSubnet('2002::', 16, 'ipv6');

export function isPrivateHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '');
  const family = isIP(host);
  if (family === 4) return blocked.check(host, 'ipv4');
  // Refuse IPv4-mapped/compatible addresses and transition prefixes as well.
  if (family === 6) return !globalV6.check(host, 'ipv6') || blocked.check(host, 'ipv6');
  return !host.includes('.') || /\.(localhost|local|internal|lan)$/.test(host);
}

export interface CallbackGuard { allowedHosts: ReadonlySet<string> }
export type CallbackVerdict = { ok: true; url: URL } |
  { ok: false; reason: 'invalid_callback_url' | 'blocked_callback_target'; detail?: string };

export function checkCallbackUrl(raw: string, guard: CallbackGuard): CallbackVerdict {
  let url: URL;
  try { url = new URL(raw); } catch { return { ok: false, reason: 'invalid_callback_url' }; }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash)
    return { ok: false, reason: 'invalid_callback_url' };
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (isPrivateHostname(host) && !guard.allowedHosts.has(host)) return { ok: false, reason: 'blocked_callback_target' };
  return { ok: true, url };
}

/** Lookup used by the actual connection: no second DNS lookup after validation. */
export function guardedLookup(allowedHosts: ReadonlySet<string>, resolver = lookup): typeof lookup {
  return ((hostname: string, options: { all?: boolean }, callback: (...args: any[]) => void) => {
    resolver(hostname, { all: true, verbatim: true }, (error, addresses) => {
      if (error) return callback(error);
      const approved = allowedHosts.has(hostname.toLowerCase().replace(/\.$/, ''));
      if (!addresses.length || (!approved && addresses.some(item => isPrivateHostname(item.address))))
        return callback(new Error('blocked_callback_target'));
      if (options.all) callback(null, addresses);
      else callback(null, addresses[0]!.address, addresses[0]!.family);
    });
  }) as typeof lookup;
}

export async function guardedCallbackFetch(url: string, init: {
  method: 'POST'; headers: Record<string, string>; body: string; redirect: 'manual'; signal: AbortSignal;
}, allowedHosts: ReadonlySet<string>): Promise<{status: number; location: string | null}> {
  const verdict = checkCallbackUrl(url, { allowedHosts });
  if (!verdict.ok) throw new Error(verdict.reason);
  const dispatcher = new Agent({ connect: { lookup: guardedLookup(allowedHosts), timeout: 10_000 } });
  try {
    const response = await fetch(url, { ...init, dispatcher });
    const result = { status: response.status, location: response.headers.get('location') };
    await response.body?.cancel();
    return result;
  } finally { await dispatcher.destroy(); }
}
