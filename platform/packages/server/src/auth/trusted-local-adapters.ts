import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { readHookManifest, type InstalledHook } from "@prismshadow/penguin-core";

const FILES: Record<string, readonly string[]> = {
  "qa-default-entry": ["hooks.json", "guard.mjs"],
  "qa-delegation-guard": ["hooks.json", "guard.mjs", "finish.mjs"],
  "qa-stage-boundary": ["hooks.json", "guard.mjs"],
  "goal": ["hooks.json", "lib.mjs", "start.mjs", "stop.mjs"],
};

const adapterDir = (engineRoot: string, name: string): string => name === "goal"
  ? path.join(engineRoot, "platform", "plugins", "goal", "hooks")
  : path.join(engineRoot, "penguin", "hooks", name);

/** Canonical digest of the trusted files shipped with the local execution adapter. */
export async function localAdapterHash(engineRoot: string, name: string): Promise<string> {
  const files = FILES[name];
  if (!files) throw Error("Unknown trusted local adapter");
  const dir = adapterDir(engineRoot, name);
  const directory = await fs.lstat(dir);
  if (!directory.isDirectory() || directory.isSymbolicLink()) throw Error("Unsafe trusted local adapter directory");
  const entries: [string, string][] = [];
  for (const file of files) {
    const target = path.join(dir, file);
    const stat = await fs.lstat(target);
    if (!stat.isFile() || stat.isSymbolicLink()) throw Error("Unsafe trusted local adapter file");
    entries.push([file, createHash("sha256").update(await fs.readFile(target)).digest("hex")]);
  }
  return `sha256:${createHash("sha256").update(JSON.stringify(entries)).digest("hex")}`;
}

export async function loadTrustedLocalAdapters(
  engineRoot: string,
  adapters: readonly { name: string; version: string; hash: string }[],
): Promise<InstalledHook[]> {
  const seen = new Set<string>();
  const result: InstalledHook[] = [];
  for (const adapter of adapters) {
    if (seen.has(adapter.name)) throw Error("Duplicate trusted local adapter");
    seen.add(adapter.name);
    if (adapter.hash !== await localAdapterHash(engineRoot, adapter.name)) throw Error(`Trusted local adapter hash mismatch: ${adapter.name}`);
    const dir = adapterDir(engineRoot, adapter.name);
    const manifest = await readHookManifest(dir);
    if (!manifest || manifest.name !== adapter.name ||
      (manifest.pre_tool_use.length === 0 && manifest.user_prompt.length === 0 && manifest.stop.length === 0))
      throw Error("Invalid trusted local adapter hook manifest");
    result.push({ ...manifest, version: adapter.version, dir });
  }
  return result;
}
