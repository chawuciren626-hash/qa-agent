import { afterEach, expect, it, vi } from "vitest";
import { CommandSessionManager } from "../src/environment/tools/command/session-manager.js";

const route = vi.hoisted(() => vi.fn());
vi.mock("../src/integrations/qa-runtime.js", () => ({ qaLocalBrowserSpawn: route }));
afterEach(() => route.mockReset());

it("keeps ordinary commands behind confinement", () => {
  route.mockReturnValue(null);
  const confine = vi.fn(() => { throw new Error("confined ordinary command"); });
  const manager = new CommandSessionManager({ confineSpawn: () => confine });
  expect(() => manager.spawn({ cmd: "echo ordinary", cwd: process.cwd() })).toThrow("confined ordinary command");
  expect(confine).toHaveBeenCalledOnce();
});

it("uses the validated browser argv without shell, vault or sandbox inheritance", async () => {
  route.mockReturnValue({
    argv: [process.execPath, "-e", "process.stdin.on('data', x => process.stdout.write(x));"],
    env: { SystemRoot: process.env.SystemRoot ?? "" }, input: "synthetic browser envelope",
  });
  const confineSpawn = vi.fn(() => { throw new Error("browser must not resolve Agent sandbox"); });
  const controlEnv = { QA_DIRECTORY_CONTEXT: "host-owned-context" };
  const manager = new CommandSessionManager({ confineSpawn, controlEnv: () => controlEnv, vault: { QA_DIRECTORY_CONTEXT: "untrusted-vault" } });
  const session = manager.spawn({ cmd: "validated browser request", cwd: process.cwd(), qaToolCallId: "call-fixture" });
  let output = "";
  for await (const chunk of session.collect(10_000)) output += chunk;
  expect(output).toBe("synthetic browser envelope");
  expect(confineSpawn).not.toHaveBeenCalled();
  expect(route.mock.calls[0]?.[0].controlEnv).toEqual(controlEnv);
});
