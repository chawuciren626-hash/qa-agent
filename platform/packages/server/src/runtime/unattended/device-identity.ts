/**
 * The local device identity: a stable random id per data root, persisted as
 * `<root>/device-identity.json` on first use. This is the "which device" half of the
 * unattended boundary — the device an unattended task is bound to IS the machine this
 * server runs on (the product's 本机执行器). External/remote device identities are a
 * server-side concern of the task exchange (batch 5, exchange_devices) and never come
 * from this file.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

interface DeviceIdentityFile {
  deviceId: string;
  createdAt: string;
}

const FILE_NAME = "device-identity.json";

/** Read-or-create the data root's device identity (synchronous: callers need it once at dispatch/route time). */
export function localDeviceId(root: string): string {
  const file = path.join(root, FILE_NAME);
  try {
    const raw = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(raw) as Partial<DeviceIdentityFile>;
    if (typeof parsed.deviceId === "string" && parsed.deviceId !== "") return parsed.deviceId;
  } catch {
    // Missing or unreadable: create below.
  }
  const identity: DeviceIdentityFile = { deviceId: randomUUID(), createdAt: new Date().toISOString() };
  const tmp = path.join(root, `${FILE_NAME}.tmp-${randomUUID()}`);
  fs.writeFileSync(tmp, `${JSON.stringify(identity, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, file);
  return identity.deviceId;
}
