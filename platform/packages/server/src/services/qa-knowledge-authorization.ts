/**
 * The one authorization seam for project knowledge reads and uploads.
 *
 * The shared contract (CONTRACTS.md §1/§3) expects `authorizeInvocation(identity,
 * resource, operation, constraints)`. The platform has no tenant entity yet, so
 * `tenantId` stays undefined instead of a fake constant; `projectId` is the
 * existing ownership boundary and the adapter below resolves it from the
 * authenticated request plus the project access table. There is deliberately no
 * "allow everything" implementation in production: an injected authorizer
 * replaces this adapter only in tests or when the connector surface lands.
 */
import { randomUUID } from "node:crypto";
import type { Access } from "../mechanisms/projects.js";
import { HttpError } from "../http/errors.js";

export const KNOWLEDGE_POLICY_REVISION = "project-knowledge-v1";

export type KnowledgeOperation = "read" | "search" | "upload" | "write" | "delete" | "review";
export type KnowledgeResourceType =
  | "document"
  | "rule"
  | "candidate"
  | "task_context"
  | "upload"
  | "knowledge_index";

export interface KnowledgeIdentity {
  /** Unset until the deployment has a tenant entity; never a placeholder constant. */
  tenantId?: string;
  userId: string;
  /** Reserved for the connector contract; the HTTP server authenticates a session, not a device. */
  deviceId?: string;
  projectId: string;
  agentId?: string;
  sessionId?: string;
  taskId?: string;
}

export interface KnowledgeResource {
  type: KnowledgeResourceType;
  projectId: string;
  id?: string;
}

/** Facts an upload confirmation binds: a changed hash must trigger a new preview. */
export interface KnowledgeConstraints {
  contentHash?: string;
  byteSize?: number;
  recipient?: string;
  dataScope?: string;
}

export interface KnowledgeAuthorizationDecision {
  allowed: boolean;
  reasonCode: string;
  decisionId: string;
  policyRevision: string;
  checkedAt: string;
  expiresAt: string;
  constraints: KnowledgeConstraints;
}

export interface KnowledgeAuthorizer {
  authorizeInvocation(
    identity: KnowledgeIdentity,
    resource: KnowledgeResource,
    operation: KnowledgeOperation,
    constraints?: KnowledgeConstraints,
  ): KnowledgeAuthorizationDecision;
}

const READ_OPERATIONS: ReadonlySet<KnowledgeOperation> = new Set(["read", "search"]);

/** Adapter over the existing Project owner/member table; writes stay owner-only. */
export function createProjectAccessAuthorizer(access: Access): KnowledgeAuthorizer {
  return {
    authorizeInvocation(identity, resource, operation, constraints = {}) {
      const now = new Date();
      const decision = (
        allowed: boolean,
        reasonCode: string,
      ): KnowledgeAuthorizationDecision => ({
        allowed,
        reasonCode,
        decisionId: `authz-${randomUUID()}`,
        policyRevision: KNOWLEDGE_POLICY_REVISION,
        checkedAt: now.toISOString(),
        // A decision is a point-in-time check; callers re-authorize on every invocation.
        expiresAt: new Date(now.getTime() + 60_000).toISOString(),
        constraints,
      });
      if (!identity.userId || identity.projectId !== resource.projectId) {
        return decision(false, "identity_mismatch");
      }
      let row: { role: string; ownerUserId: string };
      try {
        row = access.requireProjectAccess(identity.userId, identity.projectId);
      } catch {
        return decision(false, "project_not_found");
      }
      if (READ_OPERATIONS.has(operation)) return decision(true, "project_member");
      if (row.role !== "owner" || row.ownerUserId !== identity.userId) {
        return decision(false, "project_owner_required");
      }
      return decision(true, "project_owner");
    },
  };
}

/** Converts a denial into the route's existing error vocabulary; unknown reasons fail closed. */
export function requireKnowledgeDecision(decision: KnowledgeAuthorizationDecision): KnowledgeAuthorizationDecision {
  if (decision.allowed) return decision;
  if (decision.reasonCode === "project_not_found") {
    throw new HttpError(404, "project_not_found", "Project does not exist or you do not have access.");
  }
  if (decision.reasonCode === "project_owner_required") {
    throw new HttpError(403, "project_owner_required", "仅项目所有者可以执行该资料操作。");
  }
  throw new HttpError(403, "knowledge_forbidden", "当前身份无权执行该资料操作。");
}

export function knowledgeIdentity(input: {
  userId: string;
  projectId: string;
  agentId?: string;
  sessionId?: string;
  taskId?: string;
}): KnowledgeIdentity {
  return {
    userId: input.userId,
    projectId: input.projectId,
    ...(input.agentId ? { agentId: input.agentId } : {}),
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.taskId ? { taskId: input.taskId } : {})
  };
}
