/** Installation configuration is trusted local input, never a renderer setting. */
import path from "node:path";
import { createRequire } from "node:module";

export function qaInstallation(env: NodeJS.ProcessEnv = process.env) {
  const config = env.AITEST_INSTALLATION_CONFIG;
  if (!config) return null;
  if (!path.isAbsolute(config))
    throw new Error("AITestHarness requires an absolute installation configuration");
  const engine = path.resolve(path.dirname(config), "app/engine");
  const bridge = createRequire(import.meta.url)(path.join(engine, "scripts/product-layout.mjs"));
  const layout = bridge.loadProductLayout(config);
  if (layout.layout !== "unified" || layout.paths.engine !== engine)
    throw new Error("AITestHarness installation engine mismatch");
  return {
    profile: layout.paths.desktop_profile as string,
    env: {
      ...bridge.productEnvironment(layout, env),
      AITEST_ENGINE_ROOT: engine,
      AITEST_MANAGED_RUNTIME: "1",
      PENGUIN_UPDATE_CHECK: "off",
    } as NodeJS.ProcessEnv,
  };
}
