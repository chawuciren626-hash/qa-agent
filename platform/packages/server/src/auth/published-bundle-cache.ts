import { publishedPluginRuntime } from "./published-plugin-runtime.js";
import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { InstalledHook, SystemConfig } from "@prismshadow/penguin-core";
import { localAgentId, validateResolvedBundle, type ResolvedPublishedBundle } from "./published-bundle.js";
import { parseSkillArchive } from "../http/routes/skills.js";

const MAX_BUNDLE_BYTES = 16 * 1024 * 1024;
const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

export interface CachedSharedAgentDefinition {
  resourceId: string;
  memoryInstructions?: string;
  agentId: string;
  bundleHash: string;
  prompt: string;
  agentsMd: string;
  maxTurns?: number;
  model?: { max_tokens?: number; timeoutMs?: number; thinking_level?: "none" | "low" | "medium" | "high" | "xhigh" | "max" };
  compaction?: { max_context_length?: number; max_session_turns?: number; mode?: "summarize" | "discard"; prompt?: string };
  builtinTools?: NonNullable<NonNullable<SystemConfig["tools"]>["builtin"]>;
  skillsConfig?: SystemConfig["skills"];
  hooksConfig?: SystemConfig["hooks"];
  skills: readonly { name: string; directory: string }[];
  pluginInstructions: readonly string[];
  hookPackages?: readonly InstalledHook[];
  mcpServers?: NonNullable<NonNullable<SystemConfig["tools"]>["mcpServers"]>;
  localAdapters: readonly { name: string; version: string; hash: string }[];
}

/** Per-account cache under the local data root, shared by that account's projects. */
export class PublishedBundleCache {
  constructor(private readonly dataRoot: string) {}

  private file(userId: string, hash: string): string {
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(userId) || !/^sha256:[a-f0-9]{64}$/.test(hash)) {
      throw Error("Invalid published bundle cache key");
    }
    return path.join(this.dataRoot, ".shared-agent-definitions", sha256(userId), `${hash.slice(7)}.json`);
  }

  async store(userId: string, value: unknown): Promise<ResolvedPublishedBundle> {
    const bundle = validateResolvedBundle(value);
    const text = JSON.stringify(bundle);
    if (Buffer.byteLength(text) > MAX_BUNDLE_BYTES) throw Error("Published bundle exceeds local cache limit");
    const target = this.file(userId, bundle.bundleHash);
    const dir = path.dirname(target);
    await fs.mkdir(dir, { recursive: true });
    for (const candidate of [path.join(this.dataRoot, ".shared-agent-definitions"), dir]) {
      const stat = await fs.lstat(candidate);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error("Published bundle cache directory is unsafe");
    }
    const existing = await fs.lstat(target).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (existing) {
      if (!existing.isFile() || existing.isSymbolicLink()) throw Error("Published bundle cache path is not a regular file");
      const prior = await this.load(userId, bundle.bundleHash);
      // The hash covers immutable published content. Central draft metadata (for
      // example updatedAt and revision) may change without a new publication.
      if (JSON.stringify(prior.versions) !== JSON.stringify(bundle.versions)) throw Error("Published bundle cache collision");
      return prior;
    }
    const temp = path.join(dir, `.${randomUUID()}.tmp`);
    try {
      await fs.writeFile(temp, text, { flag: "wx", mode: 0o600 });
      // A cache race is safe only if the winner's full content is identical.
      try {
        await fs.copyFile(temp, target, constants.COPYFILE_EXCL);
        return bundle;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const prior = await this.load(userId, bundle.bundleHash);
        if (JSON.stringify(prior.versions) !== JSON.stringify(bundle.versions)) throw Error("Published bundle cache collision");
        return prior;
      }
    } finally {
      await fs.rm(temp, { force: true });
    }
  }

  async load(userId: string, hash: string): Promise<ResolvedPublishedBundle> {
    const target = this.file(userId, hash);
    const stat = await fs.lstat(target);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BUNDLE_BYTES) {
      throw Error("Published bundle cache entry is unsafe");
    }
    const bundle = validateResolvedBundle(JSON.parse(await fs.readFile(target, "utf8")));
    if (bundle.bundleHash !== hash) throw Error("Published bundle cache key mismatch");
    return bundle;
  }

  /** Expand verified Skill content once per account and bundle, never inside a project. */
  async materializeSkills(userId: string, hash: string): Promise<readonly { name: string; directory: string }[]> {
    const bundle = await this.load(userId, hash);
    const accountDirectory = path.dirname(this.file(userId, hash));
    const accountStat = await fs.lstat(accountDirectory);
    if (!accountStat.isDirectory() || accountStat.isSymbolicLink()) throw Error("Published Skill account cache directory is unsafe");
    const base = path.join(accountDirectory, hash.slice(7));
    await fs.mkdir(base).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
    const baseStat = await fs.lstat(base);
    if (!baseStat.isDirectory() || baseStat.isSymbolicLink()) throw Error("Published Skill bundle cache directory is unsafe");
    const skillRoot = path.join(base, "skills");
    await fs.mkdir(skillRoot).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
    const rootStat = await fs.lstat(skillRoot);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw Error("Published Skill cache directory is unsafe");
    const skills = bundle.resources.filter(resource => resource.kind === "skills");
    const names = new Set<string>();
    const result: { name: string; directory: string }[] = [];
    for (const resource of skills) {
      const payload = resource.payload;
      const name = String(payload.skillName ?? "");
      if (!/^[A-Za-z0-9_-]{1,100}$/.test(name) || names.has(name)) throw Error("Invalid or duplicate published Skill name");
      names.add(name);
      const parsed = typeof payload.archiveBase64 === "string"
        ? parseSkillArchive(Buffer.from(payload.archiveBase64, "base64")) : null;
      if (parsed && parsed.name !== name) throw Error("Published Skill archive name mismatch");
      const files = parsed?.files ?? new Map([["SKILL.md", Buffer.from(String(payload.content ?? ""))]]);
      if (files.has(".published-complete")) throw Error("Reserved published Skill file name");
      const directory = path.join(skillRoot, name);
      result.push({ name, directory });
      const marker = path.join(directory, ".published-complete");
      const directoryStat = await fs.lstat(directory).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (directoryStat && (!directoryStat.isDirectory() || directoryStat.isSymbolicLink())) throw Error("Published Skill cache directory is unsafe");
      const existing = await fs.lstat(marker).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (directoryStat && !existing) throw Error("Incomplete published Skill cache directory");
      if (existing) {
        if (!existing.isFile() || existing.isSymbolicLink() || (await fs.readFile(marker, "utf8")) !== hash) throw Error("Published Skill cache marker is unsafe");
        for (const [relative, bytes] of files) {
          const target = path.resolve(directory, ...relative.split("/"));
          if (!target.startsWith(path.resolve(directory) + path.sep)) throw Error("Unsafe published Skill path");
          let parent = path.dirname(target);
          while (parent !== directory) {
            const parentStat = await fs.lstat(parent);
            if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) throw Error("Published Skill cache directory is unsafe");
            parent = path.dirname(parent);
          }
          const stat = await fs.lstat(target);
          if (!stat.isFile() || stat.isSymbolicLink() || !Buffer.from(bytes).equals(await fs.readFile(target))) throw Error("Published Skill cache entry mismatch");
        }
        continue;
      }
      const parent = skillRoot;
      const temporary = path.join(parent, `.${randomUUID()}.tmp`);
      try {
        await fs.mkdir(temporary);
        for (const [relative, bytes] of files) {
          const target = path.resolve(temporary, ...relative.split("/"));
          if (!target.startsWith(path.resolve(temporary) + path.sep)) throw Error("Unsafe published Skill path");
          await fs.mkdir(path.dirname(target), { recursive: true });
          await fs.writeFile(target, bytes, { flag: "wx", mode: 0o600 });
        }
        await fs.writeFile(path.join(temporary, ".published-complete"), hash, { flag: "wx", mode: 0o600 });
        try { await fs.rename(temporary, directory); }
        catch (error) {
          if (!["EEXIST", "ENOTEMPTY", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
          // A parallel writer won. The next invocation verifies all content.
          return this.materializeSkills(userId, hash);
        }
      } finally { await fs.rm(temporary, { recursive: true, force: true }); }
    }
    return result;
  }

  /** Build the executable definition view only from a verified, local bundle. */
  async definition(userId: string, hash: string): Promise<CachedSharedAgentDefinition> {
    const bundle = await this.load(userId, hash);
    const root = bundle.resources[0]!;
    const { agentId, prompt, agentsMd, maxTurns } = root.payload;
    if (typeof agentId !== "string" || !/^[a-z][a-z0-9_-]*$/.test(agentId) ||
      typeof prompt !== "string" || !prompt.trim() || typeof agentsMd !== "string" || !agentsMd.trim() ||
      (maxTurns !== undefined && (!Number.isSafeInteger(maxTurns) || (Number(maxTurns) < 1 && Number(maxTurns) !== -1))))
      throw Error("Invalid published Agent definition");
    const pluginInstructions: string[] = [];
    const localAdapters: { name: string; version: string; hash: string }[] = [];
    for (const resource of bundle.resources.filter(item => item.kind === "plugins")) {
      if (resource.payload.source === "trusted-local-adapter") {
        const { pluginName, adapterVersion, adapterHash } = resource.payload;
        if (typeof pluginName !== "string" || typeof adapterVersion !== "string" || typeof adapterHash !== "string" ||
          !/^sha256:[a-f0-9]{64}$/.test(adapterHash)) throw Error("Invalid trusted local adapter");
        localAdapters.push({ name: pluginName, version: adapterVersion, hash: adapterHash });
        continue;
      }
      if (resource.payload.source === "upstream-library") continue;
      if (typeof resource.payload.instructions !== "string") throw Error("Invalid published plugin instructions");
      if (resource.payload.instructions.trim()) pluginInstructions.push(resource.payload.instructions);
    }
    const skills = await this.materializeSkills(userId, hash);
    const plugins = await publishedPluginRuntime(bundle,path.join(path.dirname(this.file(userId,hash)),hash.slice(7)));
    const allSkills = [...skills,...plugins.skills];
    if(new Set(allSkills.map(item=>item.name)).size!==allSkills.length)throw Error("Published skills have conflicting names");
    return {
      resourceId: root.id, agentId: localAgentId(agentId), bundleHash: hash, prompt, agentsMd,
      ...(maxTurns === undefined ? {} : { maxTurns: Number(maxTurns) }),
      ...(root.payload.model && typeof root.payload.model === "object" ? { model: {
        ...((root.payload.model as Record<string,unknown>).maxTokens === undefined ? {} : { max_tokens: Number((root.payload.model as Record<string,unknown>).maxTokens) }),
        ...((root.payload.model as Record<string,unknown>).timeoutMs === undefined ? {} : { timeoutMs: Number((root.payload.model as Record<string,unknown>).timeoutMs) }),
        ...((root.payload.model as Record<string,unknown>).thinkingLevel === undefined ? {} : { thinking_level: String((root.payload.model as Record<string,unknown>).thinkingLevel) as "none" | "low" | "medium" | "high" | "xhigh" | "max" }),
      } } : {}),
      ...(root.payload.compaction && typeof root.payload.compaction === "object" ? { compaction: {
        ...((root.payload.compaction as Record<string,unknown>).maxContextLength === undefined ? {} : { max_context_length: Number((root.payload.compaction as Record<string,unknown>).maxContextLength) }),
        ...((root.payload.compaction as Record<string,unknown>).maxSessionTurns === undefined ? {} : { max_session_turns: Number((root.payload.compaction as Record<string,unknown>).maxSessionTurns) }),
        ...((root.payload.compaction as Record<string,unknown>).mode === undefined ? {} : { mode: String((root.payload.compaction as Record<string,unknown>).mode) as "summarize" | "discard" }),
        ...((root.payload.compaction as Record<string,unknown>).prompt === undefined ? {} : { prompt: String((root.payload.compaction as Record<string,unknown>).prompt) }),
      } } : {}),
      ...(Array.isArray(root.payload.toolsBuiltin) ? { builtinTools: root.payload.toolsBuiltin as NonNullable<NonNullable<SystemConfig["tools"]>["builtin"]> } : {}),
      skillsConfig: root.payload.skills as SystemConfig["skills"], hooksConfig: root.payload.hooks as SystemConfig["hooks"],
      skills: allSkills, hookPackages: plugins.hookPackages, mcpServers: plugins.mcpServers, pluginInstructions, localAdapters,
    };
  }
}
