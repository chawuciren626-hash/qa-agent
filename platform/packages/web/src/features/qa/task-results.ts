export type ResultArtifact = { path: string; name: string; stage: string; size: number; available: boolean; verified: boolean | null };
export type ResultCase = { case_id?: string; case_ref?: { source_path?: string; case_id?: string }; title?: string; status?: string; expected?: string; actual_result?: string; error_message?: string; reason?: string; evidence_paths?: string[]; [key: string]: unknown };
export type DesignCase = { case_id?: string; title?: string; module?: string; priority?: string; expected?: string; [key: string]: unknown };
export type Defect = { defect_id?: string; title?: string; category?: string; severity?: string; priority?: string; lifecycle_status?: string; related_cases?: string[]; evidence_refs?: string[]; steps_to_reproduce?: string[] | string; expected_result?: string; actual_result?: string; impact?: string; recommendation?: string; [key: string]: unknown };

const actualResultCodes: Record<string, string> = {
  visible: "可见", hidden: "隐藏", text: "文本", value: "值", count: "数量",
  readonly: "只读", editable: "可编辑", enabled: "已启用", disabled: "已禁用",
  true: "是", false: "否", unavailable: "无法获取", condition_matched: "条件已满足", condition_not_met: "条件未满足",
  observation_unavailable: "观察结果无法获取", page_unavailable: "页面不可用",
  locator_invalid: "定位条件无效", locator_ambiguous: "定位结果不唯一", timeout: "超时", blocked: "受阻",
  unsupported_control: "控件不支持此检查", error_document: "页面返回错误", readiness_required: "缺少就绪条件",
  readiness_not_unique: "就绪区域不唯一", business_region_not_ready: "业务区域尚未就绪", readiness_changed: "就绪状态已变化",
  passed: "通过", failed: "未通过", skipped: "未执行", unknown: "未知",
};
export function localizeActualResult(value: unknown): string {
  if (value == null || value === "") return "—";
  const raw = typeof value === "string" ? value : Array.isArray(value) ? value.join("、") : JSON.stringify(value, null, 2);
  const check = /^([a-z_]+): ([\s\S]*); ([a-z_]+)$/.exec(raw);
  if (check && actualResultCodes[check[1]!] && actualResultCodes[check[3]!]) {
    const observed = check[2]!;
    const display = observed === "no observation" ? "未取得观察值" : actualResultCodes[observed] ?? observed;
    return `${actualResultCodes[check[1]!]}：${display}；${actualResultCodes[check[3]!]}`;
  }
  if (actualResultCodes[raw]) return actualResultCodes[raw];
  return raw.replace(/HTTP matched=(true|false); business value matched=(true|false|not_checked)/g,
    (_, http: string, business: string) => `HTTP 状态符合预期：${actualResultCodes[http]}；业务值符合预期：${business === "not_checked" ? "未检查" : actualResultCodes[business]}`);
}

import { workspaceFileUrl } from "../../api/endpoints";

export const artifactUrl = workspaceFileUrl;
export async function loadVerifiedJson<T>(sessionId: string, artifact: ResultArtifact | undefined, signal: AbortSignal): Promise<T | null> {
  if (!artifact || !artifact.available || artifact.verified !== true) return null;
  if (artifact.size > 2 * 1024 * 1024) throw Error("结果文件较大，请在阶段产物中下载查看。");
  const response = await fetch(artifactUrl(sessionId, artifact.path), { credentials: "same-origin", signal });
  if (!response.ok) throw Error("结果文件读取失败，请刷新后重试。");
  const raw = await response.text();
  if (raw.length > 2 * 1024 * 1024) throw Error("结果文件较大，请在阶段产物中下载查看。");
  return JSON.parse(raw) as T;
}

export function executionRows(designed: DesignCase[] | null, results: ResultCase[]) {
  const linkedId = (row: ResultCase) => row.case_ref?.source_path === "design/test_cases.json" && row.case_ref.case_id ? row.case_ref.case_id : row.case_id;
  const byId = new Map<string, ResultCase[]>();
  for (const result of results) { const id = linkedId(result); if (id) byId.set(id, [...(byId.get(id) ?? []), result]); }
  const designIds = new Set((designed ?? []).map(row => row.case_id).filter((id): id is string => !!id));
  const rows = designed ? [...designed.map(row => ({ id: row.case_id ?? "", title: row.title ?? "", design: row, results: byId.get(row.case_id ?? "") ?? [], supplemental: false })), ...results.filter(row => !designIds.has(linkedId(row) ?? "")).map(row => ({ id: row.case_id ?? "", title: row.title ?? "", design: null, results: [row], supplemental: true }))] : results.map(row => ({ id: row.case_id ?? "", title: row.title ?? "", design: null, results: [row], supplemental: false }));
  const attempted = (status: string) => ["passed", "failed", "partial", "completed"].includes(status);
  const passed = rows.filter(row => row.design && row.results.length === 1 && row.results[0]!.case_id === row.id && row.results[0]!.status === "passed").length;
  const failed = rows.filter(row => row.results.some(result => result.status === "failed")).length;
  const executed = rows.filter(row => row.results.some(result => attempted(result.status ?? ""))).length;
  return { rows, metrics: { total: designed?.length ?? null, executed, passed, failed, supplemental: designed ? rows.filter(row => row.supplemental).length : null, pending: designed ? rows.filter(row => !row.results.some(result => attempted(result.status ?? "")) && !row.supplemental).length : null } };
}

export function executionSummary(results: ResultCase[]): { status: string; actual: string } {
  if (!results.length) return { status: "待执行", actual: "尚无关联执行记录" };
  const failed = results.filter(item => item.status === "failed").length;
  const passed = results.filter(item => item.status === "passed").length;
  const pending = results.length - failed - passed;
  const status = failed ? `含失败断言 · ${failed}/${results.length}` : pending ? `部分验证 · ${passed}/${results.length} 条通过` : `已验证断言 · ${passed} 条通过`;
  const actual = results.map(item => `${item.case_id ?? "断言"}：${localizeActualResult(item.actual_result ?? item.error_message ?? item.reason ?? "未记录实际结果")}`).join("\n");
  return { status, actual };
}

export function safeEvidencePath(reference: string, runId: string): string | null {
  const normalized = reference.replaceAll("\\", "/");
  const marker = `/output/runs/${runId}/`;
  const relative = normalized.includes(marker) ? normalized.slice(normalized.indexOf(marker) + 1) : normalized;
  if (!relative || relative.startsWith("/") || /^[A-Za-z]:/.test(relative) || relative.split("/").some(part => !part || part === "." || part === "..")) return null;
  if (relative.startsWith("output/runs/")) return relative.startsWith(`output/runs/${runId}/`) ? relative : null;
  return `output/runs/${runId}/${relative}`;
}
