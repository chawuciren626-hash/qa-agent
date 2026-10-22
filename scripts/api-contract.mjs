import { createHash } from 'node:crypto';
import { parseDocument } from 'yaml';

export const apiHash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
export function inspectApiContract(bytes, { operations = [], source_path = null } = {}) {
  if (Buffer.byteLength(bytes) > 4 * 1024 * 1024) throw new Error('API document exceeds 4 MiB');
  const parsed = parseDocument(String(bytes), { uniqueKeys: true });
  if (parsed.errors.length) throw new Error('Invalid JSON/YAML API document');
  const doc = parsed.toJS({ maxAliasCount: 50 });
  if (!doc || !['2.0'].includes(doc.swagger) && !/^3\.0\.\d+$/.test(doc.openapi ?? '')) throw new Error('Only Swagger 2.0 and OpenAPI 3.0 are supported; 3.1 dialect requires separate validation');
  const limitations = new Set();
  let nodes=0;
  function dereference(value, seen = new Set(), depth = 0) {
    if(++nodes>50000) throw new Error('API reference expansion limit exceeded; select a smaller document');
    if (depth > 40) { limitations.add('reference_depth_limit'); return { unsupported: 'depth_limit' }; }
    if (!value || typeof value !== 'object') return value;
    if (value.$ref) {
      const ref = value.$ref;
      if (!ref.startsWith('#/')) { limitations.add(`external_ref:${ref}`); return { $ref: ref, unsupported: 'external_ref_not_fetched' }; }
      if (seen.has(ref)) { limitations.add(`cyclic_ref:${ref}`); return { $ref: ref, unsupported: 'cyclic_ref' }; }
      const target = ref.slice(2).split('/').reduce((v, k) => v && Object.hasOwn(v, k.replaceAll('~1', '/').replaceAll('~0', '~')) ? v[k.replaceAll('~1', '/').replaceAll('~0', '~')] : undefined, doc);
      if (target === undefined) throw new Error('Unresolved local API reference');
      return dereference(target, new Set([...seen, ref]), depth + 1);
    }
    if (Array.isArray(value)) return value.map(v => dereference(v, seen, depth + 1));
    if (value.discriminator || value.xml || value.nullable) limitations.add('OpenAPI-specific schema keywords require explicit adaptation before Ajv assertions');
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, dereference(v, seen, depth + 1)]));
  }
  const entries = [];
  for (const [path, raw] of Object.entries(doc.paths ?? {})) {
    const item = dereference(raw);
    for (const method of ['get', 'head', 'options', 'post', 'put', 'patch', 'delete']) {
      if (!item[method]) continue;
      const id = `${method.toUpperCase()} ${path}`;
      if (operations.length && !operations.includes(id)) continue;
      const operation = dereference(item[method]);
      entries.push({ id, method: method.toUpperCase(), path, operation_id: operation.operationId ?? id, summary: operation.summary ?? '', parameters: [...(item.parameters ?? []), ...(operation.parameters ?? [])], request_body: operation.requestBody ?? null, responses: operation.responses ?? {}, security: operation.security ?? doc.security ?? [], servers: operation.servers ?? item.servers ?? doc.servers ?? [] });
    }
  }
  if (operations.some(id => !entries.some(e => e.id === id))) throw new Error('Selected operation not found in contract');
  return { version: 1, source_path, source_sha256: apiHash(bytes), dialect: doc.openapi ?? doc.swagger, operations: entries, security_schemes: dereference(doc.components?.securitySchemes ?? doc.securityDefinitions ?? {}), servers: doc.servers ?? (doc.host ? [{ url: `${doc.schemes?.[0] ?? 'https'}://${doc.host}${doc.basePath ?? ''}` }] : []), limitations: [...limitations] };
}
