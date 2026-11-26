/** Keep the product draft visible while its Project and Agent inventory load. */
export function usesQaDraft(input: {
  pathname: string;
  fixedAgentId?: string;
  accountClient: boolean;
  hasTestAgent: boolean;
}): boolean {
  if (input.fixedAgentId) return false;
  return input.pathname === "/chat/new" ||
    input.pathname.startsWith("/chat/draft-") ||
    input.accountClient || input.hasTestAgent;
}
