import { afterEach, describe, expect, it } from "vitest";
import { request, type Server } from "node:http";
import { startWorkspaceDiscovery, WORKSPACE_DISCOVERY_PATH } from "../src/local-workspace-discovery.js";

const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }))); });
async function start(ports = [0]) {
  const server = await startWorkspaceDiscovery({ workspacePort: 59764, centralOrigin: "https://accounts.example.test", ports });
  expect(server).not.toBeNull();
  servers.push(server!);
  const address = server!.address();
  if (!address || typeof address === "string") throw Error("No discovery listener");
  expect(address.address).toBe("127.0.0.1");
  return { port: address.port, url: `http://127.0.0.1:${address.port}${WORKSPACE_DISCOVERY_PATH}` };
}

describe("local workspace discovery", () => {
  it("returns only the current local address to the configured central origin", async () => {
    const { url } = await start();
    const response = await fetch(url, { headers: { Origin: "https://accounts.example.test" } });
    expect(response.headers.get("access-control-allow-origin")).toBe("https://accounts.example.test");
    expect(response.headers.get("access-control-allow-credentials")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ product: "AITestHarness", version: 1, centralOrigin: "https://accounts.example.test", workspaceUrl: "http://localhost:59764/user/" });
  });
  it("denies unrelated sites, missing origins and rebinding hosts", async () => {
    const { url } = await start();
    for (const headers of [{}, { Origin: "https://unrelated.test" }]) {
      const response = await fetch(url, { headers });
      expect(response.status).toBe(403);
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
    }
    // Node fetch rewrites Host; use a raw HTTP request to exercise rebinding.
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(url, { headers: { Origin: "https://accounts.example.test", Host: "evil.test" } }, response => { response.resume(); resolve(response.statusCode); });
      req.on("error", reject); req.end();
    });
    expect(status).toBe(403);
  });
  it("supports private-network GET preflight without exposing other routes or mutations", async () => {
    const { url } = await start();
    const headers = { Origin: "https://accounts.example.test" };
    const preflight = await fetch(url, { method: "OPTIONS", headers: { ...headers, "Access-Control-Request-Method": "GET", "Access-Control-Request-Private-Network": "true" } });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-private-network")).toBe("true");
    expect((await fetch(url, { method: "POST", headers })).status).toBe(405);
    expect((await fetch(new URL("/api/me", url), { headers })).status).toBe(404);
  });
  it("falls back when a discovery port is occupied", async () => {
    const first = await start();
    const second = await start([first.port, 0]);
    expect(second.port).not.toBe(first.port);
    expect(await startWorkspaceDiscovery({ workspacePort: 12345, centralOrigin: "https://accounts.example.test", ports: [first.port] })).toBeNull();
  });
});
