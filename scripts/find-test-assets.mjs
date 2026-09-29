import { resolve } from "node:path";
import { catalogPath, readCatalog } from "./test-asset-catalog.mjs";

const root = resolve(import.meta.dirname, "..");
const args = Object.fromEntries(process.argv.slice(2).filter((arg) => arg.startsWith("--") && arg.includes("=")).map((arg) => {
  const [key, value] = arg.slice(2).split(/=(.*)/s);
  return [key, value];
}));
const catalog = readCatalog(catalogPath(root, args.file));
const tags = (args.tags ?? "").split(",").filter(Boolean);
const assets = catalog.assets.filter((asset) =>
  (!args.kind || asset.kind === args.kind) &&
  (!args.status || asset.status === args.status) &&
  (!args.environment || asset.scope?.environments?.includes(args.environment)) &&
  tags.every((tag) => asset.tags.includes(tag))
).map(({ id, kind, name, version, status, scope, tags: assetTags, validation }) => ({ id, kind, name, version, status, scope, tags: assetTags, validation }));
console.log(JSON.stringify({ total: assets.length, assets }, null, 2));
