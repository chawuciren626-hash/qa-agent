import { defineConfig } from "tsup";
import { ESM_CJS_BANNER } from "../../scripts/esm-cjs-banner.mjs";
import { buildGitDefine } from "../../scripts/build-git-stamp.mjs";
import path from "node:path";
import fs from "node:fs";
/** Incremental source-runtime deployment: no installer or local business server build. */
export default defineConfig({
  entry: { main: "src/main.ts", "execution-worker": "src/execution-worker.ts" },
  format: ["esm"], target: "node24", platform: "node", clean: false, splitting: false,
  external: ["electron"], banner: { js: ESM_CJS_BANNER }, define: buildGitDefine(),
  esbuildPlugins: [{ name: "workspace-core-build", setup(build) {
    const root = path.resolve(import.meta.dirname, "../core");
    const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    build.onResolve({ filter: /^@prismshadow\/penguin-core(?:\/.*)?$/ }, args => {
      const suffix = args.path.slice("@prismshadow/penguin-core".length);
      const entry = manifest.exports["." + suffix];
      return { path: path.resolve(root, typeof entry === "string" ? entry : entry.import) };
    });
  } }],
});
