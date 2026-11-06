import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { unzipSync } from "fflate";

export interface PluginToolManifest {
  name: string;
  permissions: string[];
}

export interface PluginManifest {
  schemaVersion: 1;
  id: string;
  version: string;
  publisher: string;
  compatibility: { minServerVersion?: string; maxServerVersion?: string };
  permissions: string[];
  tools: PluginToolManifest[];
  executables: { path: string; sha256: string }[];
  packageSha256: string;
  signature?: { algorithm: "ed25519"; keyId: string; value: string };
}

export class UnsafePackageError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "UnsafePackageError";
  }
}

const ID = /^[a-z0-9][a-z0-9._-]{1,63}$/;
const SEMVER = /^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/;
const SHA = /^sha256:[a-f0-9]{64}$/;

/** Manifest is the package's declared contract: tools, permissions, compatibility and hashes. */
export function parsePluginManifest(text: string): PluginManifest {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new UnsafePackageError("manifest_invalid", "插件清单不是有效 JSON。"); }
  const manifest = value as Partial<PluginManifest>;
  if (!manifest || manifest.schemaVersion !== 1) throw new UnsafePackageError("manifest_invalid", "插件清单版本不受支持。");
  if (typeof manifest.id !== "string" || !ID.test(manifest.id)) throw new UnsafePackageError("manifest_invalid", "插件标识无效。");
  if (typeof manifest.version !== "string" || !SEMVER.test(manifest.version)) throw new UnsafePackageError("manifest_invalid", "插件版本无效。");
  if (typeof manifest.publisher !== "string" || !ID.test(manifest.publisher)) throw new UnsafePackageError("manifest_invalid", "发布者无效。");
  if (!Array.isArray(manifest.permissions) || manifest.permissions.some(item => typeof item !== "string" || item.length > 64)) throw new UnsafePackageError("manifest_invalid", "插件权限声明无效。");
  if (!Array.isArray(manifest.tools) || manifest.tools.length > 64) throw new UnsafePackageError("manifest_invalid", "插件工具声明无效。");
  const names = new Set<string>();
  for (const tool of manifest.tools) {
    if (!tool || typeof tool.name !== "string" || !/^[a-zA-Z0-9_.-]{1,120}$/.test(tool.name) || names.has(tool.name)) throw new UnsafePackageError("manifest_invalid", "插件工具名重复或无效。");
    names.add(tool.name);
    if (!Array.isArray(tool.permissions) || tool.permissions.some(item => typeof item !== "string" || item.length > 64)) throw new UnsafePackageError("manifest_invalid", "插件工具权限无效。");
  }
  if (!Array.isArray(manifest.executables) || manifest.executables.length > 128) throw new UnsafePackageError("manifest_invalid", "插件可执行文件声明无效。");
  for (const executable of manifest.executables) {
    if (!executable || typeof executable.path !== "string" || typeof executable.sha256 !== "string" || !SHA.test(executable.sha256)) throw new UnsafePackageError("manifest_invalid", "插件可执行文件哈希无效。");
    assertSafeRelativePath(executable.path);
  }
  if (typeof manifest.packageSha256 !== "string" || !SHA.test(manifest.packageSha256)) throw new UnsafePackageError("manifest_invalid", "插件包哈希无效。");
  const compatibility = manifest.compatibility ?? {};
  if (compatibility.minServerVersion !== undefined && !SEMVER.test(compatibility.minServerVersion)) throw new UnsafePackageError("manifest_invalid", "最低宿主版本无效。");
  if (compatibility.maxServerVersion !== undefined && !SEMVER.test(compatibility.maxServerVersion)) throw new UnsafePackageError("manifest_invalid", "最高宿主版本无效。");
  if (manifest.signature !== undefined) {
    if (manifest.signature.algorithm !== "ed25519" || typeof manifest.signature.keyId !== "string" || !ID.test(manifest.signature.keyId) || typeof manifest.signature.value !== "string") {
      throw new UnsafePackageError("manifest_invalid", "插件签名声明无效。");
    }
  }
  return manifest as PluginManifest;
}

/** The exact bytes a publisher signs. */
export function signingPayload(manifest: PluginManifest): Buffer {
  return Buffer.from(JSON.stringify({
    schemaVersion: manifest.schemaVersion,
    id: manifest.id,
    version: manifest.version,
    publisher: manifest.publisher,
    compatibility: manifest.compatibility,
    permissions: manifest.permissions,
    tools: manifest.tools.map(tool => ({ name: tool.name, permissions: tool.permissions })).sort((a, b) => a.name.localeCompare(b.name)),
    executables: manifest.executables.map(item => ({ path: item.path, sha256: item.sha256 })).sort((a, b) => a.path.localeCompare(b.path)),
    packageSha256: manifest.packageSha256,
  }), "utf8");
}

export function packageDigest(files: Record<string, Uint8Array>): string {
  const lines = Object.entries(files)
    .filter(([name]) => name !== "plugin-manifest.json")
    .map(([name, data]) => `${normalize(name)}:${createHash("sha256").update(data).digest("hex")}`)
    .sort();
  return `sha256:${createHash("sha256").update(lines.join("\n")).digest("hex")}`;
}

export interface ZipEntryInfo {
  path: string;
  isDirectory: boolean;
  isSymlink: boolean;
}

/**
 * Reads the central directory before extraction so absolute paths, traversal and symlinks are
 * rejected without ever touching disk.
 */
export function inspectZip(bytes: Uint8Array): ZipEntryInfo[] {
  let eocd = -1;
  for (let index = Math.max(0, bytes.length - 22); index >= Math.max(0, bytes.length - 65_557); index--) {
    if (readUInt32(bytes, index) === 0x06054b50) { eocd = index; break; }
  }
  if (eocd < 0) throw new UnsafePackageError("zip_invalid", "插件包不是有效的 ZIP。");
  const count = readUInt16(bytes, eocd + 10);
  const offset = readUInt32(bytes, eocd + 16);
  if (offset <= 0 || offset >= bytes.length) throw new UnsafePackageError("zip_invalid", "插件包目录无效。");
  const entries: ZipEntryInfo[] = [];
  let position = offset;
  for (let index = 0; index < count; index++) {
    if (readUInt32(bytes, position) !== 0x02014b50) throw new UnsafePackageError("zip_invalid", "插件包目录项无效。");
    const nameLength = readUInt16(bytes, position + 28);
    const extraLength = readUInt16(bytes, position + 30);
    const commentLength = readUInt16(bytes, position + 32);
    const externalAttributes = readUInt32(bytes, position + 38);
    const nameStart = position + 46;
    if (nameStart + nameLength > bytes.length) throw new UnsafePackageError("zip_invalid", "插件包目录项越界。");
    const name = Buffer.from(bytes.subarray(nameStart, nameStart + nameLength)).toString("utf8");
    const mode = (externalAttributes >>> 16) & 0xffff;
    const isDirectory = name.endsWith("/") || (mode & 0xf000) === 0x4000;
    const isSymlink = (mode & 0xf000) === 0xa000;
    if (isSymlink) throw new UnsafePackageError("link_unsafe", "插件包包含符号链接。");
    if (!isDirectory) assertSafeRelativePath(name);
    else assertSafeRelativePath(name.replace(/\/$/, ""));
    entries.push({ path: name, isDirectory, isSymlink });
    position = nameStart + nameLength + extraLength + commentLength;
  }
  return entries;
}

export function assertSafeRelativePath(input: string): void {
  if (!input || input.length > 240 || input.includes("\0") || input.includes("\\")) throw new UnsafePackageError("path_unsafe", "插件包路径无效。");
  if (input.startsWith("/") || input.startsWith("~") || /^[A-Za-z]:(?:\/|\\)/.test(input)) throw new UnsafePackageError("path_absolute", "插件包包含绝对路径。");
  const segments = input.split("/");
  if (segments.some(segment => segment === "" || segment === "." || segment === "..")) throw new UnsafePackageError("path_traversal", "插件包包含目录穿越。");
}

export async function extractPackage(bytes: Uint8Array, staging: string): Promise<Record<string, Uint8Array>> {
  inspectZip(bytes);
  const files = unzipSync(bytes);
  await fs.mkdir(staging, { recursive: true });
  const root = path.resolve(staging);
  for (const [name, data] of Object.entries(files)) {
    if (name.endsWith("/")) continue;
    assertSafeRelativePath(name);
    const target = path.resolve(root, name);
    if (!target.startsWith(root + path.sep)) throw new UnsafePackageError("path_traversal", "插件包解压越界。");
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, data, { flag: "wx" });
  }
  return files;
}

export async function verifyExecutables(staging: string, manifest: PluginManifest): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const executable of manifest.executables) {
    const file = path.join(staging, executable.path);
    const actual = `sha256:${createHash("sha256").update(await fs.readFile(file)).digest("hex")}`;
    if (actual !== executable.sha256) throw new UnsafePackageError("executable_hash_mismatch", `可执行文件哈希不匹配：${executable.path}`);
    result[executable.path] = actual;
  }
  return result;
}

export function compatible(hostVersion: string, manifest: PluginManifest): boolean {
  if (manifest.compatibility.minServerVersion && !versionAtLeast(hostVersion, manifest.compatibility.minServerVersion)) return false;
  if (manifest.compatibility.maxServerVersion && !versionAtLeast(manifest.compatibility.maxServerVersion, hostVersion)) return false;
  return true;
}

export function versionAtLeast(version: string, minimum: string): boolean {
  const left = version.split(/[-+]/)[0]!.split(".").map(part => Number.parseInt(part, 10) || 0);
  const right = minimum.split(/[-+]/)[0]!.split(".").map(part => Number.parseInt(part, 10) || 0);
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    if ((left[index] ?? 0) > (right[index] ?? 0)) return true;
    if ((left[index] ?? 0) < (right[index] ?? 0)) return false;
  }
  return true;
}

function normalize(name: string): string { return name.replaceAll("\\", "/"); }
function readUInt16(bytes: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 2 > bytes.length) throw new UnsafePackageError("zip_invalid", "插件包截断。");
  return bytes[offset]! | (bytes[offset + 1]! << 8);
}
function readUInt32(bytes: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 4 > bytes.length) throw new UnsafePackageError("zip_invalid", "插件包截断。");
  return (bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16) | (bytes[offset + 3]! << 24)) >>> 0;
}
