import fs from "node:fs/promises";
import path from "node:path";
import { fork } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { session } from "electron";
import { isRemoteExecutionRequest, remoteSessionPartition } from "./remote-client.js";

/** Main-process owned credentials. The renderer receives neither a preload API nor execution secrets. */
export async function startRemoteExecution(options: {
  origin: string; profile: string; paths: { node: string; python?: string; engine: string; workspaces: string; host_data: string };
  env: NodeJS.ProcessEnv; worker: string; log: (line: string) => void;
}): Promise<{ close(): void }> {
  const browserSession = session.fromPartition(remoteSessionPartition(options.origin));
  const file = path.join(options.profile, "execution-clients.json");
  const identities: Record<string, { clientId: string; proof: string }> = await fs.readFile(file, "utf8").then(JSON.parse, () => ({}));
  let child: ChildProcess | null = null;
  let identity: { clientId: string; proof: string } | null = null;
  let cookie = "", stopped = false, refreshing = false, ready = false;
  const stopChild = () => { ready = false; child?.send({ type: "stop" }); child = null; };
  browserSession.webRequest.onBeforeSendHeaders({ urls: ["<all_urls>"] }, (details, callback) => {
    const headers = details.requestHeaders;
    for (const key of Object.keys(headers)) if (/^x-aitest-execution-(?:client|proof)$/i.test(key)) delete headers[key];
    if (isRemoteExecutionRequest(details.url, options.origin)) {
      // Always mark the desktop, including the not-ready state, so it cannot accidentally run in the VM.
      headers["x-aitest-execution-client"] = identity?.clientId ?? "desktop-not-ready";
      if (ready && identity) headers["x-aitest-execution-proof"] = identity.proof;
    }
    callback({ requestHeaders: headers });
  });
  async function refresh(): Promise<void> {
    if (stopped || refreshing) return;
    refreshing = true;
    try {
      const cookies = await browserSession.cookies.get({ url: options.origin });
      const nextCookie = cookies.filter(value => /^penguin_session(?:_\d+)?$/.test(value.name)).map(value => `${value.name}=${value.value}`).join("; ");
      if (!nextCookie) { stopChild(); identity = null; cookie = ""; return; }
      if (nextCookie === cookie && child) return;
      stopChild();
      const response = await browserSession.fetch(`${options.origin}/api/me`);
      if (!response.ok) { identity = null; cookie = ""; return; }
      const data = await response.json() as any;
      if (stopped) return;
      const userId = data.user?.userId ?? data.userId;
      if (typeof userId !== "string" || !userId) throw new Error("执行端无法识别当前登录用户");
      const key = createHash("sha256").update(`${options.origin}\0${userId}`).digest("hex");
      identity = identities[key] ??= { clientId: randomUUID(), proof: randomBytes(32).toString("hex") };
      await fs.mkdir(options.profile, { recursive: true });
      await fs.writeFile(file, JSON.stringify(identities), { mode: 0o600 });
      cookie = nextCookie;
      const root = path.join(options.paths.host_data, "execution-cache", key);
      const worker = fork(options.worker, [], {
        execPath: options.paths.node, execArgv: [], stdio: ["ignore", "pipe", "pipe", "ipc"],
        env: { ...options.env, PENGUIN_HOME: root, PENGUIN_API_TOKEN: "", AITEST_SHARED_AGENT_RUNTIME: "0",
          AITEST_ENGINE_ROOT: options.paths.engine, AITEST_STAGE_TOOL_EXECUTION: "local", AITEST_BROWSER_EXECUTION: "local" },
      });
      child = worker;
      worker.stdout?.on("data", line => options.log(`[executor] ${String(line).trim().slice(0, 1000)}`));
      worker.stderr?.on("data", line => options.log(`[executor] ${String(line).trim().slice(0, 1000)}`));
      worker.on("message", (message: any) => {
        if (child !== worker) return;
        if (message.type === "execution-ready") ready = true;
        else if (message.type === "execution-offline" || message.type === "execution-fatal") ready = false;
        options.log(`[executor] ${message.type}${message.message ? ": " + message.message : ""}`);
      });
      worker.on("exit", code => { if (child === worker) { child = null; ready = false; } options.log(`[executor] stopped (${code})`); });
      worker.send({ type: "start", config: { origin: options.origin, cookie, ...identity, root,
        engine: options.paths.engine, workspaces: options.paths.workspaces, python: options.paths.python ?? "unconfigured", userId } });
    } catch (error) { options.log(`[executor] connection failed: ${String(error)}`); }
    finally { refreshing = false; }
  }
  const changed = () => { void refresh(); };
  browserSession.cookies.on("changed", changed);
  const timer = setInterval(changed, 3000);
  await refresh();
  return { close() { stopped = true; clearInterval(timer); browserSession.cookies.removeListener("changed", changed); stopChild(); } };
}
