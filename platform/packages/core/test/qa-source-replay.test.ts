/** Real core sessions, subagent dispatch and native traces; model prose/artifacts are fixtures.
 * Execution deliberately blocks (no product target). This is NOT business acceptance. */
import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { createAgent, saveProjectConfig, userText } from "../src/index.js";
import { assistantText, toolCall } from "@prismshadow/amsp/records";
import { seededProjectConfig } from "./seeded-project.js";
import { stubProviderKeys } from "./provider-keys.js";

const script = vi.hoisted(() => ({ run: null as any }));
vi.mock("../src/llm/generative-model.js", async (original) => {
  const actual = await original<typeof import("../src/llm/generative-model.js")>();
  return {
    ...actual,
    GenerativeModel: class extends actual.GenerativeModel {
      private fixtureConfig: any;
      constructor(config: any) {
        super(config);
        this.fixtureConfig = config;
      }
      async *streamGenerate(params: any): AsyncGenerator<any, any> {
        if (!script.run) throw new Error("No synthetic model script installed; network forbidden");
        return yield* script.run(this.fixtureConfig, params);
      }
    },
  };
});

const engine = process.env.AITEST_ENGINE_ROOT;
let temp: string;
let restoreKeys: (() => void) | undefined;
let oldEnv: Record<string, string | undefined> = {};
afterEach(async () => {
  script.run = null;
  restoreKeys?.();
  restoreKeys = undefined;
  for (const [key, value] of Object.entries(oldEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  oldEnv = {};
  if (temp) await fs.rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
describe.skipIf(!engine)("source workflow replay with synthetic model", () => {
  for (const types of [["functional"], ["api"], ["functional", "api"]])
    it(
      types.join(" + "),
      async () => {
        temp = await fs.mkdtemp(path.join(os.tmpdir(), "qa-source-replay-"));
        restoreKeys = stubProviderKeys();
        const host = path.join(temp, "host"),
          projectId = "replay_project",
          agentRoot = path.join(host, projectId, "agents");
        const setEnv = (key: string, value: string) => {
          if (!(key in oldEnv)) oldEnv[key] = process.env[key];
          process.env[key] = value;
        };
        setEnv("PENGUIN_HOME", host);
        setEnv("PENGUIN_AGENT_ROOT", agentRoot);
        setEnv("QA_APP_DATA_ROOT", path.join(temp, "qa"));
        setEnv("QA_WORKSPACE_ROOT", path.join(temp, "workspaces"));
        const bridge = (name: string) =>
          import(pathToFileURL(path.join(engine!, "scripts", name + ".mjs")).href);
        const { initializeQaRoles, qaRoles } = await bridge("qa-project-bootstrap");
        const { executeAction } = await bridge("structured-actions");
        const { taskResultPath } = await bridge("independent-task");
        await saveProjectConfig(host, projectId, seededProjectConfig());
        for (const role of qaRoles())
          await createAgent({ root: host, projectId, agentId: role.id });
        initializeQaRoles(agentRoot);
        await fs.writeFile(
          path.join(host, projectId, "qa-project.json"),
          JSON.stringify({ status: "ready" }),
        );
        const agent = await createAgent({ root: host, projectId, agentId: "test_agent" });
        const session = await agent.createSession({});
        const workspace = session.workspaceDir;
        setEnv(
          "QA_DIRECTORY_CONTEXT",
          await fs.readFile(path.join(workspace, ".qa-session.json"), "utf8"),
        );
        const call = async (request: any) => {
          const result = await executeAction(
            engine,
            session.sessionId,
            () => JSON.stringify(request),
            { agentRoot },
          );
          expect(result.status, JSON.stringify(result)).toBe("completed");
          return result;
        };
        let tracks: any[] = [],
          queue: any[] = [],
          current: any = null,
          initialized = false;
        const deliveries: string[] = [],
          roles: string[] = [];
        const stages = ["analysis", "test_points", "test_cases", "execution", "defects", "report"];
        const put = async (run: string, name: string, value: any) => {
          const file = path.join(workspace, "output/runs", run, name);
          await fs.mkdir(path.dirname(file), { recursive: true });
          await fs.writeFile(file, typeof value === "string" ? value : JSON.stringify(value));
        };
        script.run = async function* (config: any, params: any) {
          if (config.sessionId !== session.sessionId) {
            expect(current).not.toBeNull();
            const { track, stage } = current;
            roles.push(current.delegation.agent_id);
            const run = track.run_id,
              source = `inputs/${track.type}.txt`,
              label = track.type === "api" ? "接口" : "功能";
            const expected =
              track.type === "api" ? "接口查询返回业务码0。" : "功能页面空手机号应提示必填。";
            if (!["execution", "api_execution"].includes(stage)) {
              await put(run, taskResultPath(stage), {
                run_id: run,
                stage,
                outcome: ["defects", "report"].includes(stage) ? "partial" : "completed",
                summary: `合成${label}${stage}`,
                source_paths: [source],
                questions: [],
                limitations: ["工程回放；未执行产品测试"],
              });
              if (stage === "analysis")
                await put(
                  run,
                  "analysis/requirement_analysis.md",
                  `# 登录模块需求分析\n${expected}\n工程合成验证。`,
                );
              if (stage === "test_points") {
                await put(run, "design/test_points.json", {
                  points: [
                    {
                      id: "TP-1",
                      module: label,
                      feature: "登录",
                      description: expected,
                      execution_layer: track.type === "api" ? "api" : "ui",
                    },
                  ],
                });
                await call({ action: "export_test_points", run_id: run });
              }
              if (stage === "test_cases") {
                await put(run, "design/test_cases.json", {
                  cases: [
                    {
                      case_id: "CASE-1",
                      title: "登录检查",
                      priority: "P1",
                      module: label,
                      preconditions: [],
                      steps: [track.type === "api" ? "查询接口" : "清空手机号后提交"],
                      expected,
                      expected_basis: [
                        { expected, kind: "requirement", source_path: source, quote: expected },
                      ],
                      execution_layer: track.type === "api" ? "api" : "ui",
                    },
                  ],
                });
                await call({ action: "export_test_cases", run_id: run });
              }
              if (stage === "defects") {
                await put(run, "defects/defect-records.json", { records: [] });
                await put(run, "defects/bugs.md", "# 缺陷分析\n未执行，不能断言无缺陷。");
              }
              if (stage === "report") {
                await put(run, "report/reportable-results.json", {
                  run_id: run,
                  cases: [],
                  summary: { total: 0, passed: 0, failed: 0, blocked: 0, skipped: 0 },
                });
                await put(run, "report/issues.json", []);
                await put(
                  run,
                  "report/test_report.md",
                  `# ${label}测试报告\n工程合成回放。执行受阻，没有通过结论。`,
                );
                await call({ action: "export_report", run_id: run });
              }
            }
            yield assistantText("工程合成子任务返回；执行节点没有目标，不执行产品操作。");
            return { status: "completed" };
          }
          if (!initialized) {
            initialized = true;
            const created = await call({ action: "create_run" });
            for (const type of types)
              await call({
                action: "archive_input",
                run_id: created.run_id,
                name: type + ".txt",
                text: type === "api" ? "接口查询返回业务码0。" : "功能页面空手机号应提示必填。",
              });
            const planned = await call({
              action: "plan_test_tracks",
              run_id: created.run_id,
              scope_name: "登录模块",
              tracks: types.map((type) => ({
                type,
                source_paths: [`inputs/${type}.txt`],
                reason: "工程合成材料",
              })),
              stages,
              workflow_mode: "task",
            });
            tracks = planned.data.tracks;
            queue = tracks.flatMap((track) =>
              track.dispatch_templates.map((request: any) => ({ track, request })),
            );
          }
          if (current) {
            for (const row of params.newMessages)
              if (row.payload?.type === "tool_call_output")
                expect(row.payload.status, row.payload.output).toBe("completed");
            const run = current.track.run_id;
            if (["execution", "api_execution"].includes(current.stage)) {
              await call({
                action: "block",
                run_id: run,
                stage: current.stage,
                dispatch_id: current.failure_template.dispatch_id,
                reason: "合成环境未提供产品目标，不执行产品操作",
              });
            } else {
              const result = await call(current.handoff_template);
              deliveries.push(
                ...(result.typed_delivery?.files ?? []).map((file: any) => file.label),
              );
            }
            current = null;
          }
          const next = queue.shift();
          if (next) {
            const dispatched = await call(next.request);
            current = { ...dispatched, track: next.track, stage: next.request.stage };
            yield toolCall({
              name: "run_subagent",
              arguments: JSON.stringify({ ...dispatched.delegation, yield_time_ms: 600000 }),
              toolCallId: "replay_" + randomUUID().replaceAll("-", ""),
            });
          } else yield assistantText("受控回放完成。执行受阻，报告保留限制；不是业务验收通过。");
          return { status: "completed" };
        };
        try {
          const records = [];
          for await (const record of session.run(
            [
              userText(
                "工程合成回放。功能页面空手机号应提示必填。接口查询返回业务码0。没有产品目标，不进行真实产品测试。",
              ),
            ],
            { approve: async () => "allow" },
          ))
            records.push(record);
          expect(queue).toHaveLength(0);
          expect(current).toBeNull();
          expect(roles).toHaveLength(types.length * 6);
          expect(roles.includes("api_automation_agent")).toBe(types.includes("api"));
          expect(roles.includes("automation_execution_agent")).toBe(types.includes("functional"));
          for (const track of tracks) {
            const manifest = JSON.parse(
              await fs.readFile(
                path.join(workspace, "output/runs", track.run_id, "manifest.json"),
                "utf8",
              ),
            );
            expect(
              manifest.stages[track.type === "api" ? "api_execution" : "execution"].status,
            ).toBe("blocked");
            expect(manifest.stages.report.status).toBe("completed");
            expect(deliveries).toContain(
              `登录模块${track.type === "api" ? "接口" : "功能"}测试报告.html`,
            );
          }
          expect(deliveries.some((name) => /\.(pdf|docx)$/.test(name))).toBe(false);
        } finally {
          session.dispose();
        }
      },
      120000,
    );
});
