import { createHash } from "node:crypto";

/** Cookies are origin-specific: localhost services on different ports share cookies. */
export function remoteSessionPartition(origin: string): string {
  return `persist:aitest-remote-${createHash("sha256").update(origin).digest("hex").slice(0, 24)}`;
}

/** WebSocket upgrades have ws(s) origins although they belong to the same HTTP service. */
export function isRemoteExecutionRequest(url: string, origin: string): boolean {
  const target = new URL(url);
  if (target.protocol === "ws:") target.protocol = "http:";
  else if (target.protocol === "wss:") target.protocol = "https:";
  return target.origin === origin && target.pathname.startsWith("/api/");
}
