/** AITestHarness engine modules, selected only by the trusted process launcher. */
import { createRequire } from "node:module";
import { isAbsolute, resolve } from "node:path";

const root = process.env.AITEST_ENGINE_ROOT;
if (root && !isAbsolute(root)) throw new Error("AITEST_ENGINE_ROOT must be absolute");
const require = createRequire(import.meta.url);
export const qaEnabled = !!root;
export function qaEngineModule(name: string): any {
  if (!root) throw new Error("AITestHarness integration is disabled");
  if (!/^[a-z-]+$/.test(name)) throw new Error("Invalid engine module");
  return require(resolve(root, "scripts", `${name}.mjs`));
}
export function qaProtectInput<T>(workspace: string | undefined, value: T): T {
  return root ? qaEngineModule("host-observability").protectHostInput(workspace, value) : value;
}
