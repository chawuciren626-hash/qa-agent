/**
 * U2 contract preparation: auditable planning objects for a future real-test pilot.
 * These records are evidence about intent and environment identity; they do not execute tests,
 * do not assert results, and never turn an unconfirmed Oracle into a pass.
 */
import { createHash, randomUUID } from "node:crypto";
import { HttpError } from "../http/errors.js";
import { parseEvidenceRefs, type KnowledgeDb } from "./qa-project-knowledge.js";

export const MISSION_STATUSES = ["draft", "active", "completed", "cancelled"] as const;
export const ORACLE_SOURCES = [
  "requirement",
  "acceptance",
  "api_contract",
  "historical_defect",
  "business_confirmation",
] as const;
export const ORACLE_STATUSES = ["unconfirmed", "confirmed", "retired"] as const;
export const LINK_RELATIONS = ["covers", "validates", "supports"] as const;
export const ENVELOPE_CARRIERS = ["web", "windows_client", "api", "mobile", "other"] as const;
export const ENVELOPE_BACKENDS = ["local_service", "local_browser", "wsl", "api_client", "other"] as const;
export const ENVELOPE_AUTHORIZATION = ["online", "degraded", "offline", "unknown"] as const;
export const ENVELOPE_STATUSES = ["draft", "frozen", "mismatch", "retired"] as const;
export const ATTEMPT_STATUSES = ["running", "completed", "blocked", "cancelled"] as const;
export const ATTEMPT_RESULTS = ["pending", "passed", "failed", "blocked", "needs_review"] as const;
export const CLEANUP_STATES = ["unknown", "dirty", "clean", "failed"] as const;
export const CASE_ATTEMPT_STATUSES = ["not_run", "passed", "failed", "blocked", "unknown", "needs_review"] as const;
export const FAILURE_CLASSES = ["product_defect", "environment_issue", "automation_issue", "test_issue", "unknown"] as const;

type MissionStatus = (typeof MISSION_STATUSES)[number];
type OracleStatus = (typeof ORACLE_STATUSES)[number];

interface MissionRow {
  mission_id: string;
  project_id: string;
  title: string;
  objective: string;
  scope_json: string;
  risks_json: string;
  authorization_json: string;
  deliverables_json: string;
  status: MissionStatus;
  revision: number;
  content_hash: string;
  created_at: string;
  created_by: string;
  updated_at: string;
}

interface OracleRow {
  oracle_id: string;
  mission_id: string;
  project_id: string;
  oracle_key: string;
  capability: string;
  statement: string;
  source_type: string;
  source_ref: string;
  source_hash: string | null;
  status: OracleStatus;
  confirmed_by: string | null;
  confirmed_at: string | null;
  confirmation_reason: string | null;
  evidence_refs_json: string;
  revision: number;
  created_at: string;
  updated_at: string;
}

interface EnvelopeRow {
  envelope_id: string;
  mission_id: string;
  project_id: string;
  label: string;
  target_ref: string;
  target_version: string;
  actual_version: string | null;
  carrier: string;
  os_name: string;
  account_role: string;
  agent_id: string;
  agent_bundle_hash: string;
  skills_json: string;
  plugins_json: string;
  model_json: string;
  connectors_json: string;
  backend: string;
  authorization_state: string;
  resource_set_hash: string;
  data_state_json: string;
  cleanup_plan_json: string;
  identity_hash: string;
  status: string;
  revision: number;
  created_at: string;
  created_by: string;
  updated_at: string;
}

const KEY = /^[A-Za-z0-9_.:-]{1,100}$/;
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const HASH = /^(?:sha256:)?[a-f0-9]{64}$/;

const text = (value: unknown, max: number, code: string, label: string, min = 1): string => {
  if (typeof value !== "string") throw new HttpError(400, code, `${label} 必须是文本。`);
  const raw = value.trim();
  if (raw.length < min) throw new HttpError(400, code, `${label} 不能为空。`);
  if (raw.length > max) throw new HttpError(400, code, `${label} 超过长度限制。`);
  return raw;
};
const key = (value: unknown, code: string, label: string): string => {
  const raw = text(value, 100, code, label);
  if (!KEY.test(raw)) throw new HttpError(400, code, `${label} 格式无效。`);
  return raw;
};
const id = (value: unknown, code: string, label: string): string => {
  const raw = text(value, 128, code, label);
  if (!ID.test(raw)) throw new HttpError(400, code, `${label} 格式无效。`);
  return raw;
};
const jsonValue = (value: unknown, code: string): unknown => {
  if (value === undefined || value === null || typeof value === "function") throw new HttpError(400, code, "JSON 内容无效。");
  return value;
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
const hashMap = (value: unknown, code: string, label: string): Record<string, string> => {
  const raw = object(value, code);
  return Object.fromEntries(Object.entries(raw).map(([name, item]) => {
    if (!name.trim() || name.length > 200) throw new HttpError(400, code, `${label} 名称无效。`);
    return [name, hash(item, code, `${label}.${name}`)];
  }));
};
const sorted = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map(name => [name, sorted((value as Record<string, unknown>)[name])]));
  }
  return value;
};
const canonical = (value: unknown) => JSON.stringify(sorted(value));
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
const contentHash = (value: unknown) => `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`;
const parseJson = <T>(raw: string, fallback: T): T => {
  try { return JSON.parse(raw) as T; } catch { return fallback; }
};
const row = <T>(value: unknown): T => value as T;
const iso = (ms: number) => new Date(ms).toISOString();

export class QaU2ContractStore {
  private readonly now: () => number;
  private readonly id: () => string;

  constructor(private readonly db: KnowledgeDb, options: { now?: () => number; id?: () => string } = {}) {
    this.now = options.now ?? (() => Date.now());
    this.id = options.id ?? randomUUID;
  }

  private tx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private mission(projectId: string, missionId: string): MissionRow {
    if (!ID.test(missionId)) throw new HttpError(404, "mission_not_found", "测试任务不存在。");
    const found = row<MissionRow | undefined>(this.db.prepare("SELECT * FROM qa_test_missions WHERE mission_id=? AND project_id=?").get(missionId, projectId));
    if (!found) throw new HttpError(404, "mission_not_found", "测试任务不存在。");
    return found;
  }

  private oracle(projectId: string, missionId: string, oracleId: string): OracleRow {
    const found = row<OracleRow | undefined>(this.db.prepare("SELECT * FROM qa_oracle_entries WHERE oracle_id=? AND mission_id=? AND project_id=?").get(oracleId, missionId, projectId));
    if (!found) throw new HttpError(404, "oracle_not_found", "Oracle 不存在。");
    return found;
  }

  createMission(projectId: string, userId: string, body: Record<string, unknown>) {
    const title = text(body.title, 200, "invalid_mission", "任务标题");
    const objective = text(body.objective, 4000, "invalid_mission", "任务目标");
    const scope = jsonValue(body.scope, "invalid_mission");
    const risks = jsonValue(body.risks, "invalid_mission");
    const authorization = jsonValue(body.authorization, "invalid_mission");
    const deliverables = jsonValue(body.deliverables, "invalid_mission");
    const status = oneOf(body.status ?? "draft", MISSION_STATUSES, "invalid_mission", "任务状态");
    const now = iso(this.now());
    const missionId = `mission-${this.id()}`;
    const content = { title, objective, scope, risks, authorization, deliverables };
    return this.tx(() => {
      this.db.prepare(`INSERT INTO qa_test_missions
        (mission_id,project_id,title,objective,scope_json,risks_json,authorization_json,deliverables_json,status,revision,content_hash,created_at,created_by,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,1,?,?,?,?)`)
        .run(missionId, projectId, title, objective, JSON.stringify(scope), JSON.stringify(risks), JSON.stringify(authorization), JSON.stringify(deliverables), status, contentHash(content), now, userId, now);
      return this.getMission(projectId, missionId);
    });
  }

  listMissions(projectId: string) {
    const missions = this.db.prepare("SELECT * FROM qa_test_missions WHERE project_id=? ORDER BY updated_at DESC, mission_id").all(projectId).map(raw => {
      const mission = row<MissionRow>(raw);
      return this.missionView(mission, false);
    });
    return { missions };
  }

  getMission(projectId: string, missionId: string) {
    return this.missionView(this.mission(projectId, missionId), true);
  }

  private missionView(mission: MissionRow, detail: boolean) {
    const oracles = this.db.prepare("SELECT * FROM qa_oracle_entries WHERE mission_id=? ORDER BY oracle_key").all(mission.mission_id).map(raw => this.oracleView(row<OracleRow>(raw)));
    const links = detail ? this.db.prepare("SELECT * FROM qa_case_graph_links WHERE mission_id=? ORDER BY created_at, link_id").all(mission.mission_id).map(raw => this.linkView(row<Record<string, unknown>>(raw))) : [];
    const envelopes = detail ? this.db.prepare("SELECT * FROM qa_execution_envelopes WHERE mission_id=? ORDER BY created_at, envelope_id").all(mission.mission_id).map(raw => this.envelopeView(row<EnvelopeRow>(raw))) : [];
    const view = {
      missionId: mission.mission_id,
      projectId: mission.project_id,
      title: mission.title,
      objective: mission.objective,
      scope: parseJson<Record<string, unknown>>(mission.scope_json, {}),
      risks: parseJson<Record<string, unknown>>(mission.risks_json, {}),
      authorization: parseJson<Record<string, unknown>>(mission.authorization_json, {}),
      deliverables: parseJson<Record<string, unknown>>(mission.deliverables_json, {}),
      status: mission.status,
      revision: mission.revision,
      contentHash: mission.content_hash,
      createdAt: mission.created_at,
      createdBy: mission.created_by,
      updatedAt: mission.updated_at,
      oracleCount: oracles.length,
      confirmedOracleCount: oracles.filter(item => item.status === "confirmed").length,
      envelopeCount: envelopes.length,
      ...(detail ? { oracles, links, envelopes } : {})
    };
    return view;
  }

  private oracleView(item: OracleRow) {
    return {
      oracleId: item.oracle_id,
      missionId: item.mission_id,
      oracleKey: item.oracle_key,
      capability: item.capability,
      statement: item.statement,
      sourceType: item.source_type,
      sourceRef: item.source_ref,
      sourceHash: item.source_hash,
      status: item.status,
      confirmedBy: item.confirmed_by,
      confirmedAt: item.confirmed_at,
      confirmationReason: item.confirmation_reason,
      evidenceRefs: parseJson<unknown[]>(item.evidence_refs_json, []),
      revision: item.revision,
      createdAt: item.created_at,
      updatedAt: item.updated_at
    };
  }

  private linkView(item: Record<string, unknown>) {
    return {
      linkId: item.link_id,
      missionId: item.mission_id,
      oracleId: item.oracle_id,
      pointKey: item.point_key,
      caseKey: item.case_key,
      relation: item.relation,
      createdAt: item.created_at,
      createdBy: item.created_by
    };
  }

  private envelopeView(item: EnvelopeRow) {
    return {
      envelopeId: item.envelope_id,
      missionId: item.mission_id,
      label: item.label,
      targetRef: item.target_ref,
      targetVersion: item.target_version,
      actualVersion: item.actual_version,
      carrier: item.carrier,
      osName: item.os_name,
      accountRole: item.account_role,
      agentId: item.agent_id,
      agentBundleHash: item.agent_bundle_hash,
      skills: parseJson<Record<string, string>>(item.skills_json, {}),
      plugins: parseJson<Record<string, string>>(item.plugins_json, {}),
      model: parseJson<Record<string, unknown>>(item.model_json, {}),
      connectors: parseJson<Record<string, string>>(item.connectors_json, {}),
      backend: item.backend,
      authorizationState: item.authorization_state,
      resourceSetHash: item.resource_set_hash,
      dataState: parseJson<Record<string, unknown>>(item.data_state_json, {}),
      cleanupPlan: parseJson<Record<string, unknown>>(item.cleanup_plan_json, {}),
      identityHash: item.identity_hash,
      status: item.status,
      revision: item.revision,
      createdAt: item.created_at,
      createdBy: item.created_by,
      updatedAt: item.updated_at
    };
  }

  createOracle(projectId: string, missionId: string, body: Record<string, unknown>) {
    const oracleKey = key(body.oracleKey, "invalid_oracle", "Oracle key");
    const capability = text(body.capability, 300, "invalid_oracle", "能力名称");
    const statement = text(body.statement, 8000, "invalid_oracle", "预期陈述");
    const sourceType = oneOf(body.sourceType, ORACLE_SOURCES, "invalid_oracle", "Oracle 来源");
    const sourceRef = text(body.sourceRef, 1000, "invalid_oracle", "Oracle 来源引用");
    const sourceHash = body.sourceHash === undefined || body.sourceHash === null ? null : hash(body.sourceHash, "invalid_oracle", "Oracle 来源哈希");
    const evidenceRefs = parseEvidenceRefs(body.evidenceRefs ?? [], "invalid_oracle");
    const now = iso(this.now());
    const oracleId = `oracle-${this.id()}`;
    return this.tx(() => {
      const mission = this.mission(projectId, missionId);
      if (mission.status === "completed" || mission.status === "cancelled") {
        throw new HttpError(409, "mission_closed", "任务已结束，不能新增 Oracle。");
      }
      this.db.prepare(`INSERT INTO qa_oracle_entries
        (oracle_id,mission_id,project_id,oracle_key,capability,statement,source_type,source_ref,source_hash,status,confirmed_by,confirmed_at,confirmation_reason,evidence_refs_json,revision,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,'unconfirmed',NULL,NULL,NULL,?,1,?,?)`)
        .run(oracleId, mission.mission_id, projectId, oracleKey, capability, statement, sourceType, sourceRef, sourceHash, JSON.stringify(evidenceRefs), now, now);
      return this.oracleView(this.oracle(projectId, mission.mission_id, oracleId));
    });
  }

  confirmOracle(projectId: string, oracleId: string, userId: string, body: Record<string, unknown>) {
    const reason = text(body.reason, 2000, "invalid_oracle", "确认理由");
    const evidenceRefs = parseEvidenceRefs(body.evidenceRefs ?? [], "invalid_oracle");
    const now = iso(this.now());
    return this.tx(() => {
      const current = row<OracleRow | undefined>(this.db.prepare("SELECT * FROM qa_oracle_entries WHERE oracle_id=? AND project_id=?").get(oracleId, projectId));
      if (!current) throw new HttpError(404, "oracle_not_found", "Oracle 不存在。");
      if (current.status === "retired") throw new HttpError(409, "oracle_retired", "Oracle 已废止，不能确认。");
      this.db.prepare("UPDATE qa_oracle_entries SET status='confirmed',confirmed_by=?,confirmed_at=?,confirmation_reason=?,evidence_refs_json=?,revision=revision+1,updated_at=? WHERE oracle_id=?")
        .run(userId, now, reason, JSON.stringify(evidenceRefs), now, oracleId);
      return this.oracleView(this.oracle(projectId, current.mission_id, oracleId));
    });
  }


  linkOracle(projectId: string, missionId: string, body: Record<string, unknown>, userId: string) {
    const oracleId = id(body.oracleId, "invalid_link", "Oracle id");
    const pointKey = key(body.pointKey, "invalid_link", "测试点 key");
    const caseKey = key(body.caseKey, "invalid_link", "用例 key");
    const relation = oneOf(body.relation ?? "covers", LINK_RELATIONS, "invalid_link", "关系类型");
    const now = iso(this.now());
    const linkId = `link-${this.id()}`;
    return this.tx(() => {
      const mission = this.mission(projectId, missionId);
      const oracle = this.oracle(projectId, mission.mission_id, oracleId);
      this.db.prepare("INSERT INTO qa_case_graph_links (link_id,mission_id,project_id,oracle_id,point_key,case_key,relation,created_at,created_by) VALUES (?,?,?,?,?,?,?,?,?)")
        .run(linkId, mission.mission_id, projectId, oracle.oracle_id, pointKey, caseKey, relation, now, userId);
      return { linkId, missionId: mission.mission_id, oracleId: oracle.oracle_id, pointKey, caseKey, relation, createdAt: now, createdBy: userId };
    });
  }

  createEnvelope(projectId: string, missionId: string, body: Record<string, unknown>, userId: string) {
    const label = text(body.label, 120, "invalid_envelope", "执行环境名称");
    const targetRef = text(body.targetRef, 1000, "invalid_envelope", "目标引用");
    const targetVersion = text(body.targetVersion, 200, "invalid_envelope", "目标版本");
    const actualVersion = body.actualVersion === undefined || body.actualVersion === null ? null : text(body.actualVersion, 200, "invalid_envelope", "实际版本");
    const carrier = oneOf(body.carrier, ENVELOPE_CARRIERS, "invalid_envelope", "测试载体");
    const osName = text(body.osName, 200, "invalid_envelope", "操作系统");
    const accountRole = text(body.accountRole, 200, "invalid_envelope", "账号角色");
    const agentId = id(body.agentId, "invalid_envelope", "Agent id");
    const agentBundleHash = hash(body.agentBundleHash, "invalid_envelope", "Agent bundle hash");
    const skills = hashMap(body.skills ?? {}, "invalid_envelope", "Skill hashes");
    const plugins = hashMap(body.plugins ?? {}, "invalid_envelope", "Plugin hashes");
    const model = object(body.model, "invalid_envelope");
    const connectors = hashMap(body.connectors ?? {}, "invalid_envelope", "Connector hashes");
    const backend = oneOf(body.backend, ENVELOPE_BACKENDS, "invalid_envelope", "执行后端");
    const authorizationState = oneOf(body.authorizationState ?? "unknown", ENVELOPE_AUTHORIZATION, "invalid_envelope", "授权状态");
    const resourceSetHash = hash(body.resourceSetHash, "invalid_envelope", "资源集合哈希");
    const dataState = object(body.dataState, "invalid_envelope");
    const cleanupPlan = object(body.cleanupPlan, "invalid_envelope");
    const identity = { targetRef, targetVersion, actualVersion, carrier, osName, accountRole, agentId, agentBundleHash, skills, plugins, model, connectors, backend, authorizationState, resourceSetHash, dataState, cleanupPlan };
    const now = iso(this.now());
    const envelopeId = `envelope-${this.id()}`;
    return this.tx(() => {
      const mission = this.mission(projectId, missionId);
      this.db.prepare(`INSERT INTO qa_execution_envelopes
        (envelope_id,mission_id,project_id,label,target_ref,target_version,actual_version,carrier,os_name,account_role,agent_id,agent_bundle_hash,skills_json,plugins_json,model_json,connectors_json,backend,authorization_state,resource_set_hash,data_state_json,cleanup_plan_json,identity_hash,status,revision,created_at,created_by,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'draft',1,?,?,?)`)
        .run(envelopeId, mission.mission_id, projectId, label, targetRef, targetVersion, actualVersion, carrier, osName, accountRole, agentId, agentBundleHash, JSON.stringify(skills), JSON.stringify(plugins), JSON.stringify(model), JSON.stringify(connectors), backend, authorizationState, resourceSetHash, JSON.stringify(dataState), JSON.stringify(cleanupPlan), contentHash(identity), now, userId, now);
      return this.envelopeView(row<EnvelopeRow>(this.db.prepare("SELECT * FROM qa_execution_envelopes WHERE envelope_id=?").get(envelopeId)));
    });
  }

  freezeEnvelope(projectId: string, envelopeId: string, userId: string) {
    const now = iso(this.now());
    return this.tx(() => {
      const current = row<EnvelopeRow | undefined>(this.db.prepare("SELECT * FROM qa_execution_envelopes WHERE envelope_id=? AND project_id=?").get(envelopeId, projectId));
      if (!current) throw new HttpError(404, "envelope_not_found", "执行环境合同不存在。");
      if (current.status === "retired") throw new HttpError(409, "envelope_retired", "执行环境合同已废止。");
      const blockers: string[] = [];
      if (!current.actual_version) blockers.push("actual_version");
      if (!current.resource_set_hash) blockers.push("resource_set_hash");
      if (current.authorization_state !== "online") blockers.push("authorization_online");
      if (!current.cleanup_plan_json || current.cleanup_plan_json === "{}") blockers.push("cleanup_plan");
      const confirmedLinked = Number((this.db.prepare(`SELECT count(*) AS n FROM qa_oracle_entries o JOIN qa_case_graph_links l ON l.oracle_id=o.oracle_id
        WHERE o.mission_id=? AND o.status='confirmed'`).get(current.mission_id) as { n?: number }).n ?? 0);
      if (confirmedLinked < 1) blockers.push("confirmed_case_oracle");
      if (blockers.length) throw new HttpError(409, "envelope_freeze_blocked", `执行环境合同缺少冻结条件：${blockers.join(", ")}`);
      this.db.prepare("UPDATE qa_execution_envelopes SET status='frozen',revision=revision+1,updated_at=? WHERE envelope_id=?").run(now, envelopeId);
      return this.envelopeView(row<EnvelopeRow>(this.db.prepare("SELECT * FROM qa_execution_envelopes WHERE envelope_id=?").get(envelopeId)));
    });
  }
  startAttempt(projectId: string, missionId: string, body: Record<string, unknown>, userId: string) {
    const executor = typeof body.executor === "string" && body.executor.trim() ? text(body.executor, 120, "invalid_attempt", "执行者") : userId;
    const identityClaim = hash(body.envelopeIdentityHash, "invalid_attempt", "Envelope identity hash");
    const now = iso(this.now());
    const attemptId = `attempt-${this.id()}`;
    return this.tx(() => {
      const mission = this.mission(projectId, missionId);
      const envelope = row<EnvelopeRow | undefined>(this.db.prepare("SELECT * FROM qa_execution_envelopes WHERE envelope_id=? AND project_id=?").get(id(body.envelopeId, "invalid_attempt", "Envelope id"), projectId));
      if (!envelope || envelope.mission_id !== mission.mission_id) throw new HttpError(404, "envelope_not_found", "执行环境合同不存在。");
      if (envelope.status !== "frozen") throw new HttpError(409, "envelope_not_frozen", "只有冻结的执行环境合同可以开始执行。");
      if (envelope.identity_hash !== identityClaim) throw new HttpError(409, "envelope_identity_mismatch", "Envelope identity hash 与冻结合同不一致。");
      const unresolvedEffects = Number((this.db.prepare(`SELECT count(*) AS n FROM qa_u3_side_effects e JOIN qa_u2_execution_attempts a ON a.attempt_id=e.attempt_id WHERE a.envelope_id=? AND (e.state='unknown' OR e.cleanup_state NOT IN ('succeeded','reverted','not_required','skipped'))`).get(envelope.envelope_id) as {n?:number}).n ?? 0);
      if (unresolvedEffects > 0) throw new HttpError(409, "environment_not_clean", "存在未知或未清理副作用；不得开始新的业务写入执行。");
      const dirtyPriorAttempt = Number((this.db.prepare("SELECT count(*) AS n FROM qa_u2_execution_attempts WHERE envelope_id=? AND attempt_status!='running' AND cleanup_state!='clean'").get(envelope.envelope_id) as {n?:number}).n ?? 0);
      if (dirtyPriorAttempt > 0) throw new HttpError(409, "environment_not_clean", "上一个执行未确认清理完成；不得开始新的业务写入执行。");
      const active = this.db.prepare("SELECT attempt_id FROM qa_u2_execution_attempts WHERE envelope_id=? AND attempt_status='running'").get(envelope.envelope_id);
      if (active) throw new HttpError(409, "attempt_running", "同一 Envelope 已有执行中的 attempt。");
      const links = this.db.prepare(`SELECT l.case_key,l.oracle_id,l.point_key,l.relation,o.status AS oracle_status
        FROM qa_case_graph_links l JOIN qa_oracle_entries o ON o.oracle_id=l.oracle_id
        WHERE l.mission_id=? ORDER BY l.case_key,l.oracle_id`).all(mission.mission_id).map(item => row<{case_key:string;oracle_id:string;point_key:string;relation:string;oracle_status:string}>(item));
      if (!links.length) throw new HttpError(409, "case_graph_empty", "Mission 没有可执行用例链接。");
      const byCase = new Map<string, typeof links[number]>();
      for(const link of links) {
        if (byCase.has(link.case_key)) throw new HttpError(409, "case_oracle_ambiguous", `用例 ${link.case_key} 关联了多个 Oracle。`);
        if (link.oracle_status !== "confirmed") throw new HttpError(409, "oracle_unconfirmed", `用例 ${link.case_key} 的 Oracle 未确认。`);
        byCase.set(link.case_key, link);
      }
      this.db.prepare(`INSERT INTO qa_u2_execution_attempts
        (attempt_id,mission_id,envelope_id,project_id,attempt_status,result,cleanup_state,observed_summary,metrics_json,evidence_json,defect_refs_json,envelope_identity_claim,revision,started_at,finished_at,created_at,created_by,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(attemptId, mission.mission_id, envelope.envelope_id, projectId, "running", "pending", "unknown", "", "{}", "[]", "[]", identityClaim, 1, now, null, now, executor, now);
      for(const link of byCase.values()) {
        this.db.prepare(`INSERT INTO qa_u2_case_attempts
          (attempt_case_id,attempt_id,mission_id,envelope_id,project_id,case_key,oracle_id,point_key,relation,status,observed,failure_class,defect_refs_json,evidence_json,started_at,finished_at,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?, 'not_run','',NULL,'[]','[]',?,?,?,?)`)
          .run(`case-${this.id()}`, attemptId, mission.mission_id, envelope.envelope_id, projectId, link.case_key, link.oracle_id, link.point_key, link.relation, now, null, now, now);
      }
      this.event(attemptId, "started", { executor, envelopeIdentityMatches: true }, now, userId);
      return this.getAttempt(projectId, attemptId);
    });
  }

  private event(attemptId: string, kind: string, detail: unknown, at: string, userId: string) {
    this.db.prepare("INSERT INTO qa_u2_attempt_events (event_id,attempt_id,kind,detail_json,created_at,created_by) VALUES (?,?,?,?,?,?)")
      .run(`event-${this.id()}`, attemptId, kind, JSON.stringify(detail), at, userId);
  }

  private attemptRow(projectId: string, attemptId: string) {
    const found = row<Record<string, unknown> | undefined>(this.db.prepare("SELECT * FROM qa_u2_execution_attempts WHERE attempt_id=? AND project_id=?").get(attemptId, projectId));
    if (!found) throw new HttpError(404, "attempt_not_found", "执行 attempt 不存在。");
    return found;
  }

  private attemptCases(attemptId: string) {
    return this.db.prepare("SELECT * FROM qa_u2_case_attempts WHERE attempt_id=? ORDER BY case_key").all(attemptId).map(item => row<Record<string, unknown>>(item));
  }

  private attemptView(found: Record<string, unknown>, detail: boolean) {
    const cases = this.attemptCases(String(found.attempt_id)).map(item => ({
      attemptCaseId: item.attempt_case_id,
      caseKey: item.case_key,
      oracleId: item.oracle_id,
      pointKey: item.point_key,
      relation: item.relation,
      status: item.status,
      observed: item.observed,
      failureClass: item.failure_class,
      defectRefs: parseJson<string[]>(String(item.defect_refs_json), []),
      evidence: parseJson<unknown[]>(String(item.evidence_json), []),
      startedAt: item.started_at,
      finishedAt: item.finished_at
    }));
    const events = detail ? this.db.prepare("SELECT * FROM qa_u2_attempt_events WHERE attempt_id=? ORDER BY created_at,event_id").all(found.attempt_id).map(item => row<Record<string, unknown>>(item)).map(item => ({
      eventId: item.event_id, kind: item.kind, detail: parseJson<unknown>(String(item.detail_json), {}), createdAt: item.created_at, createdBy: item.created_by
    })) : [];
    const identityMatches = found.envelope_identity_claim === found.envelope_identity_claim && this.db.prepare("SELECT identity_hash FROM qa_execution_envelopes WHERE envelope_id=?").get(found.envelope_id) !== undefined &&
      (this.db.prepare("SELECT identity_hash AS hash FROM qa_execution_envelopes WHERE envelope_id=?").get(found.envelope_id) as {hash?:string})?.hash === found.envelope_identity_claim;
    const view = {
      attemptId: found.attempt_id,
      missionId: found.mission_id,
      envelopeId: found.envelope_id,
      projectId: found.project_id,
      attemptStatus: found.attempt_status,
      result: found.result,
      cleanupState: found.cleanup_state,
      observedSummary: found.observed_summary,
      metrics: parseJson<Record<string, unknown>>(String(found.metrics_json), {}),
      evidence: parseJson<unknown[]>(String(found.evidence_json), []),
      defectRefs: parseJson<string[]>(String(found.defect_refs_json), []),
      envelopeIdentityClaim: found.envelope_identity_claim,
      envelopeIdentityMatches: identityMatches,
      revision: found.revision,
      startedAt: found.started_at,
      finishedAt: found.finished_at,
      createdBy: found.created_by,
      updatedAt: found.updated_at,
      caseCount: cases.length,
      ...(detail ? { cases, events } : {})
    };
    return view;
  }

  getAttempt(projectId: string, attemptId: string) {
    return this.attemptView(this.attemptRow(projectId, attemptId), true);
  }

  listAttempts(projectId: string, missionId?: string | null) {
    const rows = missionId
      ? this.db.prepare("SELECT * FROM qa_u2_execution_attempts WHERE project_id=? AND mission_id=? ORDER BY started_at DESC,attempt_id").all(projectId, missionId).map(item => row<Record<string, unknown>>(item))
      : this.db.prepare("SELECT * FROM qa_u2_execution_attempts WHERE project_id=? ORDER BY started_at DESC,attempt_id").all(projectId).map(item => row<Record<string, unknown>>(item));
    return { attempts: rows.map(item => this.attemptView(item, false)) };
  }

  finishAttempt(projectId: string, attemptId: string, body: Record<string, unknown>, userId: string) {
    const summary = text(body.observedSummary ?? "", 8000, "invalid_attempt", "执行总结", 0);
    const metrics = object(body.metrics ?? {}, "invalid_attempt");
    const evidence = evidenceList(body.evidence ?? [], "invalid_attempt");
    const defectRefs = defectRefList(body.defectRefs ?? [], "invalid_attempt");
    const cleanupState = oneOf(body.cleanupState ?? "unknown", CLEANUP_STATES, "invalid_attempt", "清理状态");
    const result = oneOf(body.result ?? "pending", ATTEMPT_RESULTS, "invalid_attempt", "执行结果");
    const attemptStatus = oneOf(body.attemptStatus ?? "completed", ["completed", "blocked"], "invalid_attempt", "attempt 状态");
    const identityClaim = hash(body.envelopeIdentityHash, "invalid_attempt", "Envelope identity hash");
    const rawCases = body.cases;
    if (!Array.isArray(rawCases) || !rawCases.length) throw new HttpError(400, "invalid_attempt", "必须提交逐用例结果。");
    const now = iso(this.now());
    return this.tx(() => {
      const found = this.attemptRow(projectId, attemptId);
      if (found.attempt_status !== "running") throw new HttpError(409, "attempt_not_running", "执行 attempt 已结束。");
      const envelope = row<EnvelopeRow>(this.db.prepare("SELECT * FROM qa_execution_envelopes WHERE envelope_id=?").get(found.envelope_id));
      const cases = this.attemptCases(String(found.attempt_id));
      const inputCases = new Map<string, Record<string, unknown>>();
      for(const item of rawCases) {
        const raw = object(item, "invalid_attempt");
        const caseKey = key(raw.caseKey, "invalid_attempt", "用例 key");
        if (inputCases.has(caseKey)) throw new HttpError(400, "invalid_attempt", `用例 ${caseKey} 重复提交。`);
        inputCases.set(caseKey, raw);
      }
      const dbKeys = cases.map(item => String(item.case_key));
      for(const caseKey of dbKeys) if (!inputCases.has(caseKey)) throw new HttpError(400, "invalid_attempt", `缺少用例结果：${caseKey}`);
      for(const caseKey of inputCases.keys()) if (!dbKeys.includes(caseKey)) throw new HttpError(400, "invalid_attempt", `用例不属于 Mission：${caseKey}`);
      const parsedCases = cases.map(dbCase => {
        const caseKey = String(dbCase.case_key);
        const raw = inputCases.get(caseKey)!;
        const status = oneOf(raw.status, CASE_ATTEMPT_STATUSES, "invalid_attempt", `用例 ${caseKey} 状态`);
        const observed = text(raw.observed ?? "", 8000, "invalid_attempt", `用例 ${caseKey} 观察`, 0);
        const failureClass = raw.failureClass === undefined || raw.failureClass === null ? null : oneOf(raw.failureClass, FAILURE_CLASSES, "invalid_attempt", `用例 ${caseKey} 失败分类`);
        const defects = defectRefList(raw.defectRefs ?? [], "invalid_attempt");
        const caseEvidence = evidenceList(raw.evidence ?? [], "invalid_attempt");
        if (status === "failed" && !failureClass) throw new HttpError(400, "invalid_attempt", `失败用例 ${caseKey} 必须提供失败分类。`);
        if (status === "failed" && failureClass === "product_defect" && !defects.length) throw new HttpError(400, "invalid_attempt", `产品缺陷用例 ${caseKey} 必须提供缺陷引用。`);
        if ((status === "passed" || status === "failed") && !caseEvidence.length) throw new HttpError(400, "invalid_attempt", `用例 ${caseKey} 必须提供证据。`);
        if (status === "unknown" && cleanupState === "clean") throw new HttpError(400, "invalid_attempt", `存在未知用例时清理状态不能标记为 clean。`);
        return { dbCase, caseKey, status, observed, failureClass, defects, caseEvidence };
      });
      const identityMatches = identityClaim === envelope.identity_hash;
      const unknownSideEffects = Number((this.db.prepare("SELECT count(*) AS n FROM qa_u3_side_effects WHERE attempt_id=? AND state='unknown'").get(attemptId) as {n?:number})?.n ?? 0);
      const incompleteCleanups = Number((this.db.prepare(`SELECT count(*) AS n FROM qa_u3_side_effects WHERE attempt_id=? AND cleanup_state NOT IN ('succeeded','reverted','not_required','skipped')`).get(attemptId) as {n?:number})?.n ?? 0);
      const failedCleanupActions = Number((this.db.prepare(`SELECT count(*) AS n FROM qa_u3_cleanup_actions WHERE attempt_id=? AND state IN ('failed','unknown')`).get(attemptId) as {n?:number})?.n ?? 0);
      const coverageRows = this.db.prepare("SELECT result FROM qa_u3_interface_coverage WHERE attempt_id=?").all(attemptId).map(item => String((item as Record<string, unknown>).result));
      const confirmedOracles = Number((this.db.prepare(`SELECT count(*) AS n FROM qa_case_graph_links l JOIN qa_oracle_entries o ON o.oracle_id=l.oracle_id
        WHERE l.mission_id=? AND o.status='confirmed'`).get(found.mission_id) as {n?:number}).n ?? 0);
      if (unknownSideEffects > 0 && !["needs_review", "blocked"].includes(result)) throw new HttpError(409, "u3_unknown_side_effect", "存在未知副作用，不能判为通过或失败；请保持待人工判定。");
      if (result === "passed" && (incompleteCleanups > 0 || failedCleanupActions > 0)) throw new HttpError(409, "u3_cleanup_not_ready", "通过结果要求 U3 清理账本就绪。");
      if (result === "passed" && coverageRows.length === 0) throw new HttpError(409, "u3_interface_coverage_missing", "通过结果要求至少一条九层覆盖通过的接口记录。");
      if (result === "passed" && coverageRows.some(item => item !== "passed")) throw new HttpError(409, "u3_interface_coverage_not_passed", "通过结果要求所有已登记接口覆盖均为通过。");
      if (result === "passed") {
        if (attemptStatus !== "completed") throw new HttpError(409, "pass_gate_failed", "通过结果必须完成 attempt。");
        if (!identityMatches) throw new HttpError(409, "pass_gate_failed", "环境身份不一致，不能判为通过。");
        if (cleanupState !== "clean") throw new HttpError(409, "pass_gate_failed", "通过结果要求清理状态为 clean。");
        if (confirmedOracles < parsedCases.length) throw new HttpError(409, "pass_gate_failed", "通过结果要求每个用例都有已确认 Oracle。");
        if (parsedCases.some(item => item.status !== "passed")) throw new HttpError(409, "pass_gate_failed", "通过结果要求所有用例均通过。");
        if (!evidence.length) throw new HttpError(409, "pass_gate_failed", "通过结果必须提供执行证据。");
      }
      if (result === "failed" && !parsedCases.some(item => item.status === "failed")) throw new HttpError(409, "invalid_attempt", "失败结果必须包含失败用例。");
      if (result === "needs_review" && !parsedCases.some(item => item.status === "unknown" || item.status === "needs_review") && cleanupState === "clean" && identityMatches) {
        throw new HttpError(409, "invalid_attempt", "没有未知判定或环境差异时不能标记为需要人工判定。");
      }
      if (attemptStatus === "blocked" && result === "passed") throw new HttpError(409, "invalid_attempt", "blocked attempt 不能判为通过。");
      for(const item of parsedCases) {
        this.db.prepare(`UPDATE qa_u2_case_attempts
          SET status=?,observed=?,failure_class=?,defect_refs_json=?,evidence_json=?,finished_at=?,updated_at=? WHERE attempt_case_id=?`)
          .run(item.status, item.observed, item.failureClass, JSON.stringify(item.defects), JSON.stringify(item.caseEvidence), now, now, String(item.dbCase.attempt_case_id));
      }
      this.db.prepare(`UPDATE qa_u2_execution_attempts
        SET attempt_status=?,result=?,cleanup_state=?,observed_summary=?,metrics_json=?,evidence_json=?,defect_refs_json=?,envelope_identity_claim=?,revision=revision+1,finished_at=?,updated_at=? WHERE attempt_id=?`)
        .run(attemptStatus, result, cleanupState, summary, JSON.stringify(metrics), JSON.stringify(evidence), JSON.stringify(defectRefs), identityClaim, now, now, attemptId);
      this.event(attemptId, "finished", { result, attemptStatus, cleanupState, identityMatches }, now, userId);
      if (!identityMatches) this.event(attemptId, "identity_mismatch", { claimed: identityClaim, frozen: envelope.identity_hash }, now, userId);
      return this.getAttempt(projectId, attemptId);
    });
  }


}
