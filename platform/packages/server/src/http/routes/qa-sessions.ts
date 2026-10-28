/** AITestHarness session extensions. Every route resolves project access before engine IO. */
import path from "node:path";
import type { Hono, Context } from "hono";
import { userText } from "@prismshadow/penguin-core";
import type { AppEnv } from "../../auth/middleware.js";
import type { SessionRow } from "../../db/repos/sessions.js";
import type { SessionsRouteDeps } from "./sessions.js";
import { qaEnabled, qaEngineModule } from "../../services/qa-engine.js";
import { HttpError } from "../errors.js";
import { readJson } from "../validate.js";

export function registerQaSessionRoutes(
  app: Hono<AppEnv>,
  deps: SessionsRouteDeps,
  resolveSession: (c: Context<AppEnv>) => SessionRow,
): void {
  if (!qaEnabled) return;
  const delivery = qaEngineModule("open-deliverable");
  const human = qaEngineModule("browser-human-action");
  const agentRoot = (row: SessionRow) => path.resolve(deps.config.root, row.projectId, "agents");

  app.get("/:sessionId/files/evidence", async (c) => {
    const row = resolveSession(c);
    const rel = c.req.query("path") ?? "";
    let evidence;
    try {
      evidence = delivery.readDeliveryEvidence(row.workspace, rel);
    } catch {
      throw new HttpError(
        400,
        "evidence_unavailable",
        "Evidence is missing, restricted, invalid or too large.",
      );
    }
    c.header("Cache-Control", "no-store");
    c.header("X-Content-Type-Options", "nosniff");
    if (c.req.query("download") === "1" && evidence.kind === "json") {
      c.header("Content-Type", "application/json; charset=utf-8");
      c.header(
        "Content-Disposition",
        "attachment; filename*=UTF-8''" + encodeURIComponent(path.basename(rel)),
      );
      c.header("Content-Security-Policy", "sandbox");
      return c.body(evidence.text);
    }
    return c.json(evidence);
  });

  app.post("/:sessionId/files/open-deliverable", async (c) => {
    const row = resolveSession(c);
    if (!deps.desktopMode || c.var.sessionVia !== "desktop")
      throw new HttpError(
        403,
        "desktop_shell_only",
        "Open documents from the desktop application.",
      );
    const rel = c.req.query("path") ?? "";
    if (!/^output\/runs\/run-[a-zA-Z0-9-]+\/(?:design|report)\/[^/\\]+\.(?:xlsx|xmind)$/i.test(rel))
      throw new HttpError(400, "unsupported_document", "Not a supported delivery document.");
    const file = await deps.workspaceFiles.resolvePath(row.workspace, rel);
    try {
      await delivery.openDeliverable(file);
    } catch (error) {
      if ((error as { code?: string }).code === "QA_DOCUMENT_OPEN_TIMEOUT")
        throw new HttpError(
          504,
          "document_open_timeout",
          "Opening timed out; check the desktop before trying again.",
        );
      throw new HttpError(
        502,
        "document_open_failed",
        "The document application could not be opened.",
      );
    }
    return c.body(null, 204);
  });

  app.get("/:sessionId/human-actions", (c) => {
    const row = resolveSession(c);
    c.header("Cache-Control", "no-store");
    return c.json({
      actions: human.listHumanActions(row.workspace, row.sessionId, agentRoot(row)),
    });
  });
  app.post("/:sessionId/human-actions", async (c) => {
    const row = resolveSession(c);
    const body = await readJson(c);
    if (body.decision !== "continue" && body.decision !== "cancel")
      throw new HttpError(400, "invalid_decision", "Choose continue or cancel.");
    try {
      return c.json(await answer(deps, row, body));
    } catch {
      throw new HttpError(
        409,
        "human_action_unavailable",
        "原任务暂不能续接，请刷新查看；未新建任务或重放操作。",
      );
    }
  });
}

async function answer(deps: SessionsRouteDeps, row: SessionRow, body: Record<string, unknown>) {
  return qaEngineModule("browser-human-action").answerHumanAction({
    workspace: row.workspace,
    parent: row.sessionId,
    agentRoot: path.resolve(deps.config.root, row.projectId, "agents"),
    runId: body.run_id,
    actionId: body.action_id,
    decision: body.decision,
    send: (child: string, text: string, decision: string, channel: string) =>
      deps.manager.sendToSubagent(
        row.sessionId,
        child,
        [userText(text), userText(continuationInstruction(decision, channel), "harness")],
        { qaHumanContinuation: true },
      ),
  });
}

export async function qaLoginConfirmation(
  deps: SessionsRouteDeps,
  row: SessionRow,
  text: string,
): Promise<unknown | null> {
  if (!qaEnabled) return null;
  const human = qaEngineModule("browser-human-action");
  if (!human.isLoginConfirmation(text)) return null;
  const actions = human
    .listHumanActions(
      row.workspace,
      row.sessionId,
      path.resolve(deps.config.root, row.projectId, "agents"),
    )
    .filter((a: { kind: string }) => ["access", "captcha", "mfa"].includes(a.kind));
  if (actions.length !== 1) return null;
  try {
    return await answer(deps, row, {
      run_id: actions[0].run_id,
      action_id: actions[0].action_id,
      decision: "continue",
    });
  } catch {
    throw new HttpError(
      409,
      "human_action_unavailable",
      "原登录任务暂不能续接；未重新派发，请查看人工操作卡片。",
    );
  }
}

function continuationInstruction(decision: string, channel: string): string {
  if (channel === "api")
    return decision === "cancel"
      ? "用户取消接口认证等待。调用api_task cancel并收集部分结果，不再发业务请求。"
      : "用户确认接口认证已准备。继续原子会话和派发，使用本任务新提供的qa-secret引用调用api_task resume，credentials以status返回的credential_key为键。没有凭据引用时只询问真正缺少的认证信息，不猜测登录成功。不启动浏览器、不重复start、不重放已执行请求。";
  return decision === "cancel"
    ? "用户取消人工等待。保留证据，调用finish结束原浏览器并如实交付partial；不再执行产品操作。"
    : "用户确认已完成当前人工操作。继续原任务、原派发和原浏览器。第一步使用新的request_id调用snapshot检查当前页面；确认登录确已生效后才继续未执行步骤。若仍需人工操作，重新pause。禁止start、重复登录/提交或重跑已完成断言。";
}
