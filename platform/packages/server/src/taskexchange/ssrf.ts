/**
 * Callback-target safety (SSRF) for the task exchange: a platform-configured callback URL
 * is fetched BY THIS SERVER, so it is an SSRF vector by construction. The guard:
 *
 * - Scheme must be http or https.
 * - IP literals are classified directly: loopback, RFC1918 private, link-local (169.254/fe80),
 *   unique-local (fc00::/7), and the metadata range (169.254.169.254 included by link-local)
 *   are PRIVATE.
 * - Hostnames: localhost, *.local, *.internal and *.lan are treated as private. A plain
 *   hostname passes validation WITHOUT resolution — name-based only (documented limit: a
 *   DNS-rebinding defense needs a custom undici agent that pins the resolved IP; listed in
 *   contract-proposal.md as the follow-up, with per-hop re-validation already in place).
 * - A private target is refused with `blocked_callback_target` UNLESS an administrator has
 *   registered the host in exchange_allowed_hosts — the explicit intranet-platform approval
 *   (an intranet deployment declares itself; nothing is open by default).
 * - Redirects are followed MANUALLY, one hop at a time, re-validated with the same rules
 *   (see OutboxDispatcher), so a public URL cannot redirect into the intranet.
 */

const PRIVATE_HOSTNAMES = new Set(["localhost"]);

export function isPrivateHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (PRIVATE_HOSTNAMES.has(host)) return true;
  if (host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".lan")) {
    return true;
  }
  // IPv6 literal (strip brackets) or IPv4 literal: classify by range.
  const literal = host.replace(/^\[|\]$/g, "");
  if (/^[\d.]+$/.test(literal)) {
    const parts = literal.split(".").map((p) => Number(p));
    if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) return true; // not a valid v4 → treat as private (never fetch something unclassifiable)
    const [a, b] = parts as [number, number, number, number];
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true; // link-local, incl. the cloud metadata address
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT range
    return false;
  }
  if (literal.includes(":")) {
    const v6 = literal.toLowerCase();
    if (v6 === "::1" || v6 === "::") return true;
    if (v6.startsWith("fe80") || v6.startsWith("fc") || v6.startsWith("fd")) return true;
    if (v6.startsWith("::ffff:")) {
      // v4-mapped: classify the embedded v4.
      return isPrivateHostname(v6.slice("::ffff:".length));
    }
    return false;
  }
  return false;
}

export interface CallbackGuard {
  allowedHosts: ReadonlySet<string>;
}

export type CallbackVerdict =
  | { ok: true; url: URL }
  | { ok: false; reason: "invalid_callback_url" | "blocked_callback_target"; detail?: string };

/** Validate a callback URL against the safety rules and the admin allowlist. */
export function checkCallbackUrl(raw: string, guard: CallbackGuard): CallbackVerdict {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "invalid_callback_url", detail: "not a URL" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: "invalid_callback_url", detail: `scheme ${url.protocol} is not http(s)` };
  }
  const hostname = url.hostname.toLowerCase();
  if (!isPrivateHostname(hostname)) return { ok: true, url };
  if (guard.allowedHosts.has(hostname)) return { ok: true, url };
  return {
    ok: false,
    reason: "blocked_callback_target",
    detail: `${hostname} is a private address; an administrator must allowlist it for an intranet deployment`,
  };
}
