/**
 * Exchange credentials: bearer tokens for external platforms and for the user's local
 * executors (devices). Tokens are random, shown ONCE at registration, and stored only as
 * sha256. The middleware authenticates both kinds into `c.var.exchange` — a request is
 * either a platform call or a device call, never both, and never anonymous.
 *
 * Device tokens act for the device's owning user but carry NO web-session rights: they
 * authenticate ONLY inside /api/exchange/v1, which never reads personal data — just the
 * task rows the platform delivered for this tenant+platform binding.
 */
import { createHash, randomBytes } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import { HttpError } from "../http/errors.js";
import type { TaskExchangeStore } from "../mechanisms/taskexchange.js";
import type { ExchangeDeviceRow, ExchangePlatformRow } from "./types.js";

/** The authenticated caller of an exchange request. */
export type ExchangeCaller =
  | { kind: "platform"; tenantId: string; platformId: string }
  | { kind: "device"; tenantId: string; platformId: string; deviceId: string; userId: string; device: ExchangeDeviceRow };

declare module "hono" {
  interface ContextVariableMap {
    exchange?: ExchangeCaller;
  }
}

export function sha256Hex(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Mint a token with a kind prefix (so a leaked token's origin is readable in logs). */
export function mintToken(kind: "plat" | "dev"): { token: string; tokenHash: string } {
  const token = `dhx_${kind}_${randomBytes(24).toString("base64url")}`;
  return { token, tokenHash: sha256Hex(token) };
}

export function bearerOf(header: string | undefined): string | null {
  if (header === undefined) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m === null ? null : m[1]!.trim();
}

/** The exchange-token middleware: platform or device, never anonymous, never both. */
export function exchangeTokenAuth(store: TaskExchangeStore): MiddlewareHandler {
  return async (c, next) => {
    const token = bearerOf(c.req.header("authorization"));
    if (token === null) {
      throw new HttpError(401, "unauthorized", "An exchange bearer token is required.");
    }
    const tokenHash = sha256Hex(token);
    const platform: ExchangePlatformRow | null = store.findPlatformByTokenHash(tokenHash);
    if (platform !== null) {
      c.set("exchange", {
        kind: "platform",
        tenantId: platform.tenantId,
        platformId: platform.platformId,
      });
      await next();
      return;
    }
    const device: ExchangeDeviceRow | null = store.findDeviceByTokenHash(tokenHash);
    if (device !== null && store.findPlatform(device.tenantId, device.platformId)?.revokedAt === null) {
      c.set("exchange", {
        kind: "device",
        tenantId: device.tenantId,
        platformId: device.platformId,
        deviceId: device.deviceId,
        userId: device.userId,
        device,
      });
      await next();
      return;
    }
    throw new HttpError(401, "unauthorized", "Unknown or revoked exchange token.");
  };
}

/** Narrow the caller: a platform call (403 otherwise). */
export function requirePlatform(c: { var: { exchange?: ExchangeCaller } }): {
  tenantId: string;
  platformId: string;
} {
  const caller = c.var.exchange;
  if (!caller || caller.kind !== "platform") {
    throw new HttpError(403, "platform_token_required", "This endpoint takes a platform token.");
  }
  return { tenantId: caller.tenantId, platformId: caller.platformId };
}

/** Narrow the caller: a device call (403 otherwise). */
export function requireDevice(c: { var: { exchange?: ExchangeCaller } }): {
  tenantId: string;
  platformId: string;
  deviceId: string;
  userId: string;
} {
  const caller = c.var.exchange;
  if (!caller || caller.kind !== "device") {
    throw new HttpError(403, "device_token_required", "This endpoint takes a device token.");
  }
  return caller;
}
