/**
 * The default UnattendedAuthorizer —the replaceable POLICY decision point.
 *
 * Division of labor (who knows what):
 * - The COORDINATOR owns the binding row, so it checks the facts the binding records:
 *   grant expiry, the permission ceiling's operation list, the deadline. Those checks run
 *   BEFORE this interface is consulted and cannot be bypassed by any authorizer.
 * - The AUTHORIZER is the live-policy decision: whether the grant still stands NOW. The
 *   default below can only affirm the local grant record —it CANNOT see a server-side
 *   revocation, and it does not pretend otherwise. Live revocation arrives when the real
 *   identity/authorization module replaces this binding in platform.ts (integration
 *   notes, contract-proposal.md); the interface is the contract, not this class.
 *
 * Missing interface = refuse: the coordinator fails closed on `authorizer_missing` when
 * nothing implements this interface, so a production tree without an authorizer never
 * sends an unattended fire.
 */
import { randomUUID } from "node:crypto";
import { Component } from "@prismshadow/penguin-core/kernel";
import type {
  AuthorizationDecision,
  UnattendedConstraints,
  UnattendedIdentity,
  UnattendedResource,
} from "./types.js";
import { UnattendedAuthorizer } from "./types.js";

@Component()
export class GrantCheckingAuthorizer implements UnattendedAuthorizer {
  async authorizeInvocation(
    identity: UnattendedIdentity,
    resource: UnattendedResource,
    constraints: UnattendedConstraints,
  ): Promise<AuthorizationDecision> {
    void resource;
    void constraints;
    return {
      allowed: true,
      outcome: "allow",
      reasonCode: "granted",
      decisionId: `dec-${randomUUID()}`,
      policyRevision: `local-grant-v1:${identity.userId}`,
      checkedAt: new Date().toISOString(),
      expiresAt: null,
    };
  }
}
