/** Project owners opt in to the bundled testing roles; members may inspect and use them. */
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import type { Hono } from "hono";
import type { AppEnv } from "../../auth/middleware.js";
import type { AgentsRouteDeps } from "./agents.js";
import { qaEnabled, qaEngineModule } from "../../services/qa-engine.js";
import { requireValidId } from "../validate.js";
import { HttpError } from "../errors.js";
import { readTaskRuns, readTaskRunDetail } from "../../services/qa-project-overview.js";
import { registerQaPersonalResources } from "./qa-personal-resources.js";

const initializing = new Set<string>();
const execFileAsync = promisify(execFile);
export function registerQaProjectRoutes(app: Hono<AppEnv>, deps: AgentsRouteDeps): void {
  if (!qaEnabled || !deps.config) return;
  registerQaPersonalResources(app, deps);
  const root = deps.config.root;
  const caseReviewContext = async (c: any, owner: boolean) => {
    const projectId = requireValidId(c,"projectId");
    if (owner) deps.access.requireProjectOwner(c.var.user.userId,projectId);
    else deps.access.requireProjectAccess(c.var.user.userId,projectId);
    const sessionId=c.req.param("sessionId"), runId=c.req.param("runId");
    if (!/^session-[A-Za-z0-9-]+$/.test(sessionId) || !/^run-[A-Za-z0-9-]+$/.test(runId)) throw new HttpError(400,"invalid_task","任务标识无效。");
    for (const agent of await deps.agentService.listAgents(projectId)) {
      const listed=await deps.sessionService.listSessions(projectId,agent.agentId,{excludeOrg:true});
      const session=listed.sessions.find(item=>item.sessionId===sessionId && item.source!=="subagent" && item.source!=="company");
      if (!session) continue;
      const detail=await readTaskRunDetail(session.workspace,sessionId,runId);
      if (!detail) break;
      const marker=JSON.parse(await fs.readFile(path.join(session.workspace,".qa-session.json"),"utf8"));
      if (marker.session_id!==sessionId || marker.session_root!==path.resolve(session.workspace) || marker.engine_root!==path.resolve(process.env.AITEST_ENGINE_ROOT ?? "")) throw new HttpError(409,"review_context_changed","任务工作区绑定不一致。");
      return {sessionId,runId,workspace:session.workspace,detail,marker};
    }
    throw new HttpError(404,"task_not_found","本项目没有这个任务运行。");
  };
  app.get("/qa/tasks/:sessionId/runs/:runId/results/:kind/export", async c => {
    const kind = c.req.param("kind");
    if (kind !== "execution" && kind !== "api_execution" && kind !== "defects") throw new HttpError(400,"invalid_export","导出类型无效。");
    const {detail,workspace}=await caseReviewContext(c,false);
    const name = kind === "defects" ? "defect-records.json" : "test_results.json";
    const artifact = detail.artifacts.find(item => item.stage === kind && item.name === name && item.verified === true && item.sha256);
    if (!artifact) throw new HttpError(409,"results_unavailable","结果尚未通过交付校验。");
    const file=path.join(workspace,artifact.path), stat=await fs.stat(file);
    if (!stat.isFile() || stat.size>2*1024*1024) throw new HttpError(413,"results_too_large","结果文件不可导出。");
    const bytes=await fs.readFile(file);
    if (createHash("sha256").update(bytes).digest("hex")!==(artifact.sha256 ?? "")) throw new HttpError(409,"results_changed","结果内容已变化，请刷新后重试。");
    const document=JSON.parse(bytes.toString("utf8"));
    const records=kind === "defects" ? (Array.isArray(document) ? document : document.records ?? document.defects) : document.cases;
    if (!Array.isArray(records)) throw new HttpError(409,"results_invalid","结果列表格式无效。");
    const columns: [string,string][]=kind === "defects" ? [["缺陷编号","defect_id"],["缺陷标题","title"],["分类","category"],["严重程度","severity"],["状态","lifecycle_status"],["关联用例","related_cases"],["复现步骤","steps_to_reproduce"],["预期结果","expected_result"],["实际结果","actual_result"],["证据","evidence_refs"]] : [["断言编号","case_id"],["名称","title"],["执行状态","status"],["关联设计用例","case_ref.case_id"],["预期结果","expected"],["实际结果","actual_result"],["错误信息","error_message"],["证据","evidence_paths"]];
    const value=(row: any,key: string) => { const raw=key.split(".").reduce((item,part)=>item?.[part],row); const text=Array.isArray(raw)?raw.join("；"):raw == null?"":typeof raw === "object"?JSON.stringify(raw):String(raw); return /^[=+\-@\t\r]/.test(text)?`'${text}`:text; };
    const xlsx=qaEngineModule("spreadsheet-runtime").default;
    const sheet=xlsx.utils.aoa_to_sheet([columns.map(([label])=>label),...records.map((row: any)=>columns.map(([,key])=>value(row,key)))]);
    const book=xlsx.utils.book_new(); xlsx.utils.book_append_sheet(book,sheet,kind === "defects"?"缺陷列表":"执行结果");
    const output=xlsx.write(book,{type:"buffer",bookType:"xlsx"});
    c.header("Content-Type","application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    c.header("Content-Disposition",`attachment; filename="${kind}-results.xlsx"`);
    c.header("Cache-Control","no-store");
    return c.body(output);
  });
  app.get("/qa/tasks/:sessionId/runs/:runId/cases",async c=>{
    const {detail,workspace}=await caseReviewContext(c,false);
    const artifact=detail.artifacts.find(item=>item.stage==="test_cases" && item.name==="test_cases.json" && item.verified===true);
    if (!artifact) throw new HttpError(409,"cases_unavailable","当前阶段尚无已校验的用例列表。");
    const file=path.join(workspace,artifact.path);
    if ((await fs.stat(file)).size>2*1024*1024) throw new HttpError(413,"cases_too_large","用例文件过大，请下载查看。");
    const bytes=await fs.readFile(file), version=createHash("sha256").update(bytes).digest("hex");
    if (version!==artifact.sha256) throw new HttpError(409,"cases_changed","用例内容已变化，请刷新后重试。");
    const engine=qaEngineModule("case-review");
    const stage=detail.stages.find(item=>item.id==="test_cases");
    const data=JSON.parse(bytes.toString("utf8"));
    c.header("Cache-Control","no-store");
    return c.json({columns:engine.caseReviewColumns(process.env.AITEST_ENGINE_ROOT),rows:engine.caseRows(data).map(engine.caseReviewRow),version,confirmationId:stage?.pendingConfirmationId ?? ""});
  });
  app.post("/qa/tasks/:sessionId/runs/:runId/cases",async c=>{
    const {sessionId,runId,marker}=await caseReviewContext(c,true);
    const raw=await c.req.text();
    if (Buffer.byteLength(raw,"utf8")>64*1024) throw new HttpError(413,"case_too_large","单条用例内容过大。");
    let body: any;
    try { body=JSON.parse(raw); } catch { throw new HttpError(400,"invalid_case","用例修改格式错误。"); }
    if (!body || typeof body!=="object" || !/^confirm-[A-Za-z0-9_-]+$/.test(body.confirmationId ?? "")) throw new HttpError(400,"invalid_case","审核记录无效。");
    try {
      const {stdout}=await execFileAsync(process.execPath,[path.join(marker.engine_root,"scripts/update-case-review.mjs")],{
        cwd:marker.engine_root,env:{...process.env,QA_DIRECTORY_CONTEXT:JSON.stringify(marker),QA_CASE_REVIEW:JSON.stringify({...body,sessionId,runId,actorId:c.var.user.userId})},windowsHide:true,timeout:150000,maxBuffer:64*1024,
      });
      c.header("Cache-Control","no-store");return c.json(JSON.parse(stdout));
    } catch (error) {
      const stderr = typeof (error as { stderr?: unknown }).stderr === "string"
        ? (error as { stderr: string }).stderr : "";
      const known = [
        ["审核版本已变化", "case_review_version_conflict", "审核版本已变化，请刷新后重试。"],
        ["用例已被修改", "case_review_source_changed", "用例内容已变化，请刷新后重试。"],
        ["用例不存在", "case_review_case_missing", "用例已不存在，请刷新后重试。"],
        ["至少保留一条用例", "case_review_last_case", "至少保留一条用例；如需重新设计，请提交阶段修改意见。"],
        ["存在不可编辑的字段", "case_review_invalid_field", "包含不可编辑的字段，请刷新后重试。"],
        ["测试数据须为 JSON 对象", "case_review_invalid_data", "测试数据须为 JSON 对象。"],
        ["步骤和前置条件须逐行填写", "case_review_invalid_steps", "步骤和前置条件须逐行填写，步骤不能为空。"],
        ["优先级必须为 P0 至 P3", "case_review_invalid_priority", "优先级必须为 P0 至 P3。"],
      ] as const;
      const match = known.find(([fragment]) => stderr.includes(fragment));
      if (match) throw new HttpError(409, match[1], match[2]);
      throw new HttpError(409,"case_review_conflict","用例保存未通过校验，原版本已保留。请刷新后重试；若问题持续，请查看服务端诊断。");
    }
  });
  app.get("/qa/overview", async (c) => {
    const id = requireValidId(c, "projectId");
    deps.access.requireProjectAccess(c.var.user.userId, id);
    const tasks = [];
    for (const agent of await deps.agentService.listAgents(id)) {
      const listed = await deps.sessionService.listSessions(id, agent.agentId, { excludeOrg: true });
      for (const session of listed.sessions) {
        if (session.source === "subagent" || session.source === "company") continue;
        tasks.push({ session, ...await readTaskRuns(session.workspace, session.sessionId) });
      }
    }
    c.header("Cache-Control", "no-store");
    return c.json({ projectId: id, tasks });
  });
  app.get("/qa/tasks/:sessionId/runs/:runId", async (c) => {
    const id = requireValidId(c, "projectId");
    deps.access.requireProjectAccess(c.var.user.userId, id);
    const sessionId = c.req.param("sessionId"), runId = c.req.param("runId");
    if (!/^[A-Za-z0-9_-]+$/.test(sessionId) || !/^run-[A-Za-z0-9-]+$/.test(runId)) throw new HttpError(400, "invalid_task", "任务或运行标识无效。");
    for (const agent of await deps.agentService.listAgents(id)) {
      const listed = await deps.sessionService.listSessions(id, agent.agentId, { excludeOrg: true });
      const session = listed.sessions.find(item => item.sessionId === sessionId && item.source !== "subagent" && item.source !== "company");
      if (!session) continue;
      const detail = await readTaskRunDetail(session.workspace, sessionId, runId);
      if (!detail) throw new HttpError(404, "run_not_found", "本任务没有这次运行记录。");
      c.header("Cache-Control", "no-store");
      return c.json({ projectId: id, session: { sessionId, title: session.title, agentId: agent.agentId }, ...detail });
    }
    throw new HttpError(404, "task_not_found", "本项目没有这个任务。");
  });
  app.post("/qa/tasks/:sessionId/runs/:runId/stages/:stageId/approve", async (c) => {
    const id = requireValidId(c, "projectId");
    deps.access.requireProjectOwner(c.var.user.userId, id);
    const sessionId = c.req.param("sessionId"), runId = c.req.param("runId"), stageId = c.req.param("stageId");
    if (!/^session-[A-Za-z0-9-]+$/.test(sessionId) || !/^run-[A-Za-z0-9-]+$/.test(runId) || !["analysis", "test_points", "test_cases", "execution", "api_execution", "defects", "report"].includes(stageId))
      throw new HttpError(400, "invalid_review", "任务、运行或审核阶段无效。");
    const body = (await c.req.json().catch(() => null)) as { confirmationId?: unknown } | null;
    const confirmationId = body?.confirmationId;
    if (typeof confirmationId !== "string" || !/^confirm-[A-Za-z0-9_-]+$/.test(confirmationId))
      throw new HttpError(400, "invalid_review", "审核记录无效，请刷新后重试。");
    let workspace: string | undefined;
    for (const agent of await deps.agentService.listAgents(id)) {
      const listed = await deps.sessionService.listSessions(id, agent.agentId, { excludeOrg: true });
      const session = listed.sessions.find(item => item.sessionId === sessionId && item.source !== "subagent" && item.source !== "company");
      if (session) { workspace = session.workspace; break; }
    }
    if (!workspace || !await readTaskRunDetail(workspace, sessionId, runId))
      throw new HttpError(404, "run_not_found", "本项目任务没有这次运行记录。");
    const marker = JSON.parse(await fs.readFile(path.join(workspace, ".qa-session.json"), "utf8"));
    if (marker.session_id !== sessionId || marker.session_root !== path.resolve(workspace) || marker.engine_root !== path.resolve(process.env.AITEST_ENGINE_ROOT ?? ""))
      throw new HttpError(409, "review_context_changed", "任务工作区绑定不一致，未执行审核。");
    try {
      const { stdout } = await execFileAsync(process.execPath, [path.join(marker.engine_root, "scripts", "approve-design-stage.mjs"), runId, sessionId, stageId, confirmationId, c.var.user.userId], {
        cwd: marker.engine_root, env: { ...process.env, QA_DIRECTORY_CONTEXT: JSON.stringify(marker) }, windowsHide: true, timeout: 15_000, maxBuffer: 64 * 1024,
      });
      c.header("Cache-Control", "no-store");
      return c.json(JSON.parse(stdout));
    } catch {
      throw new HttpError(409, "review_conflict", "审核条件已变化或产物校验未通过，请刷新任务详情后重试。");
    }
  });
  app.post("/qa/tasks/:sessionId/runs/:runId/stages/:stageId/revise", async (c) => {
    const id = requireValidId(c, "projectId");
    deps.access.requireProjectOwner(c.var.user.userId, id);
    const sessionId = c.req.param("sessionId"), runId = c.req.param("runId"), stageId = c.req.param("stageId");
    if (!/^session-[A-Za-z0-9-]+$/.test(sessionId) || !/^run-[A-Za-z0-9-]+$/.test(runId) ||
        !["analysis","test_points","test_cases","defects","report"].includes(stageId))
      throw new HttpError(400,"invalid_review","任务、运行或审核阶段无效。");
    const body = await c.req.json().catch(() => null) as { confirmationId?: unknown; feedback?: unknown } | null;
    const confirmationId=body?.confirmationId, feedback=body?.feedback;
    if (typeof confirmationId !== "string" || !/^confirm-[A-Za-z0-9_-]+$/.test(confirmationId) ||
        typeof feedback !== "string" || !feedback.trim() || Buffer.byteLength(feedback,"utf8") > 8000)
      throw new HttpError(400,"invalid_review","请填写阶段疑问或修改意见（不超过 8000 字节）。");
    let workspace: string | undefined;
    for (const agent of await deps.agentService.listAgents(id)) {
      const listed = await deps.sessionService.listSessions(id, agent.agentId, { excludeOrg: true });
      const session = listed.sessions.find(item => item.sessionId === sessionId && item.source !== "subagent" && item.source !== "company");
      if (session) { workspace = session.workspace; break; }
    }
    if (!workspace || !await readTaskRunDetail(workspace,sessionId,runId)) throw new HttpError(404,"run_not_found","本项目任务没有这次运行记录。");
    const marker = JSON.parse(await fs.readFile(path.join(workspace,".qa-session.json"),"utf8"));
    if (marker.session_id !== sessionId || marker.session_root !== path.resolve(workspace) || marker.engine_root !== path.resolve(process.env.AITEST_ENGINE_ROOT ?? ""))
      throw new HttpError(409,"review_context_changed","任务工作区绑定不一致，未提交修改。");
    try {
      const {stdout} = await execFileAsync(process.execPath,[path.join(marker.engine_root,"scripts","request-stage-revision.mjs"),runId,sessionId,stageId,confirmationId,c.var.user.userId],{
        cwd:marker.engine_root,env:{...process.env,QA_DIRECTORY_CONTEXT:JSON.stringify(marker),QA_STAGE_FEEDBACK:feedback},windowsHide:true,timeout:15_000,maxBuffer:64*1024,
      });
      c.header("Cache-Control","no-store"); return c.json(JSON.parse(stdout));
    } catch { throw new HttpError(409,"review_conflict","阶段状态或产物已变化，请刷新任务详情后重试。"); }
  });
  const engine = qaEngineModule("qa-project-bootstrap");
  const roles: { id: string; skills: string[] }[] = engine.qaRoles();
  const markerPath = (id: string) => path.join(root, id, "qa-project.json");
  const readMarker = async (id: string) => {
    try {
      return JSON.parse(await fs.readFile(markerPath(id), "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  };
  app.get("/qa", async (c) => {
    const id = requireValidId(c, "projectId");
    const access = deps.access.requireProjectAccess(c.var.user.userId, id);
    const marker = await readMarker(id);
    return c.json({
      enabled: marker?.status === "ready",
      status: marker?.status ?? "not_initialized",
      canInitialize: access.role === "owner",
      roles,
    });
  });
  app.post("/qa/initialize", async (c) => {
    const id = requireValidId(c, "projectId");
    deps.access.requireProjectOwner(c.var.user.userId, id);
    const key = markerPath(id);
    if (initializing.has(key))
      throw new HttpError(409, "qa_initializing", "项目测试能力正在初始化，请稍后刷新。");
    initializing.add(key);
    try {
      const marker = await readMarker(id);
      if (marker?.status === "ready") return c.json({ enabled: true, changed: false });
      const existing = new Set(
        (await deps.agentService.listAgents(id)).map((role) => role.agentId),
      );
      if (!marker && roles.some((role) => existing.has(role.id)))
        throw new HttpError(
          409,
          "qa_role_conflict",
          "项目已存在同名角色，需检查迁移后再启用；未覆盖现有配置。",
        );
      if (roles.some((role) => deps.manager.activeCountForAgent(id, role.id) > 0))
        throw new HttpError(409, "qa_project_busy", "测试角色有活动会话，暂不能初始化。");
      const writeMarker = async (status: string) => {
        const temp = key + ".tmp";
        await fs.writeFile(temp, JSON.stringify({ version: 1, status, projectId: id }, null, 2));
        await fs.rename(temp, key);
      };
      if (!marker) await writeMarker("initializing");
      for (const role of roles)
        if (!existing.has(role.id)) await deps.agentService.createAgent(id, role.id);
      engine.initializeQaRoles(path.join(root, id, "agents"));
      for (const role of roles) {
        const before = await deps.agentConfigService.getConfig(id, role.id);
        if (deps.manager.activeCountForAgent(id, role.id) > 0)
          throw new HttpError(409, "qa_project_busy", "测试角色有活动会话，暂不能修改工具接口。");
        await deps.agentConfigService.updateConfig(id, role.id, {
          config: { toolsBuiltin: await engine.qaRoleTools(role.id, before.config.toolsBuiltin) },
        });
      }
      await writeMarker("ready");
      return c.json({ enabled: true, changed: true });
    } finally {
      initializing.delete(key);
    }
  });
}
