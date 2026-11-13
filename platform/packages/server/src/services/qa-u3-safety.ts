/** U3 execution safety ledger: checkpoints, side effects, cleanup and interface coverage. */
import { randomUUID } from "node:crypto";
import { HttpError } from "../http/errors.js";
import type { KnowledgeDb } from "./qa-project-knowledge.js";

export const CHECKPOINT_KINDS = ["start", "step", "evidence", "interruption", "recovery", "cleanup"] as const;
export const CHECKPOINT_STATUSES = ["recorded", "pending", "failed", "recovered"] as const;
export const SIDE_EFFECT_KINDS = ["business_write", "browser_session", "wsl_process", "file_write", "callback", "api_request", "tool_call"] as const;
export const SIDE_EFFECT_STATES = ["planned", "not_created", "persisted", "failed", "reverted", "unknown"] as const;
export const CLEANUP_STATES = ["not_required", "planned", "pending", "succeeded", "failed", "skipped", "unknown"] as const;
export const CLEANUP_ACTION_STATES = ["planned", "pending", "succeeded", "failed", "skipped", "unknown"] as const;
export const FAILURE_CLASSES = ["product_defect", "environment_issue", "automation_issue", "test_issue", "unknown"] as const;
export const CANCELLATION_KINDS = ["user_cancel", "model_timeout", "network_partition", "browser_crash", "hibernate", "repeat_run", "fault_injection"] as const;
export const CANCELLATION_STATUSES = ["requested", "propagating", "acknowledged", "partial", "failed"] as const;
export const PROPAGATION_ACKS = ["not_applicable", "sent", "acknowledged", "failed", "unknown"] as const;
export const RESIDUAL_STATES = ["clean", "known_residue", "cleanup_failed", "unknown"] as const;
export const PROCESS_TARGET_KINDS = ["browser", "wsl", "tool", "callback", "model"] as const;
export const PROCESS_STATES = ["terminated", "failed", "unknown"] as const;
export const FAULT_KINDS = ["network_partition", "model_timeout", "browser_crash", "hibernate", "repeat_run", "fault_injection"] as const;
export const FAULT_STATES = ["planned", "injected", "recovered", "failed", "unknown"] as const;

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const KEY = /^[A-Za-z0-9_.:-]{1,150}$/;
const key = (value: unknown, code: string, label: string): string => {
  const raw = text(value, 150, code, label);
  if (!KEY.test(raw)) throw new HttpError(400, code, `${label} 格式无效。`);
  return raw;
};
const HASH = /^(?:sha256:)?[a-f0-9]{64}$/;

const row = <T>(value: unknown): T => value as T;
const text = (value: unknown, max: number, code: string, label: string, min = 1): string => {
  if (typeof value !== "string") throw new HttpError(400, code, `${label} 必须是文本。`);
  const raw = value.trim();
  if (raw.length < min) throw new HttpError(400, code, `${label} 不能为空。`);
  if (raw.length > max) throw new HttpError(400, code, `${label} 超过长度限制。`);
  return raw;
};
const object = (value: unknown, code: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, code, "对象格式无效。");
  return value as Record<string, unknown>;
};
const oneOf = <T extends string>(value: unknown, allowed: readonly T[], code: string, label: string): T => {
  if (typeof value !== "string" || !allowed.includes(value as T)) throw new HttpError(400, code, `${label} 无效。`);
  return value as T;
};
const hash = (value: unknown, code: string, label: string): string => {
  const raw = text(value, 80, code, label);
  if (!HASH.test(raw)) throw new HttpError(400, code, `${label} 必须是 SHA-256。`);
  return raw.startsWith("sha256:") ? raw : `sha256:${raw}`;
};
const jsonValue = (value: unknown, code: string): unknown => {
  if (value === undefined || value === null || typeof value === "function") throw new HttpError(400, code, "JSON 内容无效。");
  return value;
};
const safePath = (value: unknown, code: string, label: string): string => {
  const raw = text(value, 1000, code, label);
  if (raw.includes("\\") || raw.startsWith("/") || raw.split("/").some(part => !part || part === "." || part === "..")) {
    throw new HttpError(400, code, `${label} 路径不安全。`);
  }
  return raw;
};
const evidenceList = (value: unknown, code: string): {label:string;path:string;sha256?:string}[] => {
  if (!Array.isArray(value) || value.length > 50) throw new HttpError(400, code, "证据必须是 0 至 50 条。");
  return value.map(item => {
    const raw = object(item, code);
    const out = { label: text(raw.label, 200, code, "证据标签"), path: safePath(raw.path, code, "证据路径") };
    return raw.sha256 === undefined || raw.sha256 === null ? out : { ...out, sha256: hash(raw.sha256, code, "证据哈希") };
  });
};
const defectRefList = (value: unknown, code: string): string[] => {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 50) throw new HttpError(400, code, "缺陷引用必须是 0 至 50 条。");
  return value.map(item => text(item, 100, code, "缺陷引用"));
};
const parseJson = <T>(raw: string, fallback: T): T => { try { return JSON.parse(raw) as T; } catch { return fallback; } };
const browserAckRequired = (item: Record<string, unknown>): boolean =>
  String(item.browser_ack) !== "not_applicable";
const iso = (ms: number) => new Date(ms).toISOString();

export class QaU3SafetyStore {
  private readonly now: () => number;
  private readonly id: () => string;

  constructor(private readonly db: KnowledgeDb, options: { now?: () => number; id?: () => string } = {}) {
    this.now = options.now ?? (() => Date.now());
    this.id = options.id ?? randomUUID;
  }

  private tx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = fn(); this.db.exec("COMMIT"); return result; }
    catch(error) { this.db.exec("ROLLBACK"); throw error; }
  }

  private attempt(projectId: string, attemptId: string) {
    if (!ID.test(attemptId)) throw new HttpError(404, "attempt_not_found", "执行 attempt 不存在。");
    const found = row<Record<string, unknown> | undefined>(this.db.prepare("SELECT * FROM qa_u2_execution_attempts WHERE attempt_id=? AND project_id=?").get(attemptId, projectId));
    if (!found) throw new HttpError(404, "attempt_not_found", "执行 attempt 不存在。");
    return found;
  }

  private caseAttempt(projectId: string, attemptId: string | null, caseAttemptId: string) {
    if (!ID.test(caseAttemptId)) throw new HttpError(404, "case_attempt_not_found", "用例 attempt 不存在。");
    const found = row<Record<string, unknown> | undefined>(this.db.prepare("SELECT * FROM qa_u2_case_attempts WHERE attempt_case_id=? AND project_id=?").get(caseAttemptId, projectId));
    if (!found) throw new HttpError(404, "case_attempt_not_found", "用例 attempt 不存在。");
    if (attemptId && found.attempt_id !== attemptId) throw new HttpError(409, "case_attempt_mismatch", "用例 attempt 不属于当前执行。");
    return found;
  }

  recordCheckpoint(projectId: string, attemptId: string, body: Record<string, unknown>, userId: string) {
    const caseAttemptId = String(body.caseAttemptId ?? "");
    const ordinal = Number(body.ordinal);
    const kind = oneOf(body.kind, CHECKPOINT_KINDS, "invalid_checkpoint", "检查点类型");
    const label = text(body.label, 300, "invalid_checkpoint", "检查点标签");
    const status = oneOf(body.status ?? "recorded", CHECKPOINT_STATUSES, "invalid_checkpoint", "检查点状态");
    const payload = object(body.payload ?? {}, "invalid_checkpoint");
    const evidence = evidenceList(body.evidence ?? [], "invalid_checkpoint");
    const now = iso(this.now());
    const checkpointId = `checkpoint-${this.id()}`;
    return this.tx(() => {
      this.attempt(projectId, attemptId);
      const item = this.caseAttempt(projectId, attemptId, caseAttemptId);
      if (!Number.isSafeInteger(ordinal) || ordinal < 1 || ordinal > 10000) throw new HttpError(400, "invalid_checkpoint", "检查点序号无效。");
      const duplicate = this.db.prepare("SELECT 1 FROM qa_u3_case_checkpoints WHERE case_attempt_id=? AND ordinal=?").get(caseAttemptId, ordinal);
      if (duplicate) throw new HttpError(409, "checkpoint_exists", "检查点序号已存在。");
      this.db.prepare(`INSERT INTO qa_u3_case_checkpoints
        (checkpoint_id,attempt_id,case_attempt_id,project_id,ordinal,kind,label,status,payload_json,evidence_json,created_at,created_by)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(checkpointId, attemptId, caseAttemptId, projectId, ordinal, kind, label, status, JSON.stringify(payload), JSON.stringify(evidence), now, userId);
      return this.checkpointView(row<Record<string, unknown>>(this.db.prepare("SELECT * FROM qa_u3_case_checkpoints WHERE checkpoint_id=?").get(checkpointId)));
    });
  }

  private checkpointView(item: Record<string, unknown>) {
    return {
      checkpointId: item.checkpoint_id,
      attemptId: item.attempt_id,
      caseAttemptId: item.case_attempt_id,
      ordinal: item.ordinal,
      kind: item.kind,
      label: item.label,
      status: item.status,
      payload: parseJson<unknown>(String(item.payload_json), {}),
      evidence: parseJson<unknown[]>(String(item.evidence_json), []),
      createdAt: item.created_at,
      createdBy: item.created_by
    };
  }

  recordSideEffect(projectId: string, attemptId: string, body: Record<string, unknown>, userId: string) {
    const caseAttemptId = body.caseAttemptId === undefined || body.caseAttemptId === null ? null : String(body.caseAttemptId);
    const kind = oneOf(body.kind, SIDE_EFFECT_KINDS, "invalid_side_effect", "副作用类型");
    const target = text(body.target, 1000, "invalid_side_effect", "副作用目标");
    const idempotencyKey = body.idempotencyKey === undefined || body.idempotencyKey === null ? "" : key(body.idempotencyKey, "invalid_side_effect", "幂等键");
    const state = oneOf(body.state, SIDE_EFFECT_STATES, "invalid_side_effect", "副作用状态");
    const cleanupState = oneOf(body.cleanupState ?? (state === "not_created" ? "not_required" : "pending"), CLEANUP_STATES, "invalid_side_effect", "清理状态");
    const requestDigest = body.requestDigest === undefined || body.requestDigest === null ? null : hash(body.requestDigest, "invalid_side_effect", "请求摘要");
    const resultDigest = body.resultDigest === undefined || body.resultDigest === null ? null : hash(body.resultDigest, "invalid_side_effect", "结果摘要");
    const cleanupPlan = object(body.cleanupPlan ?? {}, "invalid_side_effect");
    const evidence = evidenceList(body.evidence ?? [], "invalid_side_effect");
    const now = iso(this.now());
    const effectId = `effect-${this.id()}`;
    return this.tx(() => {
      this.attempt(projectId, attemptId);
      if (caseAttemptId) this.caseAttempt(projectId, attemptId, caseAttemptId);
      if (state === "unknown" && cleanupState === "succeeded") throw new HttpError(400, "invalid_side_effect", "未知副作用不能标记清理完成。");
      if (state === "not_created" && !["not_required", "skipped"].includes(cleanupState)) throw new HttpError(400, "invalid_side_effect", "未创建副作用不需要清理动作。");
      if (idempotencyKey) {
        const duplicate = this.db.prepare("SELECT effect_id FROM qa_u3_side_effects WHERE attempt_id=? AND idempotency_key=?").get(attemptId, idempotencyKey);
        if (duplicate) throw new HttpError(409, "idempotency_key_exists", "同一执行中的幂等键已存在。");
      }
      this.db.prepare(`INSERT INTO qa_u3_side_effects
        (effect_id,attempt_id,case_attempt_id,project_id,kind,target,idempotency_key,state,cleanup_state,request_digest,result_digest,cleanup_plan_json,evidence_json,discovered_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(effectId, attemptId, caseAttemptId, projectId, kind, target, idempotencyKey, state, cleanupState, requestDigest, resultDigest, JSON.stringify(cleanupPlan), JSON.stringify(evidence), now, now);
      return this.effectView(row<Record<string, unknown>>(this.db.prepare("SELECT * FROM qa_u3_side_effects WHERE effect_id=?").get(effectId)));
    });
  }

  private effectView(item: Record<string, unknown>) {
    return {
      effectId: item.effect_id,
      attemptId: item.attempt_id,
      caseAttemptId: item.case_attempt_id,
      kind: item.kind,
      target: item.target,
      idempotencyKey: item.idempotency_key,
      state: String(item.state),
      cleanupState: String(item.cleanup_state),
      requestDigest: item.request_digest,
      resultDigest: item.result_digest,
      cleanupPlan: parseJson<unknown>(String(item.cleanup_plan_json), {}),
      evidence: parseJson<unknown[]>(String(item.evidence_json), []),
      discoveredAt: item.discovered_at,
      updatedAt: item.updated_at
    };
  }

  updateSideEffect(projectId: string, effectId: string, body: Record<string, unknown>, userId: string) {
    const state = oneOf(body.state, SIDE_EFFECT_STATES, "invalid_side_effect", "副作用状态");
    const cleanupState = oneOf(body.cleanupState, CLEANUP_STATES, "invalid_side_effect", "清理状态");
    const resultDigest = body.resultDigest === undefined || body.resultDigest === null ? null : hash(body.resultDigest, "invalid_side_effect", "结果摘要");
    const evidence = evidenceList(body.evidence ?? [], "invalid_side_effect");
    const now = iso(this.now());
    return this.tx(() => {
      const found = row<Record<string, unknown> | undefined>(this.db.prepare(`SELECT e.* FROM qa_u3_side_effects e JOIN qa_u2_execution_attempts a ON a.attempt_id=e.attempt_id
        WHERE e.effect_id=? AND e.project_id=?`).get(effectId, projectId));
      if (!found) throw new HttpError(404, "effect_not_found", "副作用不存在。");
      const attemptId = String(found.attempt_id);
      if (state === "unknown" && cleanupState === "succeeded") throw new HttpError(409, "unknown_side_effect", "未知副作用不能标记清理成功。");
      if (state === "reverted" && cleanupState !== "succeeded") throw new HttpError(400, "invalid_side_effect", "副作用回退要求清理状态为 succeeded。");
      if (["persisted", "reverted", "unknown"].includes(state) && cleanupState === "succeeded") {
        const verified = this.db.prepare("SELECT 1 FROM qa_u3_cleanup_actions WHERE effect_id=? AND state='succeeded' LIMIT 1").get(effectId);
        if (!verified) throw new HttpError(409, "cleanup_unverified", "清理成功前必须存在已验证的清理动作。");
      }
      this.db.prepare("UPDATE qa_u3_side_effects SET state=?,cleanup_state=?,result_digest=?,evidence_json=?,updated_at=? WHERE effect_id=?")
        .run(state, cleanupState, resultDigest, JSON.stringify(evidence), now, effectId);
      this.attempt(projectId, attemptId);
      return this.effectView(row<Record<string, unknown>>(this.db.prepare("SELECT * FROM qa_u3_side_effects WHERE effect_id=?").get(effectId)));
    });
  }

  recordCleanup(projectId: string, attemptId: string, body: Record<string, unknown>, userId: string) {
    const caseAttemptId = body.caseAttemptId === undefined || body.caseAttemptId === null ? null : String(body.caseAttemptId);
    const effectId = body.effectId === undefined || body.effectId === null ? null : String(body.effectId);
    const action = text(body.action, 300, "invalid_cleanup", "清理动作");
    const state = oneOf(body.state, CLEANUP_ACTION_STATES, "invalid_cleanup", "清理动作状态");
    const verification = object(body.verification ?? {}, "invalid_cleanup");
    const failureClass = body.failureClass === undefined || body.failureClass === null ? null : oneOf(body.failureClass, FAILURE_CLASSES, "invalid_cleanup", "失败分类");
    const defectRefs = defectRefList(body.defectRefs ?? [], "invalid_cleanup");
    const evidence = evidenceList(body.evidence ?? [], "invalid_cleanup");
    const startedAt = body.startedAt === undefined || body.startedAt === null ? null : text(String(body.startedAt), 40, "invalid_cleanup", "开始时间");
    const finishedAt = body.finishedAt === undefined || body.finishedAt === null ? null : text(String(body.finishedAt), 40, "invalid_cleanup", "结束时间");
    const now = iso(this.now());
    const actionId = `cleanup-${this.id()}`;
    return this.tx(() => {
      const attempt = this.attempt(projectId, attemptId);
      if (effectId) {
        const effect = row<Record<string, unknown> | undefined>(this.db.prepare("SELECT * FROM qa_u3_side_effects WHERE effect_id=? AND attempt_id=? AND project_id=?").get(effectId, attemptId, projectId));
        if (!effect) throw new HttpError(404, "effect_not_found", "副作用不存在。");
      }
      if (caseAttemptId) this.caseAttempt(projectId, attemptId, caseAttemptId);
      if (state === "succeeded") {
        if (!effectId) throw new HttpError(400, "invalid_cleanup", "清理成功必须绑定副作用。");
        if (!verification.method || !evidence.length) throw new HttpError(400, "invalid_cleanup", "清理成功必须包含验证方法和证据。");
      }
      if (state === "failed" && !failureClass) throw new HttpError(400, "invalid_cleanup", "清理失败必须提供失败分类。");
      if (failureClass === "product_defect" && !defectRefs.length) throw new HttpError(400, "invalid_cleanup", "清理产品缺陷必须提供缺陷引用。");
      this.db.prepare(`INSERT INTO qa_u3_cleanup_actions
        (action_id,attempt_id,effect_id,case_attempt_id,project_id,action,state,verification_json,failure_class,defect_refs_json,evidence_json,started_at,finished_at,created_at,created_by,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(actionId, attemptId, effectId, caseAttemptId, projectId, action, state, JSON.stringify(verification), failureClass, JSON.stringify(defectRefs), JSON.stringify(evidence), startedAt, finishedAt, now, userId, now);
      if (state === "succeeded" && effectId) {
        this.db.prepare("UPDATE qa_u3_side_effects SET cleanup_state='succeeded',updated_at=? WHERE effect_id=?").run(now, effectId);
      }
      return this.cleanupView(row<Record<string, unknown>>(this.db.prepare("SELECT * FROM qa_u3_cleanup_actions WHERE action_id=?").get(actionId)));
    });
  }

  recordInterfaceCoverage(projectId: string, attemptId: string, body: Record<string, unknown>, userId: string) {
    const caseAttemptId = body.caseAttemptId === undefined || body.caseAttemptId === null ? null : String(body.caseAttemptId);
    const routeKey = key(body.routeKey, "invalid_coverage", "接口 route key");
    const method = oneOf(body.method, ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"], "invalid_coverage", "HTTP 方法");
    const path = text(body.path, 1000, "invalid_coverage", "接口路径");
    const contractVersion = body.contractVersion === undefined || body.contractVersion === null ? null : text(body.contractVersion, 100, "invalid_coverage", "契约版本");
    const sourceRef = body.sourceRef === undefined || body.sourceRef === null ? null : text(body.sourceRef, 1000, "invalid_coverage", "契约来源");
    const flags = {
      routeDocumented: body.routeDocumented === true,
      executed: body.executed === true,
      requestValid: body.requestValid === true,
      structureAsserted: body.structureAsserted === true,
      businessAsserted: body.businessAsserted === true,
      riskBranch: body.riskBranch === true,
      cleanupVerified: body.cleanupVerified === true
    };
    if (flags.businessAsserted && (!flags.executed || !flags.structureAsserted)) throw new HttpError(400, "invalid_coverage", "业务断言前必须执行并完成结构断言。");
    if (flags.cleanupVerified && !flags.executed) throw new HttpError(400, "invalid_coverage", "清理验证前必须实际执行接口。");
    const result = oneOf(body.result ?? (flags.executed ? "needs_review" : "not_run"), ["passed", "failed", "not_run", "needs_review"], "invalid_coverage", "接口结果");
    if (result === "passed") {
      const allCovered = flags.routeDocumented && !!contractVersion && !!sourceRef && flags.executed && flags.requestValid && flags.structureAsserted && flags.businessAsserted && flags.riskBranch && flags.cleanupVerified;
      if (!allCovered) throw new HttpError(409, "coverage_gate_failed", "接口通过要求九层覆盖全部满足。");
    }
    const evidence = evidenceList(body.evidence ?? [], "invalid_coverage");
    if (result === "passed" && !evidence.length) throw new HttpError(400, "invalid_coverage", "接口通过必须提供证据。");
    const notes = text(body.notes ?? "", 4000, "invalid_coverage", "接口备注", 0);
    const now = iso(this.now());
    const coverageId = `coverage-${this.id()}`;
    return this.tx(() => {
      this.attempt(projectId, attemptId);
      if (caseAttemptId) this.caseAttempt(projectId, attemptId, caseAttemptId);
      const duplicate = this.db.prepare("SELECT coverage_id FROM qa_u3_interface_coverage WHERE attempt_id=? AND route_key=?").get(attemptId, routeKey);
      if (duplicate) throw new HttpError(409, "coverage_route_exists", "同一执行中接口 route key 已存在。");
      const coverageLevel = Object.values(flags).filter(Boolean).length + (contractVersion ? 1 : 0) + (sourceRef ? 1 : 0);
      this.db.prepare(`INSERT INTO qa_u3_interface_coverage
        (coverage_id,attempt_id,case_attempt_id,project_id,route_key,method,path,route_documented,contract_version,source_ref,executed,request_valid,structure_asserted,business_asserted,risk_branch,cleanup_verified,result,evidence_json,notes,created_at,created_by,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(coverageId, attemptId, caseAttemptId, projectId, routeKey, method, path, flags.routeDocumented ? 1 : 0, contractVersion, sourceRef, flags.executed ? 1 : 0, flags.requestValid ? 1 : 0, flags.structureAsserted ? 1 : 0, flags.businessAsserted ? 1 : 0, flags.riskBranch ? 1 : 0, flags.cleanupVerified ? 1 : 0, result, JSON.stringify(evidence), notes, now, userId, now);
      return this.coverageView(row<Record<string, unknown>>(this.db.prepare("SELECT * FROM qa_u3_interface_coverage WHERE coverage_id=?").get(coverageId)), coverageLevel);
    });
  }

  private coverageView(item: Record<string, unknown>, coverageLevel?: number) {
    const flags = {
      routeDocumented: item.route_documented === 1,
      executed: item.executed === 1,
      requestValid: item.request_valid === 1,
      structureAsserted: item.structure_asserted === 1,
      businessAsserted: item.business_asserted === 1,
      riskBranch: item.risk_branch === 1,
      cleanupVerified: item.cleanup_verified === 1
    };
    const level = coverageLevel ?? Object.values(flags).filter(Boolean).length + (item.contract_version ? 1 : 0) + (item.source_ref ? 1 : 0);
    return {
      coverageId: item.coverage_id,
      attemptId: item.attempt_id,
      caseAttemptId: item.case_attempt_id,
      routeKey: item.route_key,
      method: item.method,
      path: item.path,
      ...flags,
      contractVersion: item.contract_version,
      sourceRef: item.source_ref,
      coverageLevel: Math.min(9, level),
      result: item.result,
      evidence: parseJson<unknown[]>(String(item.evidence_json), []),
      notes: item.notes,
      createdAt: item.created_at,
      createdBy: item.created_by,
      updatedAt: item.updated_at
    };
  }

  requestCancellation(projectId: string, attemptId: string, body: Record<string, unknown>, userId: string) {
    const kind = oneOf(body.kind, CANCELLATION_KINDS, "invalid_cancellation", "取消类型");
    const sessionId = body.sessionId === undefined || body.sessionId === null ? null : String(body.sessionId);
    const propagation = object(body.propagation ?? {}, "invalid_cancellation");
    const modelAck = oneOf(propagation.model ?? "unknown", PROPAGATION_ACKS, "invalid_cancellation", "模型取消确认");
    const toolAck = oneOf(propagation.tool ?? "unknown", PROPAGATION_ACKS, "invalid_cancellation", "工具取消确认");
    const browserAck = oneOf(propagation.browser ?? "unknown", PROPAGATION_ACKS, "invalid_cancellation", "浏览器取消确认");
    const wslAck = oneOf(propagation.wsl ?? "unknown", PROPAGATION_ACKS, "invalid_cancellation", "WSL 取消确认");
    const callbackAck = oneOf(propagation.callback ?? "unknown", PROPAGATION_ACKS, "invalid_cancellation", "回调取消确认");
    const notes = text(body.notes ?? "", 4000, "invalid_cancellation", "取消备注", 0);
    const evidence = evidenceList(body.evidence ?? [], "invalid_cancellation");
    const now = iso(this.now());
    const cancellationId = `cancel-${this.id()}`;
    return this.tx(() => {
      const attempt = this.attempt(projectId, attemptId);
      if (attempt.attempt_status !== "running") throw new HttpError(409, "attempt_not_running", "只有运行中的执行可以请求取消。");
      this.db.prepare(`INSERT INTO qa_u3_cancellations
        (cancellation_id,attempt_id,project_id,session_id,kind,status,model_ack,tool_ack,browser_ack,wsl_ack,callback_ack,residual_state,notes,evidence_json,requested_at,requested_by,acknowledged_at,acknowledged_by,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,NULL,?)`)
        .run(cancellationId, attemptId, projectId, sessionId, kind, "requested", modelAck, toolAck, browserAck, wslAck, callbackAck, "unknown", notes, JSON.stringify(evidence), now, userId, now);
      return this.cancellationView(row<Record<string, unknown>>(this.db.prepare("SELECT * FROM qa_u3_cancellations WHERE cancellation_id=?").get(cancellationId)));
    });
  }

  private cancellationView(item: Record<string, unknown>) {
    return {
      cancellationId: item.cancellation_id,
      attemptId: item.attempt_id,
      sessionId: item.session_id,
      kind: item.kind,
      status: item.status,
      propagation: {
        model: item.model_ack,
        tool: item.tool_ack,
        browser: item.browser_ack,
        wsl: item.wsl_ack,
        callback: item.callback_ack
      },
      residualState: item.residual_state,
      notes: item.notes,
      evidence: parseJson<unknown[]>(String(item.evidence_json), []),
      requestedAt: item.requested_at,
      requestedBy: item.requested_by,
      acknowledgedAt: item.acknowledged_at,
      acknowledgedBy: item.acknowledged_by,
      updatedAt: item.updated_at,
      processVerifications: this.db.prepare("SELECT * FROM qa_u3_process_verifications WHERE cancellation_id=? ORDER BY created_at,target_kind").all(String(item.cancellation_id)).map(raw => this.processView(row<Record<string, unknown>>(raw)))
    };
  }

  private processView(item: Record<string, unknown>) {
    return {
      verificationId: item.verification_id,
      cancellationId: item.cancellation_id,
      targetKind: item.target_kind,
      target: item.target,
      pid: item.pid,
      processGroup: item.process_group,
      verificationMethod: item.verification_method,
      beforeAlive: item.before_alive,
      afterAlive: item.after_alive,
      exitCode: item.exit_code,
      state: item.state,
      evidence: parseJson<unknown[]>(String(item.evidence_json), []),
      createdAt: item.created_at,
      createdBy: item.created_by
    };
  }

  addProcessVerification(projectId: string, cancellationId: string, body: Record<string, unknown>, userId: string) {
    const targetKind = oneOf(body.targetKind, PROCESS_TARGET_KINDS, "invalid_process_verification", "进程目标类型");
    const target = text(body.target, 500, "invalid_process_verification", "进程目标");
    const pid = body.pid === undefined || body.pid === null ? null : Number(body.pid);
    const processGroup = body.processGroup === undefined || body.processGroup === null ? null : text(body.processGroup, 200, "invalid_process_verification", "进程组");
    const method = text(body.verificationMethod, 500, "invalid_process_verification", "验证方法");
    const beforeAlive = body.beforeAlive === undefined || body.beforeAlive === null ? null : (body.beforeAlive === true ? 1 : body.beforeAlive === false ? 0 : Number(body.beforeAlive));
    const afterAlive = body.afterAlive === undefined || body.afterAlive === null ? null : (body.afterAlive === true ? 1 : body.afterAlive === false ? 0 : Number(body.afterAlive));
    const exitCode = body.exitCode === undefined || body.exitCode === null ? null : Number(body.exitCode);
    const state = oneOf(body.state, PROCESS_STATES, "invalid_process_verification", "进程回收状态");
    const evidence = evidenceList(body.evidence ?? [], "invalid_process_verification");
    const now = iso(this.now());
    const verificationId = `proc-${this.id()}`;
    return this.tx(() => {
      const cancellation = row<Record<string, unknown> | undefined>(this.db.prepare("SELECT * FROM qa_u3_cancellations WHERE cancellation_id=? AND project_id=?").get(cancellationId, projectId));
      if (!cancellation) throw new HttpError(404, "cancellation_not_found", "取消记录不存在。");
      if (pid !== null && (!Number.isSafeInteger(pid) || pid < 1)) throw new HttpError(400, "invalid_process_verification", "PID 无效。");
      if (exitCode !== null && !Number.isSafeInteger(exitCode)) throw new HttpError(400, "invalid_process_verification", "退出码无效。");
      if (state === "terminated" && afterAlive !== 0) throw new HttpError(400, "invalid_process_verification", "进程已回收必须确认 afterAlive=0。");
      if (state === "terminated" && !evidence.length) throw new HttpError(400, "invalid_process_verification", "进程回收必须提供证据。");
      this.db.prepare(`INSERT INTO qa_u3_process_verifications
        (verification_id,cancellation_id,attempt_id,project_id,target_kind,target,pid,process_group,verification_method,before_alive,after_alive,exit_code,state,evidence_json,created_at,created_by)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(verificationId, cancellationId, String(cancellation.attempt_id), projectId, targetKind, target, pid, processGroup, method, beforeAlive, afterAlive, exitCode, state, JSON.stringify(evidence), now, userId);
      const field = targetKind === "browser" ? "browser_ack" : targetKind === "wsl" ? "wsl_ack" : targetKind === "tool" ? "tool_ack" : targetKind === "model" ? "model_ack" : "callback_ack";
      const ack = state === "terminated" ? "acknowledged" : state === "failed" ? "failed" : "unknown";
      this.db.prepare(`UPDATE qa_u3_cancellations SET ${field}=?,updated_at=? WHERE cancellation_id=?`).run(ack, now, cancellationId);
      this.refreshCancellationStatus(String(cancellation.cancellation_id), userId);
      return this.processView(row<Record<string, unknown>>(this.db.prepare("SELECT * FROM qa_u3_process_verifications WHERE verification_id=?").get(verificationId)));
    });
  }

  acknowledgeCancellation(projectId: string, cancellationId: string, body: Record<string, unknown>, userId: string) {
    const propagation = object(body.propagation ?? {}, "invalid_cancellation");
    const modelAck = oneOf(body.modelAck ?? propagation.model ?? "unknown", PROPAGATION_ACKS, "invalid_cancellation", "模型取消确认");
    const toolAck = oneOf(body.toolAck ?? propagation.tool ?? "unknown", PROPAGATION_ACKS, "invalid_cancellation", "工具取消确认");
    const browserAck = oneOf(body.browserAck ?? propagation.browser ?? "unknown", PROPAGATION_ACKS, "invalid_cancellation", "浏览器取消确认");
    const wslAck = oneOf(body.wslAck ?? propagation.wsl ?? "unknown", PROPAGATION_ACKS, "invalid_cancellation", "WSL 取消确认");
    const callbackAck = oneOf(body.callbackAck ?? propagation.callback ?? "unknown", PROPAGATION_ACKS, "invalid_cancellation", "回调取消确认");
    const residualState = oneOf(body.residualState ?? "unknown", RESIDUAL_STATES, "invalid_cancellation", "残留状态");
    const notes = text(body.notes ?? "", 4000, "invalid_cancellation", "取消确认备注", 0);
    const evidence = evidenceList(body.evidence ?? [], "invalid_cancellation");
    const now = iso(this.now());
    return this.tx(() => {
      const found = row<Record<string, unknown> | undefined>(this.db.prepare("SELECT * FROM qa_u3_cancellations WHERE cancellation_id=? AND project_id=?").get(cancellationId, projectId));
      if (!found) throw new HttpError(404, "cancellation_not_found", "取消记录不存在。");
      for(const [field, value] of [["model_ack",modelAck],["tool_ack",toolAck],["browser_ack",browserAck],["wsl_ack",wslAck],["callback_ack",callbackAck]] as const) {
        this.db.prepare(`UPDATE qa_u3_cancellations SET ${field}=? WHERE cancellation_id=?`).run(value, cancellationId);
      }
      this.db.prepare("UPDATE qa_u3_cancellations SET residual_state=?,notes=?,evidence_json=?,acknowledged_at=?,acknowledged_by=?,updated_at=? WHERE cancellation_id=?")
        .run(residualState, notes, JSON.stringify(evidence), now, userId, now, cancellationId);
      this.refreshCancellationStatus(cancellationId, userId);
      return this.cancellationView(row<Record<string, unknown>>(this.db.prepare("SELECT * FROM qa_u3_cancellations WHERE cancellation_id=?").get(cancellationId)));
    });
  }

  private refreshCancellationStatus(cancellationId: string, userId: string) {
    const item = row<Record<string, unknown>>(this.db.prepare("SELECT * FROM qa_u3_cancellations WHERE cancellation_id=?").get(cancellationId));
    const acks = [String(item.model_ack), String(item.tool_ack), String(item.browser_ack), String(item.wsl_ack), String(item.callback_ack)];
    let status = "acknowledged";
    if (acks.some(value => value === "failed" || value === "unknown")) status = "partial";
    else if (acks.some(value => value === "sent" || value === "requested")) status = "propagating";
    const residual = String(item.residual_state);
    if (residual === "unknown" || residual === "cleanup_failed") status = status === "failed" ? "failed" : "partial";
    const browserTerminated = Number((this.db.prepare("SELECT count(*) AS n FROM qa_u3_process_verifications WHERE cancellation_id=? AND target_kind='browser' AND state='terminated'").get(cancellationId) as {n?:number}).n ?? 0);
    const browserFailed = Number((this.db.prepare("SELECT count(*) AS n FROM qa_u3_process_verifications WHERE cancellation_id=? AND target_kind='browser' AND state='failed'").get(cancellationId) as {n?:number}).n ?? 0);
    if (browserAckRequired(item) && browserTerminated === 0 && browserFailed === 0) status = "propagating";
    if (browserFailed > 0) status = "partial";
    this.db.prepare("UPDATE qa_u3_cancellations SET status=?,acknowledged_at=COALESCE(acknowledged_at,?),acknowledged_by=COALESCE(acknowledged_by,?),updated_at=? WHERE cancellation_id=?")
      .run(status, iso(this.now()), userId, iso(this.now()), cancellationId);
  }

  recordFaultInjection(projectId: string, attemptId: string, body: Record<string, unknown>, userId: string) {
    const caseAttemptId = body.caseAttemptId === undefined || body.caseAttemptId === null ? null : String(body.caseAttemptId);
    const kind = oneOf(body.kind, FAULT_KINDS, "invalid_fault", "故障类型");
    const state = oneOf(body.state, FAULT_STATES, "invalid_fault", "故障状态");
    const expected = text(body.expectedEffect, 4000, "invalid_fault", "预期效果");
    const observed = text(body.observedEffect ?? "", 8000, "invalid_fault", "观察效果", 0);
    const cleanupState = oneOf(body.cleanupState ?? "unknown", ["clean", "known_residue", "cleanup_failed", "unknown"], "invalid_fault", "清理状态");
    const evidence = evidenceList(body.evidence ?? [], "invalid_fault");
    const now = iso(this.now());
    const injectionId = `fault-${this.id()}`;
    return this.tx(() => {
      const attempt = this.attempt(projectId, attemptId);
      if (attempt.attempt_status !== "running") throw new HttpError(409, "attempt_not_running", "只有运行中的执行可以进行故障注入。");
      if (caseAttemptId) this.caseAttempt(projectId, attemptId, caseAttemptId);
      if (state === "recovered" && !observed) throw new HttpError(400, "invalid_fault", "故障恢复必须记录观察结果。");
      if (state === "recovered" && !evidence.length) throw new HttpError(400, "invalid_fault", "故障恢复必须提供证据。");
      this.db.prepare(`INSERT INTO qa_u3_fault_injections
        (injection_id,attempt_id,project_id,case_attempt_id,kind,state,expected_effect,observed_effect,cleanup_state,evidence_json,injected_at,injected_by,recovered_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,NULL,?)`)
        .run(injectionId, attemptId, projectId, caseAttemptId, kind, state, expected, observed, cleanupState, JSON.stringify(evidence), now, userId, now);
      return this.faultView(row<Record<string, unknown>>(this.db.prepare("SELECT * FROM qa_u3_fault_injections WHERE injection_id=?").get(injectionId)));
    });
  }

  private faultView(item: Record<string, unknown>) {
    return {
      injectionId: item.injection_id,
      attemptId: item.attempt_id,
      caseAttemptId: item.case_attempt_id,
      kind: item.kind,
      state: item.state,
      expectedEffect: item.expected_effect,
      observedEffect: item.observed_effect,
      cleanupState: item.cleanup_state,
      evidence: parseJson<unknown[]>(String(item.evidence_json), []),
      injectedAt: item.injected_at,
      injectedBy: item.injected_by,
      recoveredAt: item.recovered_at,
      updatedAt: item.updated_at
    };
  }

  updateFaultInjection(projectId: string, injectionId: string, body: Record<string, unknown>, userId: string) {
    const state = oneOf(body.state, FAULT_STATES, "invalid_fault", "故障状态");
    const observed = text(body.observedEffect ?? "", 8000, "invalid_fault", "观察效果", 0);
    const cleanupState = oneOf(body.cleanupState ?? "unknown", ["clean", "known_residue", "cleanup_failed", "unknown"], "invalid_fault", "清理状态");
    const evidence = evidenceList(body.evidence ?? [], "invalid_fault");
    const now = iso(this.now());
    return this.tx(() => {
      const found = row<Record<string, unknown> | undefined>(this.db.prepare("SELECT * FROM qa_u3_fault_injections WHERE injection_id=? AND project_id=?").get(injectionId, projectId));
      if (!found) throw new HttpError(404, "fault_not_found", "故障注入记录不存在。");
      if (state === "recovered" && (!observed || !evidence.length)) throw new HttpError(400, "invalid_fault", "故障恢复必须记录观察结果和证据。");
      this.db.prepare("UPDATE qa_u3_fault_injections SET state=?,observed_effect=?,cleanup_state=?,evidence_json=?,recovered_at=COALESCE(recovered_at,?),updated_at=? WHERE injection_id=?")
        .run(state, observed, cleanupState, JSON.stringify(evidence), now, now, injectionId);
      return this.faultView(row<Record<string, unknown>>(this.db.prepare("SELECT * FROM qa_u3_fault_injections WHERE injection_id=?").get(injectionId)));
    });
  }

  safetySummary(projectId: string, attemptId: string) {
    const readiness = this.cleanupReadiness(projectId, attemptId);
    const coverage = this.db.prepare("SELECT * FROM qa_u3_interface_coverage WHERE attempt_id=? ORDER BY route_key").all(attemptId).map(item => row<Record<string, unknown>>(item)).map(item => this.coverageView(item));
    const checkpoints = this.db.prepare("SELECT * FROM qa_u3_case_checkpoints WHERE attempt_id=? ORDER BY ordinal").all(attemptId).map(item => row<Record<string, unknown>>(item)).map(item => this.checkpointView(item));
    const cancellations = this.db.prepare("SELECT * FROM qa_u3_cancellations WHERE attempt_id=? ORDER BY requested_at DESC").all(attemptId).map(item => row<Record<string, unknown>>(item)).map(item => this.cancellationView(item));
    const faults = this.db.prepare("SELECT * FROM qa_u3_fault_injections WHERE attempt_id=? ORDER BY injected_at DESC").all(attemptId).map(item => row<Record<string, unknown>>(item)).map(item => this.faultView(item));
    return {
      attemptId,
      cleanup: readiness,
      interfaceCoverage: { items: coverage, passed: coverage.filter(item => item.result === "passed").length, total: coverage.length },
      checkpoints,
      cancellations,
      faultInjections: faults
    };
  }

  cleanupReadiness(projectId: string, attemptId: string) {
    this.attempt(projectId, attemptId);
    const effects = this.db.prepare("SELECT * FROM qa_u3_side_effects WHERE attempt_id=? ORDER BY discovered_at,effect_id").all(attemptId).map(item => row<Record<string, unknown>>(item)).map(item => this.effectView(item));
    const cleanups = this.db.prepare("SELECT * FROM qa_u3_cleanup_actions WHERE attempt_id=? ORDER BY created_at,action_id").all(attemptId).map(item => row<Record<string, unknown>>(item)).map(item => this.cleanupView(item));
    const blockers: string[] = [];
    for(const effect of effects) {
      if (effect.state === "unknown") blockers.push(`side_effect_unknown:${effect.effectId}`);
      if (!["succeeded", "reverted", "not_required", "skipped"].includes(effect.cleanupState)) blockers.push(`cleanup_incomplete:${effect.effectId}`);
    }
    for(const action of cleanups) {
      if (["failed", "unknown"].includes(String(action.state))) blockers.push(`cleanup_action_${action.state}:${action.actionId}`);
    }
    return { attemptId, ready: blockers.length === 0, blockers, sideEffects: effects, cleanupActions: cleanups };
  }

  private cleanupView(item: Record<string, unknown>) {
    return {
      actionId: item.action_id,
      attemptId: item.attempt_id,
      effectId: item.effect_id,
      caseAttemptId: item.case_attempt_id,
      action: item.action,
      state: String(item.state),
      verification: parseJson<unknown>(String(item.verification_json), {}),
      failureClass: item.failure_class,
      defectRefs: parseJson<string[]>(String(item.defect_refs_json), []),
      evidence: parseJson<unknown[]>(String(item.evidence_json), []),
      startedAt: item.started_at,
      finishedAt: item.finished_at,
      createdBy: item.created_by,
      updatedAt: item.updated_at
    };
  }
}
