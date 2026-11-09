/**
 * The receiver seam for a project's "server copy".
 *
 * The real publishing target is integrated by Codex; development and tests use
 * `LocalSimulatedKnowledgeReceiver`, which mirrors a copy under the isolated data root and
 * returns the same receipt shape. It is a simulator, not a claim that a remote service stored
 * anything. The routes accept an injected receiver (`AgentsRouteDeps.knowledgeReceiver`) so a
 * test double can fail an upload or a delete without touching the database.
 */
import fs from "node:fs/promises";
import path from "node:path";

export interface KnowledgeCopyPayload {
  projectId: string;
  uploadId: string;
  documentId: string;
  revision: number;
  contentHash: string;
  byteSize: number;
  recipient: string;
  purpose: string;
  dataScope: string;
  attributionUserId: string;
  content: string;
}

export interface KnowledgeReceiverUploadReceipt {
  remoteRef: string;
}

export interface KnowledgeReceiverDeleteReceipt {
  remoteRef: string;
  deleted: true;
}

export interface KnowledgeReceiver {
  upload(payload: KnowledgeCopyPayload): Promise<KnowledgeReceiverUploadReceipt>;
  remove(input: { projectId: string; uploadId: string; remoteRef?: string | null }): Promise<KnowledgeReceiverDeleteReceipt>;
}

function safeSegment(value: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(value) || value === "." || value === "..") {
    throw new Error("Unsafe receiver path segment");
  }
  return value;
}

export class LocalSimulatedKnowledgeReceiver implements KnowledgeReceiver {
  constructor(private readonly root: string) {}

  private directory(projectId: string, uploadId: string): string {
    const dir = path.join(this.root, "qa-knowledge-receiver", safeSegment(projectId), safeSegment(uploadId));
    if (!dir.startsWith(path.resolve(this.root, "qa-knowledge-receiver") + path.sep)) {
      throw new Error("Receiver path escapes its root");
    }
    return dir;
  }

  async upload(payload: KnowledgeCopyPayload): Promise<KnowledgeReceiverUploadReceipt> {
    const dir = this.directory(payload.projectId, payload.uploadId);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "content.txt"), payload.content, "utf8");
    const receipt = {
      schemaVersion: 1,
      simulated: true,
      projectId: payload.projectId,
      uploadId: payload.uploadId,
      documentId: payload.documentId,
      revision: payload.revision,
      contentHash: payload.contentHash,
      byteSize: payload.byteSize,
      recipient: payload.recipient,
      purpose: payload.purpose,
      dataScope: payload.dataScope,
      attributionUserId: payload.attributionUserId,
      storedAt: new Date().toISOString()
    };
    await fs.writeFile(path.join(dir, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
    return { remoteRef: `local-sim://${payload.projectId}/${payload.uploadId}` };
  }

  async remove(input: { projectId: string; uploadId: string }): Promise<KnowledgeReceiverDeleteReceipt> {
    const dir = this.directory(input.projectId, input.uploadId);
    await fs.rm(dir, { recursive: true, force: true });
    return { remoteRef: `local-sim://${input.projectId}/${input.uploadId}`, deleted: true };
  }
}
