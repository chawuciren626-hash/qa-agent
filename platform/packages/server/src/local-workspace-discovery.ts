import { createServer, type Server } from "node:http";

// Product discovery ports, independent of the upstream workbench's dynamic port.
// The Web client uses the same bounded list; never scan arbitrary ports.
export const WORKSPACE_DISCOVERY_PORTS = [18767, 18768, 18769] as const;
export const WORKSPACE_DISCOVERY_PATH = "/.well-known/aitest-workspace";

/** Only the configured central Web origin may discover us. No credentials or business APIs. */
export async function startWorkspaceDiscovery(options: {
  workspacePort: number;
  centralOrigin: string;
  ports?: readonly number[];
}): Promise<Server | null> {
  const centralOrigin = new URL(options.centralOrigin).origin;
  const workspaceUrl = `http://localhost:${options.workspacePort}/user/`;
  for (const port of options.ports ?? WORKSPACE_DISCOVERY_PORTS) {
    const server = createServer((req, res) => {
      const address = server.address();
      const boundPort = address && typeof address !== "string" ? address.port : port;
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Vary", "Origin");
      if (req.headers.host !== `127.0.0.1:${boundPort}` || req.headers.origin !== centralOrigin) {
        res.writeHead(403).end(); return;
      }
      res.setHeader("Access-Control-Allow-Origin", centralOrigin);
      if (req.url !== WORKSPACE_DISCOVERY_PATH) { res.writeHead(404).end(); return; }
      if (req.method === "OPTIONS") {
        if (req.headers["access-control-request-method"] !== "GET") { res.writeHead(405).end(); return; }
        res.setHeader("Access-Control-Allow-Methods", "GET");
        res.setHeader("Access-Control-Allow-Private-Network", "true");
        res.writeHead(204).end(); return;
      }
      if (req.method !== "GET") { res.writeHead(405).end(); return; }
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ product: "AITestHarness", version: 1, centralOrigin, workspaceUrl }));
    });
    const listening = await new Promise<boolean>((resolve, reject) => {
      server.once("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "EADDRINUSE" || error.code === "EACCES") resolve(false);
        else reject(error);
      });
      server.listen(port, "127.0.0.1", () => resolve(true));
    });
    if (listening) { server.unref(); return server; }
  }
  return null;
}
