import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { loadTrustedLocalAdapters, localAdapterHash } from "../src/auth/trusted-local-adapters.js";

it("loads a version-pinned shared QA hook only when its local bytes match", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "trusted-qa-hook-"));
  const source = path.resolve(import.meta.dirname, "../../../../penguin/hooks/qa-stage-boundary");
  const target = path.join(root, "penguin", "hooks", "qa-stage-boundary");
  try {
    await fs.mkdir(target, { recursive: true });
    for (const name of ["hooks.json", "guard.mjs"]) await fs.copyFile(path.join(source, name), path.join(target, name));
    const hash = await localAdapterHash(root, "qa-stage-boundary");
    const [hook] = await loadTrustedLocalAdapters(root, [{ name: "qa-stage-boundary", version: "2026.11.04.1", hash }]);
    expect(hook?.dir).toBe(target);
    expect(hook?.pre_tool_use[0]?.command).toBe("guard.mjs");
    await fs.appendFile(path.join(target, "guard.mjs"), "\n// changed");
    await expect(loadTrustedLocalAdapters(root, [{ name: "qa-stage-boundary", version: "2026.11.04.1", hash }])).rejects.toThrow("hash mismatch");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

it("loads the Goal hook from the single versioned execution-engine copy", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "trusted-goal-hook-"));
  const source = path.resolve(import.meta.dirname, "../../../../platform/plugins/goal/hooks");
  const target = path.join(root, "platform", "plugins", "goal", "hooks");
  try {
    await fs.mkdir(target, { recursive: true });
    for (const name of ["hooks.json", "lib.mjs", "start.mjs", "stop.mjs"])
      await fs.copyFile(path.join(source, name), path.join(target, name));
    const hash = await localAdapterHash(root, "goal");
    const [hook] = await loadTrustedLocalAdapters(root, [{ name: "goal", version: "2026.10.23.1", hash }]);
    expect(hook?.name).toBe("goal");
    expect(hook?.stop.length).toBeGreaterThan(0);
    await fs.appendFile(path.join(target, "stop.mjs"), "\n// changed");
    await expect(loadTrustedLocalAdapters(root, [{ name: "goal", version: "2026.10.23.1", hash }])).rejects.toThrow("hash mismatch");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
