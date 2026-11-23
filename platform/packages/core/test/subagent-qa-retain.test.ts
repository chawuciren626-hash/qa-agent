/**
 * QA workspaces keep a normally-finished delegation child so the controller can continue the
 * SAME stage on a revision / user supplement via input_subagent, instead of re-dispatching a
 * fresh child from zero. Non-QA sessions keep the upstream "kill when finished" behaviour
 * (covered by subagent.test.ts). The QA gate is module-level, so this file mocks qa-runtime.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/integrations/qa-runtime.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, qaIsWorkspace: () => true };
});

import { createSubagentTool } from "../src/environment/tools/run-subagent.js";
import { createInputSubagentTool } from "../src/environment/tools/input-subagent.js";
import { SubagentSessionManager } from "../src/environment/tools/subagent/index.js";
import { assistantText, partialText, toolCall, userText, withOrigin } from "@prismshadow/amsp/records";
import type { MessageOrigin, AmspRecord } from "@prismshadow/amsp/records";
import type { EnvironmentServices, SubagentHandle, SubagentRunner, ToolDefinitionConfig } from "../src/interfaces/index.js";
import type { ToolResult } from "../src/environment/tools/types.js";

const DEF: ToolDefinitionConfig = { name: "run_subagent", description: "delegate", permission: "rw" };
const INPUT_DEF: ToolDefinitionConfig = { name: "input_subagent", description: "continue", permission: "rw" };
const CTX = { workspaceDir: "/tmp/ws-qa", toolCallId: "call_1" };
const HOP: MessageOrigin = "session-child-12ab34cd";

const promptOf = (messages: AmspRecord[]): string =>
  messages.map((m) => (m.payload as { text?: string }).text ?? "").join("");

const managers: SubagentSessionManager[] = [];
afterEach(() => { for (const m of managers.splice(0)) m.dispose(); });

function makeServices(runner: SubagentRunner): { services: EnvironmentServices; manager: SubagentSessionManager } {
  const manager = new SubagentSessionManager();
  managers.push(manager);
  return { services: { subagentRunner: runner, subagentSessions: manager }, manager };
}

async function collect(gen: AsyncGenerator<AmspRecord, ToolResult | void>) {
  for (;;) { const r = await gen.next(); if (r.done) return r.value; }
}

describe("QA delegation retention (continue same child on revision)", () => {
  it("retains a normally-finished child with a handle and continues it via input_subagent", async () => {
    const prompts: string[] = [];
    const run = async function* (input: { prompt: string }): AsyncGenerator<AmspRecord> {
      prompts.push(input.prompt);
      yield withOrigin(assistantText(`done:${input.prompt}`), HOP);
    };
    const runner: SubagentRunner = {
      async spawn() {
        const handle: SubagentHandle = {
          sessionId: HOP,
          run: ({ messages }) => run({ prompt: promptOf(messages) }),
          dispose() {},
        };
        return handle;
      },
    };
    const { services, manager } = makeServices(runner);
    const runTool = createSubagentTool(DEF, services);

    const result = await collect(runTool.execute({ prompt: "analyze" }, CTX));
    // The child finished inside the foreground window, yet QA keeps it addressable.
    expect(result?.status).toBe("completed");
    const note = String(result?.note ?? "");
    expect(note).toContain("subagent retained with subagent_id");
    const id = note.match(/subagent_id (subagent-[0-9a-f]+)/)?.[1];
    expect(id).toBeTruthy();
    expect(manager.get(id!)).toBeDefined();

    // A revision/user supplement goes to the SAME child, not a fresh spawn.
    const inputTool = createInputSubagentTool(INPUT_DEF, services);
    const follow = await collect(inputTool.execute({ subagent_id: id, prompt: "revise per feedback" }, CTX));
    expect(follow?.status).toBe("completed");
    expect(prompts).toEqual(["analyze", "revise per feedback"]);
  });
});
