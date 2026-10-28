import fs from "node:fs/promises";
import path from "node:path";

// The index is read-only: no generated progress, no inference from conversation text.
export async function readTaskRuns(workspace: string, sessionId: string) {
  const runs: { id: string; status: string; stages: { id: string; status: string }[];
    artifacts: { path: string; category: string }[] }[] = [];
  let unavailable = 0;
  let truncated = false;
  if (!workspace) return { runs, unavailable, truncated };
  let root: string;
  try {
    if ((await fs.lstat(workspace)).isSymbolicLink()) throw Error("Linked workspace");
    // Windows temp/user paths may use an 8.3 alias; canonicalize the trusted session root once.
    root = await fs.realpath(path.resolve(workspace));
  } catch (error) {
    return { runs, unavailable: (error as NodeJS.ErrnoException).code === "ENOENT" ? 0 : 1, truncated };
  }
  const safe = async (rel: string) => {
    const parts = rel.split("/");
    if (parts.some(p => !p || p === "." || p === ".." || /[\\:\x00-\x1f]/.test(p))) throw Error("Invalid path");
    let current = root;
    if (await fs.realpath(current) !== current) throw Error("Linked workspace");
    for (const part of parts) {
      current = path.join(current, part);
      if ((await fs.lstat(current)).isSymbolicLink() || await fs.realpath(current) !== current) throw Error("Linked artifact");
    }
    return current;
  };
  try {
    const directory = await safe("output/runs");
    const entries = (await fs.readdir(directory, { withFileTypes: true }))
      .filter(e => e.isDirectory() && /^run-[A-Za-z0-9-]+$/.test(e.name)).sort((a,b) => b.name.localeCompare(a.name));
    truncated = entries.length > 100;
    for (const entry of entries.slice(0, 100)) {
      try {
        const prefix = `output/runs/${entry.name}`;
        const file = await safe(`${prefix}/manifest.json`);
        if ((await fs.stat(file)).size > 2 * 1024 * 1024) throw Error("Large manifest");
        const manifest = JSON.parse(await fs.readFile(file, "utf8"));
        // Shared workspaces may contain runs belonging to other tasks/projects.
        const owner = manifest.directory_context?.session_id;
        const owners = new Set((manifest.orchestration?.events ?? []).map((e: any) => e["parent-session-id"] ?? e.evidence?.parent_session_id).filter(Boolean));
        if (owner ? owner !== sessionId : owners.size !== 1 || !owners.has(sessionId)) continue;
        const artifacts: { path: string; category: string }[] = [];
        for (const rel of (Array.isArray(manifest.artifacts) ? manifest.artifacts : []).slice(0, 300)) {
          if (typeof rel !== "string") continue;
          const category = /^design\/.*\.xlsx$/i.test(rel) ? "cases" : /^defects\//.test(rel) ? "defects" : /^report\/.*\.html$/i.test(rel) ? "reports" : null;
          if (!category) continue;
          try { if ((await fs.stat(await safe(`${prefix}/${rel}`))).isFile()) artifacts.push({ path: `${prefix}/${rel}`, category }); }
          catch { unavailable++; }
        }
        runs.push({ id: entry.name, status: typeof manifest.status === "string" ? manifest.status : "unknown",
          stages: Object.entries(manifest.stages ?? {}).map(([id, stage]) => ({ id, status: typeof (stage as any)?.status === "string" ? (stage as any).status : "unknown" })), artifacts });
      } catch { unavailable++; }
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") unavailable++; }
  return { runs, unavailable, truncated };
}
