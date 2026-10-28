import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { qaWorkdir } from "../src/integrations/qa-request.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function workspace() {
  const root = mkdtempSync(path.join(tmpdir(), "qa-request-"));
  roots.push(root);
  mkdirSync(path.join(root, "output/action-requests"), { recursive: true });
  writeFileSync(path.join(root, ".qa-session.json"), "{}");
  return root;
}
describe("QA command request boundary", () => {
  it("accepts only the hook-prepared JSON matching the structured request", () => {
    const root = workspace();
    const request = { action: "create", title: "测试模块" };
    writeFileSync(path.join(root, "output/action-requests/request.json"), JSON.stringify(request));
    const cmd =
      "node scripts/project-action.mjs execute --request=output/action-requests/request.json";
    expect(qaWorkdir({ qa_request: request }, root, cmd)).toBe(root);
    expect(() => qaWorkdir({ qa_request: { ...request, title: "changed" } }, root, cmd)).toThrow();
    expect(() =>
      qaWorkdir(
        { qa_request: request },
        root,
        "node other.mjs --request=output/action-requests/request.json",
      ),
    ).toThrow();
    expect(() =>
      qaWorkdir(
        { qa_request: request },
        root,
        "node scripts/project-action.mjs execute --request=../request.json",
      ),
    ).toThrow();
  });
  it("normalizes literal CWD only for QA commands in a marked workspace", () => {
    const root = workspace();
    expect(qaWorkdir({ workdir: "CWD" }, root, "node scripts/project-action.mjs catalog")).toBe(
      root,
    );
    expect(qaWorkdir({ workdir: "CWD" }, root, "node other.mjs")).toBe(path.join(root, "CWD"));
    mkdirSync(path.join(root, "CWD"));
    expect(qaWorkdir({ workdir: "CWD" }, root, "node scripts/project-action.mjs catalog")).toBe(
      path.join(root, "CWD"),
    );
  });
});
