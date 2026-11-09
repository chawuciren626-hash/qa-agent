/** Live service authorization for an explicitly bound local schedule. */
import { randomUUID } from "node:crypto";
import { Component, Use } from "@prismshadow/penguin-core/kernel";
import type { AuthState, Config } from "../../hmr/capabilities.js";
import { localDeviceId } from "./device-identity.js";
import type {
  AuthorizationDecision,
  UnattendedConstraints,
  UnattendedIdentity,
  UnattendedResource,
} from "./types.js";
import { UnattendedAuthorizer } from "./types.js";

@Component()
export class GrantCheckingAuthorizer implements UnattendedAuthorizer {
  @Use() private readonly authState!: AuthState;
  @Use() private readonly config!: Config;
  async authorizeInvocation(
    identity: UnattendedIdentity,
    resource: UnattendedResource,
    constraints: UnattendedConstraints,
  ): Promise<AuthorizationDecision> {
    const denied = (reasonCode: string): AuthorizationDecision => ({
      allowed: false,
      outcome: "deny",
      reasonCode,
      decisionId: `dec-${randomUUID()}`,
      policyRevision: "unavailable",
      checkedAt: new Date().toISOString(),
      expiresAt: null,
    });
    if (identity.deviceId !== localDeviceId(this.config.root)) return denied("device_mismatch");
    if (constraints.operation !== "schedule.dispatch" || identity.projectId !== resource.projectId || identity.agentId !== resource.agentId) return denied("operation_not_allowed");
    const bridge = this.authState.accountClient;
    if (!bridge) return denied("authorizer_missing");
    try {
      await bridge.validateUser(identity.userId);
      await bridge.authorizeUserPath(identity.userId, `/api/projects/${encodeURIComponent(identity.projectId)}/agents/${encodeURIComponent(identity.agentId)}/schedules`, "POST");
      const decision = await bridge.authorizeInvocation(identity, {kind:"project",id:identity.projectId}, "read", {requireFresh:true});
      return { allowed:decision.allowed, outcome:decision.allowed ? "allow" : "deny", reasonCode:decision.reasonCode,
        decisionId:decision.decisionId, policyRevision:decision.policyRevision,
        checkedAt:new Date(decision.checkedAt).toISOString(), expiresAt:new Date(decision.expiresAt).toISOString() };
    } catch { return denied("policy_unavailable"); }
  }
}
