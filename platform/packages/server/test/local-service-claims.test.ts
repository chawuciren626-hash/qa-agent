import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopService } from "../src/services/desktop-service.js";
import { shellPortOf } from "../src/services/desktop-update-port.js";
import { EventEmitter } from "node:events";

afterEach(() => vi.useRealTimers());
describe("independent local service shell claims", () => {
  it("mints a new one-shot claim for every desktop launch without granting the stop credential", () => {
    const service = new DesktopService("supervisor-only");
    for (let launch = 0; launch < 3; launch++) {
      const token = service.mintLaunchClaim();
      expect(service.verifyToken(token)).toBe(false);
      expect(service.redeemLoginToken(token)).toBe(true);
      expect(service.redeemLoginToken(token)).toBe(false);
    }
  });
  it("expires claims and invalidates a superseded launch", () => {
    vi.useFakeTimers();
    const service = new DesktopService("supervisor-only");
    const old = service.mintLaunchClaim(), fresh = service.mintLaunchClaim();
    expect(service.redeemLoginToken(old)).toBe(false);
    vi.advanceTimersByTime(30_001);
    expect(service.redeemLoginToken(fresh)).toBe(false);
  });
  it("only forwards shell frames over explicitly managed IPC, not lifecycle commands", () => {
    const proc = Object.assign(new EventEmitter(), { env: { AITEST_LOCAL_SERVICE: "1" }, connected: true, send: vi.fn() });
    const port = shellPortOf(proc as unknown as NodeJS.Process)!;
    const receive = vi.fn(); port.on("message", receive);
    proc.emit("message", { type: "aitest-service-request", method: "shutdown" });
    expect(receive).not.toHaveBeenCalled();
    proc.emit("message", { type: "aitest-shell-frame", data: { type: "desktop-tray-status" } });
    expect(receive).toHaveBeenCalledWith({ data: { type: "desktop-tray-status" } });
    port.postMessage({ type: "desktop-updater-command" });
    expect(proc.send).toHaveBeenCalledWith({ type: "aitest-shell-frame", data: { type: "desktop-updater-command" } });
    port.off?.("message", receive);
    proc.emit("message", { type: "aitest-shell-frame", data: { type: "desktop-tray-status" } });
    expect(receive).toHaveBeenCalledTimes(1);
  });
});
