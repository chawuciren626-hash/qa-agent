import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadProductLayout } from './product-layout.mjs';

/** Read-only installed-runtime check. Run after synchronizing or installing a candidate. */
export async function verifyProductInstallation(configPath) {
  const layout = loadProductLayout(resolve(configPath));
  const entry = resolve(layout.paths.engine, 'scripts/product-entry.mjs');
  const inspect = command => {
    const child = spawnSync(layout.paths.node, [entry, command, `--config=${resolve(configPath)}`],
      { encoding: 'utf8', windowsHide: true, timeout: 60000 });
    if (child.status !== 0) throw Error(`${command} failed: ${child.stderr?.slice(-1000) || child.stdout?.slice(-1000)}`);
    return JSON.parse(child.stdout);
  };
  const doctor = inspect('doctor');
  if (doctor.status !== 'ready' || doctor.checks?.some(check => check.status !== 'ready')) throw Error('Installed product doctor is not ready');
  const service = inspect('status');
  if (service.status !== 'ready') throw Error(`Installed service is ${service.status}`);
  const origin = `http://127.0.0.1:${service.port}`;
  const page = await fetch(`${origin}/`, { signal: AbortSignal.timeout(5000) });
  const html = await page.text();
  if (!page.ok || !/<!doctype html>/i.test(html) || !/<html[\s>]/i.test(html)) throw Error('Installed frontend page unavailable');
  const assets = [...new Set([...html.matchAll(/(?:src|href)="([^"?#]+\.(?:js|css))(?:\?[^\"]*)?"/g)]
    .map(match => match[1]).filter(value => value.startsWith('/')))];
  if (!assets.some(value => value.endsWith('.js')) || !assets.some(value => value.endsWith('.css'))) {
    throw Error('Installed frontend is missing linked JS or CSS');
  }
  for (const asset of assets) {
    const response = await fetch(new URL(asset, origin), { signal: AbortSignal.timeout(5000) });
    const contentType = response.headers.get('content-type') ?? '';
    const expectedType = asset.endsWith('.js') ? /javascript/ : /css/;
    if (!response.ok || !expectedType.test(contentType) || !(await response.arrayBuffer()).byteLength) {
      throw Error(`Installed frontend asset unavailable or invalid: ${asset}`);
    }
  }
  return { status: 'passed', installationId: layout.installation_id, hostVersion: doctor.host_version,
    runtimeFiles: doctor.checks.find(check => check.id === 'host_version')?.verification?.files ?? null,
    serviceVersion: service.version, frontend: 'loaded', assets };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const match = /^--config=(.+)$/.exec(process.argv[2] ?? '');
  if (!match || process.argv.length !== 3) throw Error('Use --config=PATH');
  try { console.log(JSON.stringify(await verifyProductInstallation(match[1]), null, 2)); }
  catch (error) { console.error(JSON.stringify({ status: 'failed', message: error.message })); process.exitCode = 1; }
}
