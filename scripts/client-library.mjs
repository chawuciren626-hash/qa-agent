import { promises as fs } from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";

const queues = new Map();
const idPattern = /^[a-f0-9-]{36}$/;
const MAX_BYTES = 10 * 1024 * 1024;
function fail(message, status = 400) {
  throw Object.assign(new Error(message), { status });
}
function safeName(value) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 160 ||
    /[\x00-\x1f<>:"/\\|?*]/.test(value) ||
    /[. ]$/.test(value) ||
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)
  )
    fail("请输入有效的文件名称");
  return value.trim();
}
function summary({ content, ...record }) {
  return record;
}
async function directory(root, projectId, userId) {
  let dir = root;
  for (const part of [
    "qa-library",
    createHash("sha256").update(projectId).digest("hex"),
    createHash("sha256").update(userId).digest("hex"),
  ]) {
    dir = join(dir, part);
    await fs.mkdir(dir, { recursive: true });
    const stat = await fs.lstat(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      fail("资料目录不可用", 409);
  }
  return dir;
}
async function load(dir, id) {
  if (!idPattern.test(id || "")) fail("无效的资料标识");
  const path = join(dir, id + ".json");
  try {
    const stat = await fs.lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) fail("资料文件不可用", 409);
    return JSON.parse(await fs.readFile(path, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") fail("资料不存在或已删除", 404);
    throw e;
  }
}
async function list(dir) {
  const names = (await fs.readdir(dir)).filter(
    (n) => idPattern.test(n.replace(/\.json$/, "")) && n.endsWith(".json"),
  );
  return Promise.all(names.map((n) => load(dir, n.slice(0, -5))));
}
export async function libraryOperation(
  root,
  projectId,
  userId,
  method,
  id,
  body = {},
) {
  if (!root || !projectId || !userId) fail("资料库身份信息缺失", 403);
  if (method !== "GET" && (!body || typeof body !== "object" || Array.isArray(body)))
    fail("无效的资料请求");
  const dir = await directory(root, projectId, userId);
  if (method === "GET") {
    if (id) return load(dir, id);
    const rows = await list(dir);
    return {
      entries: rows
        .map(summary)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
      usedBytes: rows.reduce((n, r) => n + r.size, 0),
    };
  }
  const previous = queues.get(dir) || Promise.resolve();
  const pending = previous
    .catch(() => {})
    .then(async () => {
      const rows = await list(dir);
      const old = id ? await load(dir, id) : null;
      if (!["POST", "PUT", "DELETE"].includes(method)) fail("不支持的操作");
      if ((method === "PUT" || method === "DELETE") && !old)
        fail("资料不存在", 404);
      if (old && body.revision !== old.revision)
        fail("资料已更新，请重新打开后再操作", 409);
      if (method === "DELETE") {
        if (rows.some((r) => r.parentId === id))
          fail("请先移走或删除文件夹内的资料", 409);
        await fs.unlink(join(dir, id + ".json"));
        return { deleted: true };
      }
      if (!old && rows.length >= 2000) fail("资料数量已达上限");
      const name = safeName(body.name);
      const kind = old?.kind || body.kind;
      if (!["file", "folder", "link"].includes(kind)) fail("无效的资料类型");
      const parentId = old ? old.parentId : body.parentId || null;
      if (
        parentId &&
        !rows.some((r) => r.id === parentId && r.kind === "folder")
      )
        fail("目标文件夹不存在");
      if (
        rows.some(
          (r) =>
            r.id !== id &&
            r.parentId === parentId &&
            r.name.toLocaleLowerCase() === name.toLocaleLowerCase(),
        )
      )
        fail("此文件夹已存在同名资料", 409);
      let content = kind === "folder" ? "" : body.content;
      const encoding =
        kind === "file" && body.encoding === "base64" ? "base64" : "utf8";
      if (typeof content !== "string") fail("资料内容无效");
      if (
        encoding === "base64" &&
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
          content,
        )
      )
        fail("文件编码无效");
      const size = Buffer.byteLength(content, encoding);
      if (size > MAX_BYTES) fail("单个文件最大 10 MB", 413);
      if (
        rows.reduce((n, r) => n + (r.id === id ? 0 : r.size), 0) + size >
        100 * 1024 * 1024
      )
        fail("本机资料库已达 100 MB 上限", 413);
      if (kind === "link") {
        let url;
        try {
          url = new URL(content);
        } catch {
          fail("请输入完整的 http 或 https 链接");
        }
        if (!["http:", "https:"].includes(url.protocol))
          fail("仅支持 http 或 https 链接");
        content = url.href;
      }
      const record = {
        id: old?.id || randomUUID(),
        name,
        kind,
        parentId,
        content,
        encoding,
        size,
        createdAt: old?.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        revision: randomUUID(),
      };
      const path = join(dir, record.id + ".json"),
        temp = path + "." + randomUUID() + ".tmp";
      try {
        await fs.writeFile(temp, JSON.stringify(record), { flag: "wx" });
        await fs.rename(temp, path);
      } finally {
        await fs.unlink(temp).catch((e) => {
          if (e.code !== "ENOENT") throw e;
        });
      }
      return record;
    });
  queues.set(dir, pending);
  try {
    return await pending;
  } finally {
    if (queues.get(dir) === pending) queues.delete(dir);
  }
}

export function registerLibraryRoutes(
  app,
  deps,
  { requireValidId, HttpError },
) {
  const handle = async (c) => {
    const projectId = requireValidId(c, "projectId");
    deps.access.requireProjectAccess(c.var.user.userId, projectId);
    let body = {};
    if (c.req.method !== "GET") {
      // Enforce size while streaming, before JSON decoding or allocating file buffers.
      const reader = c.req.raw.body?.getReader();
      const chunks = [];
      let bytes = 0;
      if (reader)
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          bytes += part.value.length;
          if (bytes > 15 * 1024 * 1024) {
            await reader.cancel();
            throw new HttpError(413, "library_too_large", "单个文件最大 10 MB");
          }
          chunks.push(Buffer.from(part.value));
        }
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      } catch {
        throw new HttpError(400, "library_invalid", "无效的请求");
      }
    }
    try {
      return c.json(
        await libraryOperation(
          deps.memoryService.root,
          projectId,
          c.var.user.userId,
          c.req.method,
          c.req.param("id"),
          body,
        ),
        c.req.method === "POST" ? 201 : 200,
      );
    } catch (e) {
      throw new HttpError(
        e.status || 500,
        "library_error",
        e.status ? e.message : "资料读写失败，请重试",
      );
    }
  };
  app.get("/library", handle);
  app.post("/library", handle);
  app.get("/library/:id", handle);
  app.put("/library/:id", handle);
  app.delete("/library/:id", handle);
}

export const libraryAnchor =
  "function memoryRoutes(deps) {\n  const app = new Hono2();";
export function patchLibraryServer(source, moduleUrl) {
  if (source.split(libraryAnchor).length !== 2)
    throw Error("Unsupported library server anchor");
  return (
    `import { registerLibraryRoutes as qaRegisterLibrary } from ${JSON.stringify(moduleUrl)};\n` +
    source.replace(
      libraryAnchor,
      libraryAnchor +
        "\n  qaRegisterLibrary(app, deps, {requireValidId, HttpError});",
    )
  );
}
