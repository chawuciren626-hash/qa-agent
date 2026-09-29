import { resolve } from "node:path";
import { catalogPath, readCatalog, validateCatalog } from "./test-asset-catalog.mjs";

const root = resolve(import.meta.dirname, "..");
const file = process.argv.find((arg) => arg.startsWith("--file="))?.slice(7);
const path = catalogPath(root, file);
const errors = validateCatalog(readCatalog(path));
console.log(JSON.stringify({ file: path, status: errors.length ? "invalid" : "valid", errors }, null, 2));
process.exitCode = errors.length ? 2 : 0;
