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
    throw new Error("Invalid local device identity");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const identity: DeviceIdentityFile = { deviceId: randomUUID(), createdAt: new Date().toISOString() };
  try {
    fs.writeFileSync(file, `${JSON.stringify(identity, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return localDeviceId(root);
    throw error;
  }
  return identity.deviceId;
}
