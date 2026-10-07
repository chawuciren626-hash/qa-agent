import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const scenarios = new Set(['healthy', 'defect', 'unavailable']);
const seed = () => [{ id: 1, title: 'Sample document', budget: 120, status: 'draft' }];

export function createAcceptanceServer() {
  const stores = new Map();
  const html = readFileSync(new URL('./site.html', import.meta.url));
  return createServer(async (req, res) => {
    const send = (status, data) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(data));
    };
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) return send(403, { error: 'Origin rejected' });
    if (req.method === 'GET' && url.pathname === '/health') return send(200, { service: 'qa-acceptance-v1', scenarios: [...scenarios] });
    if (req.method === 'GET' && scenarios.has(url.pathname.slice(1))) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(html);
    }
    const match = url.pathname.match(/^\/api\/(healthy|defect|unavailable)\/(items|reset)(?:\/(\d+))?$/);
    if (!match) return send(404, { error: 'Not found' });
    const [, scenario, resource, id] = match;
    const scope = url.searchParams.get('scope');
    if (!scope || !/^[A-Za-z0-9-]{1,100}$/.test(scope)) return send(400, { error: 'Invalid scope' });
    const key = `${scenario}:${scope}`;
    if (!stores.has(key)) {
      if (stores.size >= 500) return send(429, { error: 'Scope capacity reached; restart fixture' });
      stores.set(key, { next: 2, items: seed() });
    }
    const state = stores.get(key);
    if (req.method === 'POST' && resource === 'reset') {
      stores.set(key, { next: 2, items: seed() });
      return send(200, { reset: true });
    }
    if (resource !== 'items') return send(405, { error: 'Method not allowed' });
    if (req.method === 'GET') return send(200, { items: state.items });
    if (scenario === 'unavailable') return send(503, { error: 'Fixture service unavailable' });
    if (req.method === 'DELETE' && id) {
      const index = state.items.findIndex(item => item.id === Number(id));
      if (index === -1) return send(404, { error: 'Item not found' });
      state.items.splice(index, 1);
      return send(200, { deleted: true });
    }
    if (req.method !== 'POST' || id) return send(405, { error: 'Method not allowed' });
    try {
      let body = '';
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 8192) return send(413, { error: 'Body too large' });
      }
      const value = JSON.parse(body);
      if (typeof value.title !== 'string' || !value.title.trim() || value.title.trim().length > 40) return send(422, { error: 'Title must contain 1-40 characters' });
      if (!Number.isSafeInteger(value.budget) || (scenario !== 'defect' && value.budget < 0)) return send(422, { error: 'Budget must be a non-negative integer' });
      const item = { id: state.next++, title: value.title.trim(), budget: value.budget, status: 'draft' };
      state.items.push(item);
      return send(201, { item });
    } catch {
      return send(400, { error: 'Invalid JSON' });
    }
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.env.QA_ACCEPTANCE_PORT ?? 4317);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid fixture port');
  const server = createAcceptanceServer();
  server.on('error', error => { console.error(error.message); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => console.log(`QA acceptance: http://127.0.0.1:${port}/healthy?scope=manual`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close());
}
