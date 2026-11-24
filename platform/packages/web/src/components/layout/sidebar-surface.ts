/**
 * Which sidebar the user surface renders.
 *
 * AITestHarness' QA routes always use the product sidebar. The upstream generic
 * sidebar is only a fallback for upstream application routes where no QA identity
 * has loaded yet. This distinction must not depend solely on an Agent fetch: a
 * new user with no Project, or a transient Agent-list failure, otherwise turns
 * the same `/qa/*` screen into a different application shell.
 */
export function usesQaSidebar(input: {
  inCompany: boolean;
  accountClient: boolean;
  hasTestAgent: boolean;
  pathname: string;
}): boolean {
  if (input.inCompany) return false;
  return (
    input.accountClient ||
    input.hasTestAgent ||
    input.pathname === "/qa" ||
    input.pathname.startsWith("/qa/")
  );
}
