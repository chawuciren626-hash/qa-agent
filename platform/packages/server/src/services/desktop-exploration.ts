import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { executionFiles, type LocalExecutionRuntime, type ExecutionIdentity, type DetachedExecutionFrame } from "./local-execution-runtime.js";
import type { ExplorationRun, ExplorationMerge, ExplorationEvent } from "./project-exploration-service.js";

/** The server receives artifacts only. Every browser and Python process stays on the desktop. */
export function desktopExploration(runtime: LocalExecutionRuntime, userId: string, identity: ExecutionIdentity, projectDir: string): { run: ExplorationRun; merge: ExplorationMerge } {
  const receiver = (base: string) => async (frame: DetachedExecutionFrame) => {
    if (frame.type !== "bridge_exploration_file") return;
    const relative = frame.path;
    if (typeof relative !== "string" || relative.includes(":") || relative.includes("\\") || relative.split("/").some(p => !p || p === ".." || p === ".") ||
      typeof frame.content !== "string" || frame.content.length > 600_000 || !Number.isSafeInteger(frame.offset) || Number(frame.offset) < 0 || Number(frame.offset) > 16 * 1024 * 1024 ||
      typeof frame.hash !== "string" || !/^[a-f0-9]{64}$/.test(frame.hash)) throw new Error("无效探索文件回执");
    // Credentials, browser storage and captcha answers never become central artifacts.
    if (/(^|\/)(credentials|answer|storage-state|session)\.json(l)?$/.test(relative)) throw new Error("探索私密文件不得上传");
    const target = path.resolve(base, relative);
    if (!target.startsWith(path.resolve(base) + path.sep)) throw new Error("探索文件路径越界");
    await fs.mkdir(path.dirname(target), { recursive: true });
    for (let parent = target; parent.startsWith(path.resolve(base) + path.sep); parent = path.dirname(parent)) {
      if ((await fs.lstat(parent).catch(() => null))?.isSymbolicLink()) throw new Error("探索文件不允许符号链接");
    }
    const temp = `${target}.bridge-upload-${frame.hash}`;
    if ((await fs.lstat(temp).catch(() => null))?.isSymbolicLink()) throw new Error("探索文件不允许符号链接");
    const bytes = Buffer.from(frame.content, "base64");
    if (Number(frame.offset) === 0) await fs.writeFile(temp, bytes, { mode: 0o600 });
    else {
      if ((await fs.stat(temp)).size !== frame.offset) throw new Error("探索文件片段顺序无效");
      await fs.appendFile(temp, bytes);
    }
    if (frame.final === true) {
      if (createHash("sha256").update(await fs.readFile(temp)).digest("hex") !== frame.hash) throw new Error("探索文件校验失败");
      await fs.rename(temp, target);
    }
  };
  return {
    run: input => {
      const receive = receiver(input.outDir);
      const handle = runtime.detached(userId, identity, "exploration", {
        targetUrl: input.targetUrl, loginUrl: input.loginUrl, username: input.username, password: input.password,
        loginConfig: input.loginConfig, publicMode: input.publicMode,
      }, async frame => {
        await receive(frame);
        if (frame.type === "bridge_exploration_event") {
          const event = { ...(frame.event as ExplorationEvent) };
          if (event.kind === "captcha" && event.path) {
            if (!/^[a-zA-Z0-9_.-]+$/.test(event.path)) throw new Error("验证码路径无效");
            event.path = path.join(input.outDir, event.path);
          }
          input.onEvent(event);
        }
      });
      return { done: handle.done as Promise<{ ok: boolean; error: string | null }>, answer: handle.answer, abort: handle.abort };
    },
    merge: async input => {
      const receive = receiver(projectDir);
      const files = [...await executionFiles(input.exploreDir, "explore/"), ...await executionFiles(path.join(projectDir, "maps", input.env), "maps/")];
      let result: any;
      const handle = runtime.detached(userId, identity, "explorationMerge", {
        projectId: input.projectId, env: input.env, targetRoute: input.targetRoute, round: input.round, publicMode: input.publicMode,
        files,
        outPrefix: path.relative(projectDir, input.exploreDir).split(path.sep).join("/"),
      }, async frame => { await receive(frame); if (frame.type === "bridge_result") result = frame.value; });
      const status = await handle.done as { ok: boolean; error: string | null };
      if (!status.ok) throw new Error(status.error ?? "本机地图合并失败");
      if (!result?.maps) throw new Error("本机地图合并缺少结果");
      return result;
    },
  };
}
