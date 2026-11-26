import { describe, expect, it } from "vitest";
import { isRemoteExecutionRequest, remoteSessionPartition } from "../src/remote-client.js";

describe("remote business client session", () => {
  it("marks HTTP and WebSocket calls to the same service, including upgrades before readiness", () => {
    for (const url of ["http://localhost:18777/api/projects", "ws://localhost:18777/api/socket"])
      expect(isRemoteExecutionRequest(url, "http://localhost:18777")).toBe(true);
    expect(isRemoteExecutionRequest("wss://qa.example/api/socket", "https://qa.example")).toBe(true);
    for (const url of ["ws://localhost:59764/api/socket", "ws://other.example/api/socket", "http://localhost:18777/user", "wss://localhost:18777/api/socket"])
      expect(isRemoteExecutionRequest(url, "http://localhost:18777")).toBe(false);
  });
  it("isolates the unified service from old local cookies even when both are on localhost", () => {
    const remote = remoteSessionPartition("http://localhost:18777");
    expect(remote).toMatch(/^persist:aitest-remote-[0-9a-f]{24}$/);
    expect(remote).toBe(remoteSessionPartition("http://localhost:18777"));
    expect(remote).not.toBe(remoteSessionPartition("http://localhost:59764"));
    expect(remote).not.toBe(remoteSessionPartition("https://other.example.com"));
  });
});
