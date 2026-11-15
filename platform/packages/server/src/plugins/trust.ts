import { verify } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { signingPayload, type PluginManifest } from "./package.js";

export interface TrustedPublisher {
  keyId: string;
  publicKeyPem: string;
}

export interface TrustPolicy {
  publishers: TrustedPublisher[];
}

/**
 * A hash proves integrity, not authorship. Executable plugins become runnable only when their
 * manifest carries an ed25519 signature by a publisher listed in the deployment trust file.
 */
export function loadTrustPolicy(root: string, file = "trusted-plugin-publishers.json"): TrustPolicy {
  const target = path.join(root, file);
  const stat = fs.lstatSync(target, { throwIfNoEntry: false });
  if (!stat) return { publishers: [] };
  if (!stat.isFile() || stat.isSymbolicLink()) throw Error("Plugin trust policy must be a regular file");
  const parsed = JSON.parse(fs.readFileSync(target, "utf8")) as TrustPolicy;
  if (!parsed || !Array.isArray(parsed.publishers)) throw Error("Plugin trust policy is invalid");
  for (const publisher of parsed.publishers) {
    if (!publisher || typeof publisher.keyId !== "string" || typeof publisher.publicKeyPem !== "string") throw Error("Plugin trust policy publisher is invalid");
  }
  return { publishers: parsed.publishers };
}

export function verifyPublisher(manifest: PluginManifest, policy: TrustPolicy): { trusted: boolean; keyId?: string; reason?: string } {
  if (!manifest.signature) return { trusted: false, reason: "publisher_unsigned" };
  const publisher = policy.publishers.find(item => item.keyId === manifest.signature!.keyId);
  if (!publisher) return { trusted: false, reason: "publisher_unknown" };
  if (publisher.publicKeyPem.length > 4096 || !publisher.publicKeyPem.includes("PUBLIC KEY")) return { trusted: false, reason: "publisher_key_invalid" };
  let valid = false;
  try {
    valid = verify(null, signingPayload(manifest), publisher.publicKeyPem, Buffer.from(manifest.signature.value, "base64"));
  } catch { valid = false; }
  return valid ? { trusted: true, keyId: publisher.keyId } : { trusted: false, reason: "signature_invalid" };
}
