import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { zipSync } from "fflate";
import { afterEach, expect, it } from "vitest";
import { packageDigest, signingPayload, type PluginManifest } from "../src/plugins/package.js";
import { OwnedProcessRegistry } from "../src/plugins/processes.js";
import { TrustedPluginStore } from "../src/plugins/store.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

const keys = generateKeyPairSync("ed25519");
const publicKeyPem = String(keys.publicKey.export({ type: "spki", format: "pem" }));

function buildPackage(options: { version?: string; publisherSigned?: boolean; minHostVersion?: string; executable?: Uint8Array; executableHash?: string; extra?: Record<string, Uint8Array> } = {}): string {
  const version = options.version ?? "1.0.0";
  const executable = options.executable ?? Buffer.from("console.log('echo');");
  const executableHash = options.executableHash ?? `sha256:${createHash("sha256").update(executable).digest("hex")}`;
  const files: Record<string, Uint8Array> = { "run.js": executable, "README.md": Buffer.from("readme"), ...(options.extra ?? {}) };
  const packageSha256 = packageDigest(files);
  const manifest: PluginManifest = {
    schemaVersion: 1, id: "com.example.echo", version, publisher: "example",
    compatibility: { minServerVersion: options.minHostVersion ?? "0.2.0" },
    permissions: ["filesystem"],
    tools: [{ name: "echo", permissions: ["filesystem"] }],
    executables: [{ path: "run.js", sha256: executableHash }],
    packageSha256,
    ...(options.publisherSigned === false ? {} : { signature: { algorithm: "ed25519" as const, keyId: "example", value: "" } }),
  };
  if (manifest.signature) manifest.signature.value = sign(null, signingPayload(manifest), keys.privateKey).toString("base64");
  files["plugin-manifest.json"] = Buffer.from(JSON.stringify(manifest));
  return Buffer.from(zipSync(files)).toString("base64");
}

function markFirstEntryAsSymlink(zip: Uint8Array): Uint8Array {
  let eocd = -1;
  for (let index = zip.length - 22; index >= 0; index--) if (zip[index] === 0x50 && zip[index + 1] === 0x4b && zip[index + 2] === 0x05 && zip[index + 3] === 0x06) { eocd = index; break; }
  const central = zip[eocd + 16]! | (zip[eocd + 17]! << 8) | (zip[eocd + 18]! << 16) | (zip[eocd + 19]! << 24);
  zip[central + 38] = 0x00; zip[central + 39] = 0x00; zip[central + 40] = 0x00; zip[central + 41] = 0xa0;
  return zip;
}

async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "plugins-"));
  roots.push(root);
  const db = new DatabaseSync(":memory:");
  const store = new TrustedPluginStore(db, { dataRoot: root, serverVersion: "0.2.17", trust: { publishers: [{ keyId: "example", publicKeyPem }] } });
  return { root, db, store };
}

it('refuses different content under an existing version, including concurrent installs', async () => {
  const { store } = await setup();
  const results = await Promise.all([store.install(buildPackage()), store.install(buildPackage({ executable: Buffer.from('different bytes') }))]);
  expect(results[0]?.status).toBe('enabled');
  expect(results[1]).toMatchObject({status: 'rejected', reason: 'version_content_conflict'});
});

it("activates a verified package atomically and enforces tool permissions", async () => {
  const { root, store } = await setup();
  const result = await store.install(buildPackage());
  expect(result).toMatchObject({ status: "enabled", pluginId: "com.example.echo", version: "1.0.0", activeVersion: "1.0.0", trustState: "verified" });
  expect(await fs.stat(path.join(root, "trusted-plugins", "com.example.echo", "1.0.0", "run.js"))).toBeTruthy();
  expect(store.authorizeTool(undefined, "com.example.echo", "echo", ["filesystem"]).version).toBe("1.0.0");
  expect(() => store.authorizeTool(undefined, "com.example.echo", "echo", [])).toThrow(/permission_not_granted/);
});

it("stores an unsigned package as pending and never executes it", async () => {
  const { root, store } = await setup();
  const result = await store.install(buildPackage({ publisherSigned: false }));
  expect(result).toMatchObject({ status: "pending_verification", trustState: "pending" });
  expect(store.activeVersion("com.example.echo")).toBeNull();
  expect(() => store.authorizeTool(undefined, "com.example.echo", "echo", ["filesystem"])).toThrow(/plugin_not_trusted/);
  const folders = await fs.readdir(path.join(root, "trusted-plugins", "com.example.echo"));
  expect(folders.some(name => name.startsWith("pending-"))).toBe(true);
});

it("rejects incompatible hosts, tampered executables and unsafe archive paths", async () => {
  const { store } = await setup();
  expect(await store.install(buildPackage({ minHostVersion: "99.0.0" }))).toMatchObject({ status: "incompatible", reason: "host_version_incompatible" });
  const tampered = await store.install(buildPackage({ version: "2.0.0", executableHash: "sha256:" + "0".repeat(64) }));
  expect(tampered).toMatchObject({ status: "rejected", reason: "executable_hash_mismatch" });
  expect(store.activeVersion("com.example.echo")).toBeNull();
  expect(await store.install(buildPackage({ extra: { "../escape.txt": Buffer.from("x") } }))).toMatchObject({ status: "rejected", reason: "path_traversal" });
  expect(await store.install(buildPackage({ extra: { "/absolute.txt": Buffer.from("x") } }))).toMatchObject({ status: "rejected", reason: "path_absolute" });
  const linked = markFirstEntryAsSymlink(zipSync({ "run.js": Buffer.from("console.log('echo');") }));
  expect(await store.install(Buffer.from(linked).toString("base64"))).toMatchObject({ status: "rejected", reason: "link_unsafe" });
});

it("keeps old versions while sessions pin them and rolls back a failed update", async () => {
  const { root, store } = await setup();
  await store.install(buildPackage());
  store.pinSession("s1", "com.example.echo");
  await store.install(buildPackage({ version: "2.0.0" }));
  expect(store.resolveForSession("s1", "com.example.echo")?.version).toBe("1.0.0");
  store.pinSession("s2", "com.example.echo");
  expect(store.resolveForSession("s2", "com.example.echo")?.version).toBe("2.0.0");
  expect(await store.cleanup("com.example.echo")).toEqual([]);

  const failed = await store.install(buildPackage({ version: "3.0.0", executableHash: "sha256:" + "0".repeat(64) }));
  expect(failed).toMatchObject({ status: "rejected" });
  expect(store.activeVersion("com.example.echo")).toBe("2.0.0");
  expect(await fs.stat(path.join(root, "trusted-plugins", "com.example.echo", "2.0.0"))).toBeTruthy();

  store.releaseSession("s1");
  expect(await store.cleanup("com.example.echo")).toEqual(["1.0.0"]);
  expect(await fs.stat(path.join(root, "trusted-plugins", "com.example.echo", "1.0.0")).catch(() => null)).toBeNull();
});

it("recycles owned processes and temporary data after an abnormal exit", async () => {
  const registry = new OwnedProcessRegistry();
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "plugin-temp-"));
  let killed = 0;
  let cleaned = 0;
  registry.track("s1", {
    pluginId: "com.example.echo", version: "1.0.0", exited: false,
    kill: () => { killed++; },
    cleanup: async () => { cleaned++; await fs.rm(temp, { recursive: true, force: true }); },
  });
  expect(registry.running("com.example.echo", "1.0.0")).toBe(true);
  await registry.recycle("s1");
  expect(killed).toBe(1);
  expect(cleaned).toBe(1);
  expect(registry.running()).toBe(false);
  expect(registry.count()).toBe(0);
  expect(await fs.stat(temp).catch(() => null)).toBeNull();
});
