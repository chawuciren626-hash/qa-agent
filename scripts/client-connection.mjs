/** A remote desktop is a client of the configured business service, never another server. */
export function remoteClientConnection(value) {
  if (value === undefined) return null;
  if (!value || value.mode !== 'remote' || typeof value.origin !== 'string' ||
      value.origin !== value.origin.trim() || /[\x00-\x20\\]/.test(value.origin)) {
    throw Error('Invalid remote client connection');
  }
  let url;
  try { url = new URL(value.origin); } catch { throw Error('Invalid remote service origin'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
      !(url.protocol === 'https:' || (url.protocol === 'http:' && loopback))) {
    throw Error('Remote service requires an HTTPS origin (HTTP allowed only on loopback)');
  }
  return { mode: 'remote', origin: url.origin };
}

/** Public readiness probe: never read or send a local API token to the remote service. */
export async function inspectRemoteService(connection, { fetcher = fetch } = {}) {
  const { origin } = remoteClientConnection(connection);
  try {
    const response = await fetcher(`${origin}/user/login`, {
      // Deployment can block the event loop while copying/verifying files. Do not
      // reuse a pooled connection that the server may close during that pause.
      headers: { connection: 'close' },
      redirect: 'error', signal: AbortSignal.timeout(8000),
    });
    const html = await response.text();
    if (!response.ok || !/text\/html/i.test(response.headers.get('content-type') ?? '') ||
        !/<!doctype html>/i.test(html) || !/<html[\s>]/i.test(html)) {
      return { status: 'unhealthy', mode: 'remote', origin, read_only: true, http_status: response.status };
    }
    return { status: 'ready', mode: 'remote', origin, read_only: true,
      scope: 'remote_login_page', authenticated: false };
  } catch {
    return { status: 'unreachable', mode: 'remote', origin, read_only: true };
  }
}
