// Vite chunks import shared exports back from the unversioned entry filename.
// A query added only to <script src> otherwise creates a second ES module and
// executes the application bootstrap again (possibly from an older HTTP cache).
export function versionClientIndex(html, asset, revision) {
  if (!/^index-[\w-]+\.js$/.test(asset) || !/^[a-f0-9]+$/.test(revision)) throw new Error('Invalid client asset identity');
  if (/<script\b[^>]*\btype\s*=\s*["']importmap["']/i.test(html)) throw new Error('Unexpected existing client import map');
  const path = `/assets/${asset}`, anchor = `src="${path}"`;
  const tags = [...html.matchAll(/<script\b[^>]*>/g)].filter(match => match[0].includes(anchor));
  if (tags.length !== 1 || html.split(anchor).length !== 2) throw new Error('Original application index anchor not unique');
  const url = `${path}?qa-delivery=${revision}`;
  const map = `<script type="importmap">${JSON.stringify({imports:{[path]:url}})}</script>\n`;
  const tag = tags[0];
  return html.slice(0,tag.index) + map + tag[0].replace(anchor,`src="${url}"`) + html.slice(tag.index+tag[0].length);
}
