/** AITestHarness integration. Modified from the upstream baseline: see platform/INTEGRATION.md. */
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

// The installation/launcher owns this value. Task text and attachments never select modules.
const root = process.env.AITEST_ENGINE_ROOT;
if (root && !isAbsolute(root)) throw new Error("AITEST_ENGINE_ROOT must be absolute");
const require = createRequire(import.meta.url);
function load(name: string): any {
  return root ? require(resolve(root, "scripts", name + ".mjs")) : null;
}
const workspace = load("penguin-workspace-adapter");
const evidence = load("host-observability");
export const qaEnabled = !!root;
export function qaAssertProjectReady(state: { root: string; projectId: string }): void {
  if (!qaEnabled) return;
  const marker = resolve(state.root, state.projectId, "qa-project.json");
  if (existsSync(marker) && JSON.parse(readFileSync(marker, "utf8")).status !== "ready")
    throw new Error("项目测试能力尚未初始化完成，请完成初始化后再启动任务。");
}
export function qaIsWorkspace(dir: string): boolean {
  return qaEnabled && existsSync(resolve(dir, ".qa-session.json"));
}
export function qaApplies(state: any, opts: any): boolean {
  return workspace?.applies(state, opts) ?? false;
}
export function qaBindWorkspace(state: any, opts: any, id: string, previous: string): string {
  // A trace-less server session may be reconstructed under its existing id after restart.
  // Validate its marker instead of allocating a nested workspace or rewriting its contents.
  if (
    workspace &&
    opts.sessionId &&
    previous &&
    workspace.contextForWorkspace(previous, id, opts.source)
  )
    return previous;
  return workspace?.bindWorkspace(state, opts, id, previous) ?? previous;
}
export function qaWorkspaceEnv(dir: string, id: string, source: string): Record<string, string> {
  return workspace?.workspaceEnv(dir, id, source) ?? {};
}
export function qaProtectInput<T>(dir: string | undefined, input: T): T {
  return evidence ? evidence.protectHostInput(dir, input) : input;
}
export function qaBoundary(dir: string | undefined, id: string): { record(message: any): any } {
  return evidence ? evidence.createHostBoundary(dir, id) : { record: (message) => message };
}
export function qaProtectStream<T, R>(
  stream: AsyncGenerator<T, R>,
  dir: string,
): AsyncGenerator<T, R> {
  return evidence ? evidence.protectHostToolStream(stream, dir) : stream;
}
