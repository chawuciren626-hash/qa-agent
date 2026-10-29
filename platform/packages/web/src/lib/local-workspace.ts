/** Only navigate to a workspace on this computer; never forward credentials or task data. */
export function localWorkspaceUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) return null;
    if (url.username || url.password || url.search || url.hash || !["/", "/user", "/user/"].includes(url.pathname)) return null;
    return new URL("/user/", url.origin).href;
  } catch { return null; }
}

const storageKey = "aitest.web.localWorkspace";
export function rememberedWorkspace(): string | null {
  try { return localWorkspaceUrl(localStorage.getItem(storageKey)) ?? localWorkspaceUrl(sessionStorage.getItem("aitest.admin.returnTo")); }
  catch { return null; }
}
export function rememberWorkspace(value: string): string | null {
  const url = localWorkspaceUrl(value);
  if (url) { try { localStorage.setItem(storageKey, url); } catch { /* Navigation still works without storage. */ } }
  return url;
}

/** Resolve the current dynamic port on first visit as well as after a client restart. */
export async function discoverLocalWorkspace(centralOrigin: string, preferred: string | null, signal?: AbortSignal): Promise<string | null> {
  const results = await Promise.all([18767, 18768, 18769].map(async port => {
    try {
      const timeout = AbortSignal.timeout(1800);
      const response = await fetch(`http://127.0.0.1:${port}/.well-known/aitest-workspace`, {
        credentials: "omit", cache: "no-store", redirect: "error",
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      if (!response.ok) return null;
      const data = await response.json();
      if (data.product !== "AITestHarness" || data.version !== 1 || data.centralOrigin !== centralOrigin) return null;
      const url = localWorkspaceUrl(data.workspaceUrl);
      return url && new URL(url).origin !== centralOrigin ? url : null;
    } catch { return null; }
  }));
  const valid = results.filter((url): url is string => url !== null);
  return valid.find(url => url === preferred) ?? valid[0] ?? null;
}
