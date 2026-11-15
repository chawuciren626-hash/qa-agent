import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadDshAdaptor } from "../src/index.js";

describe.skipIf(process.platform !== "win32")("Windows Node execution under DSH", () => {
  it("confines Node writes and never lets a child write outside the workspace", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "qa-dsh-node-"));
    const outside = join(tmpdir(), `qa-dsh-outside-${process.pid}.txt`);
    try {
      const provider = await loadDshAdaptor({ sessionShell: null });
      expect(provider).not.toBeNull();
      const childProgram = `try { require('node:fs').writeFileSync(${JSON.stringify(outside)},'bad') } catch(e) { console.log('child-write-denied',e.code) }`;
      const program = `const fs=require('node:fs'); const cp=require('node:child_process'); fs.writeFileSync('inside.txt','ok'); try {fs.writeFileSync(${JSON.stringify(outside)},'bad')} catch(e) {console.log('outside-denied',e.code)}; try {const child=cp.spawn(process.execPath,['-e',${JSON.stringify(childProgram)}]); child.stdout.on('data',d=>process.stdout.write(d)); child.on('error',e=>console.log('child-spawn-denied',e.code)); child.on('close',code=>console.log('child-exit',code))} catch(e) {console.log('child-spawn-denied',e.code)}`;
      const confined = provider!.confine([process.execPath, "-e", program], { mode: "workspace-write", workspaceRoot: workspace });
      const result = spawnSync(confined.argv[0]!, confined.argv.slice(1), { cwd: workspace, env: { ...process.env, ...confined.env }, encoding: "utf8", timeout: 30_000, windowsHide: true });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(existsSync(join(workspace, "inside.txt"))).toBe(true);
      expect(existsSync(outside)).toBe(false);
      expect(result.stdout).toContain("outside-denied");
      expect(result.stdout).toMatch(/child-spawn-denied EPERM|child-write-denied EPERM/);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
      rmSync(outside, { force: true });
    }
  }, 40_000);
});
