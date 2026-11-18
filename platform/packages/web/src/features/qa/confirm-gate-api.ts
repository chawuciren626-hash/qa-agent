/** 确认卡点页的接口适配层：页面只 import 这里，不直接拼 URL。 */
import { apiFetch } from "../../api/client";
import type { ConfirmBatch, ConfirmBatchView, ItemFilter } from "./confirm-gate-model";

const batchesOf = (projectId: string) =>
  `/api/projects/${encodeURIComponent(projectId)}/agents/qa/confirm/batches`;
const batchOf = (projectId: string, batchId: string) =>
  `${batchesOf(projectId)}/${encodeURIComponent(batchId)}`;

export async function listBatches(projectId: string): Promise<ConfirmBatch[]> {
  return (await apiFetch<{ batches: ConfirmBatch[] }>(batchesOf(projectId))).batches;
}

export async function getBatch(projectId: string, batchId: string): Promise<ConfirmBatchView> {
  return apiFetch<ConfirmBatchView>(batchOf(projectId, batchId));
}

export async function createBatch(
  projectId: string,
  input: { title: string; seed?: string; items: { id: string; type: string; text: string; risk: string; changed: boolean }[] },
): Promise<ConfirmBatch> {
  return apiFetch<ConfirmBatch>(batchesOf(projectId), { method: "POST", body: input });
}

export async function resampleBatch(projectId: string, batchId: string, seed: string): Promise<ConfirmBatchView> {
  return apiFetch<ConfirmBatchView>(`${batchOf(projectId, batchId)}/sample`, { method: "POST", body: { seed } });
}

export async function reviewItem(
  projectId: string,
  batchId: string,
  itemId: string,
  decision: "pass" | "problem",
): Promise<ConfirmBatchView> {
  return apiFetch<ConfirmBatchView>(`${batchOf(projectId, batchId)}/items/${encodeURIComponent(itemId)}/review`, {
    method: "POST",
    body: { decision },
  });
}

export async function submitBatch(projectId: string, batchId: string): Promise<ConfirmBatchView> {
  return apiFetch<ConfirmBatchView>(`${batchOf(projectId, batchId)}/submit`, { method: "POST", body: {} });
}

export async function approveBatch(
  projectId: string,
  batchId: string,
  executionEvidence: unknown,
  note?: string,
): Promise<ConfirmBatchView> {
  return apiFetch<ConfirmBatchView>(`${batchOf(projectId, batchId)}/approve`, {
    method: "POST",
    body: { executionEvidence, ...(note ? { note } : {}) },
  });
}

export async function rejectBatch(projectId: string, batchId: string, reason: string): Promise<ConfirmBatchView> {
  return apiFetch<ConfirmBatchView>(`${batchOf(projectId, batchId)}/reject`, { method: "POST", body: { reason } });
}

export type { ItemFilter };
