import { afterEach, describe, expect, it, vi } from "vitest";
import { discoverLocalWorkspace, localWorkspaceUrl } from "../src/lib/local-workspace";

afterEach(() => vi.unstubAllGlobals());

describe("local Web workspace navigation", () => {
  it("preserves the actual local port and uses the user route", () => {
    expect(localWorkspaceUrl("http://localhost:59764")).toBe("http://localhost:59764/user/");
    expect(localWorkspaceUrl("http://127.0.0.1:12345/user/")).toBe("http://127.0.0.1:12345/user/");
    expect(localWorkspaceUrl("http://[::1]:12345/user")).toBe("http://[::1]:12345/user/");
  });
  it("rejects remote destinations, credentials, executable URLs and secret-bearing parameters", () => {
    for (const value of ["https://example.com", "http://localhost.evil.test:7393", "http://admin:password@localhost:7393", "http://localhost:7393/user/?token=secret", "http://localhost:7393/user/#secret", "http://localhost:7393/admin", "javascript:alert(1)", "file:///etc/passwd", "not a url"]) expect(localWorkspaceUrl(value)).toBeNull();
  });
});

describe("automatic local workspace discovery", () => {
  const origin = "https://accounts.example.test";
  const payload = (workspaceUrl = "http://localhost:12345/user/") => ({ product: "AITestHarness", version: 1, centralOrigin: origin, workspaceUrl });
  it("discovers on first visit without remembered port or credentials", async () => {
    const request = vi.fn().mockRejectedValueOnce(Error("closed")).mockResolvedValueOnce(Response.json(payload())).mockRejectedValueOnce(Error("closed"));
    vi.stubGlobal("fetch", request);
    expect(await discoverLocalWorkspace(origin, null)).toBe("http://localhost:12345/user/");
    expect(request).toHaveBeenCalledTimes(3);
    expect(request.mock.calls.every(([, options]) => options.credentials === "omit" && options.redirect === "error")).toBe(true);
  });
  it("replaces stale remembered ports and rejects unrelated or remote services", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(Response.json({ ...payload(), centralOrigin: "https://other.test" })).mockResolvedValueOnce(Response.json(payload("https://evil.test/user/"))).mockResolvedValueOnce(Response.json(payload())));
    expect(await discoverLocalWorkspace(origin, "http://localhost:9999/user/")).toBe("http://localhost:12345/user/");
  });
  it("stays waiting when services are unavailable or are not AITestHarness", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValueOnce(Error("closed")).mockResolvedValueOnce(Response.json({ ...payload(), product: "Other" })).mockResolvedValueOnce(new Response("not JSON")));
    expect(await discoverLocalWorkspace(origin, null)).toBeNull();
  });
});
