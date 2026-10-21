import { libraryOperation } from "./client-library.mjs";
import { createServer } from "node:http";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, extname, relative } from "node:path";
import { patchDeliveryBundle } from "./penguin-runtime-patches.mjs";
import { patchClientBundle, clientModule, brandDataUrl } from "./client-ui-patches.mjs";
import { createHash } from "node:crypto";
import { versionClientIndex } from "./client-asset-identity.mjs";
const app = process.argv[2],
  port = Number(process.argv[3] || 59870),
  root = resolve(import.meta.dirname, "..");
if (!app)
  throw Error(
    "Usage: node scripts/preview-client-ui.mjs <installed resources/app> [port]",
  );
const web = resolve(app, "web-dist"),
  out = resolve(root, "output/playwright/client-redesign");
mkdirSync(out, { recursive: true });
const html = readFileSync(
  resolve(web, "index.html.qa-runtime-original"),
  "utf8",
);
const asset = html.match(/src="\/assets\/(index-[\w-]+\.js)"/)[1];
const originalBundle=readFileSync(resolve(web,"assets",asset+".qa-runtime-original"),"utf8");
const digest=text=>createHash("sha256").update(text).digest("hex").slice(0,16);
let cachedAssets;
function clientAssets() {
  const module=clientModule(...["penguin/ui/delivery-ui.mjs","penguin/ui/workspace-ui.mjs","penguin/ui/workspace-ui.css"].map(file=>readFileSync(resolve(root,file),"utf8")));
  if(cachedAssets?.module===module) return cachedAssets;
  const revision=digest(module);
  const bundle=patchClientBundle(patchDeliveryBundle(originalBundle,revision)).replace('from "./qa-delivery-ui.js"',`from "./qa-delivery-ui.js?v=${revision}"`);
  cachedAssets={module,bundle,html:versionClientIndex(html,asset,digest(bundle))};
  return cachedAssets;
}
const user = {
  userId: "preview_admin",
  displayName: "admin",
  isAdmin: true,
  passwordIsInitial: false,
};
const agents = [
  {
    agentId: "test_agent",
    name: "软件测试总控智能体",
    description: "测试工程预览",
    projectId: "preview",
    model: { provider: "preview", modelId: "preview-model" },
  },
  { agentId: "test_case_agent", name: "测试用例智能体", projectId: "preview" },
];
for (const agent of agents)
  Object.assign(agent, {
    pluginUpdates: [],
    plugins: [],
    kernelUpdate: null,
    enabled: true,
  });
const model = {
  provider: "preview",
  modelId: "preview-model",
  displayName: "工程验证模型",
  contextWindow: 128000,
  vision: true,
  hasCredential: true,
};
const sessions = [
  {
    sessionId: "preview-history",
    projectId: "preview",
    agentId: "test_agent",
    title: "登录页面功能回归",
    workspace: "E:/QAWorkspaces/preview-history",
    status: "idle",
    hasTrace: true,
    source: "web",
    provider: "preview",
    modelId: "preview-model",
    approvalMode: "allow-all",
    createdAt: "2026-10-16T07:00:00Z",
    lastActiveAt: "2026-10-16T09:30:00Z",
  },
  {
    sessionId: "preview-running",
    projectId: "preview",
    agentId: "test_agent",
    title: "订单接口自动化测试",
    workspace: "E:/QAWorkspaces/preview-running",
    status: "running",
    hasTrace: true,
    source: "web",
    provider: "preview",
    modelId: "preview-model",
    approvalMode: "allow-all",
    createdAt: "2026-10-16T07:00:00Z",
    lastActiveAt: "2026-10-16T09:50:00Z",
  },
];
const previewSchedules = new Map();
for (let i = 0; i < 5; i++)
  sessions.push({
    ...sessions[0],
    sessionId: `preview-extra-${i}`,
    title: `历史测试任务 ${i + 1}`,
    lastActiveAt: `2026-10-15T09:0${i}:00Z`,
  });
const calls = [],
  unhandled = new Set();
let seq = 0;
const inputBySession = new Map();
let previewHumanStatus = "waiting_human";
const json = (res, data, status = 200) => {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
};
const server = createServer(async (req, res) => {
  try {
    const u = new URL(req.url, "http://localhost"),
      p = u.pathname;
    let body = "";
    for await (const c of req) body += c;
    const data = body ? JSON.parse(body) : {};
    if (p.startsWith("/api/")) {
      calls.push({ method: req.method, path: p, data });
      if (p.endsWith("/human-actions")) {
        if (req.method === "POST" && data.decision !== "wait") previewHumanStatus = "accepted";
        return json(res, req.method === "POST" ? { status: previewHumanStatus } : { actions: process.env.QA_PREVIEW_HUMAN_CARD === "1" ? [{ run_id: "run-preview", action_id: "00000000-0000-4000-8000-000000000001", kind: "access", question: "请在保留的浏览器窗口完成登录与验证码验证。", status: previewHumanStatus }] : [] });
      }
      writeFileSync(
        resolve(out, "preview-requests.json"),
        JSON.stringify(calls, null, 2),
      );
      if (p.includes("/memory/library")) {
        const id = p.split("/memory/library/")[1];
        try {
          return json(
            res,
            await libraryOperation(
              resolve(out, "library-fixture"),
              "preview",
              user.userId,
              req.method,
              id,
              data,
            ),
            req.method === "POST" ? 201 : 200,
          );
        } catch (e) {
          return json(res, { error: { message: e.message } }, e.status || 500);
        }
      }
      if (/\/schedules(?:\/[^/]+)?$/.test(p)) {
        const name = decodeURIComponent(p.split("/schedules/")[1] || "");
        if (req.method === "GET")
          return json(res, {
            schedules: [...previewSchedules.values()],
            invalidFiles: [],
          });
        if (req.method === "DELETE") {
          previewSchedules.delete(name);
          return json(res, {});
        }
        const item = {
          ...data,
          name: name || data.name,
          status: data.enabled ? "active" : "disabled",
          nextFireAt: data.enabled ? data.startAt : undefined,
        };
        previewSchedules.set(item.name, item);
        return json(res, item);
      }
      if (p.endsWith("/files"))
        return json(res, {
          path: u.searchParams.get("path") || "",
          entries: [
            {
              name: "工程预览报告.md",
              kind: "file",
              sizeBytes: 100,
              mtime: new Date().toISOString(),
            },
          ],
        });
      if (p === "/api/install")
        return json(res, { installId: "client-ui-preview-v2" });
      if (p === "/api/me")
        return json(res, {
          user,
          previewIsolated: true,
          desktopMode: true,
          sessionVia: "desktop",
          companyMode: false,
          uploadLimits: {
            attachmentMaxMb: 100,
            attachmentTotalMb: 120,
            attachmentMaxCount: 20,
            imageMaxMb: 20,
            attachmentLimitMinMb: 1,
            attachmentLimitMaxMb: 200,
          },
        });
      if (p === "/api/me/prefs")
        return json(res, {
          prefs: {
            lastProjectId: "preview",
            companyMode: false,
            credentialGuideSeen: true,
          },
        });
      if (p === "/api/projects")
        return json(res, {
          projects: [
            { projectId: "preview", name: "测试智能体", role: "owner" },
          ],
        });
      if (p === "/api/events" || p.endsWith("/stream")) {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
        });
        res.write(": preview\n\n");
        return;
      }
      if (p.endsWith("/agents")) return json(res, { agents });
      if (p.endsWith("/machines")) return json(res, { machines: [] });
      if (p.endsWith("/workbenches")) return json(res, { workbenches: [] });
      if (p.endsWith("/sessions/batch")) return json(res, {
        results: (data.requests ?? []).map(({agentId}) => {
          const rows=agentId==='test_agent'?sessions:[];
          return {agentId,ok:true,sessions:rows,counts:{active:rows.length,subagent:0,schedule:0,benchmark:0,archived:0},workspaceCounts:{},workspaceLatest:{},workspaceLatestActive:{}};
        })
      });
      if (p.endsWith("/chat-defaults"))
        return json(res, {
          agentId: "test_agent",
          approvalMode: "allow-all",
          thinkingLevel: "medium",
        });
      if (p.endsWith("/models"))
        return json(res, {
          models: [model],
          defaultModel: { provider: model.provider, modelId: model.modelId },
        });
      if (p.endsWith("/config"))
        return json(res, {
          config: {
            model: {
              provider: "preview",
              modelId: "preview-model",
              thinkingLevel: "medium",
            },
            tools: {},
            skills: [],
            schedules: [],
          },
          editable: true,
        });
      if (p.endsWith("/skills"))
        return json(res, {
          skills: [
            { name: "test-case-writing", description: "测试用例编写" },
            { name: "api-testing", description: "接口测试" },
          ],
        });
      if (p.endsWith("/dirs")) {
        const path = u.searchParams.get("path") || "E:/";
        if (path.includes("invalid"))
          return json(
            res,
            { error: { code: "not_found", message: "目录不存在" } },
            404,
          );
        return json(res, {
          path,
          parent: path === "E:/" ? null : "E:/",
          entries:
            path === "E:/"
              ? [
                  { name: "QAWorkspaces", path: "E:/QAWorkspaces" },
                  { name: "测试资料", path: "E:/测试资料" },
                ]
              : [],
        });
      }
      if (p.endsWith("/sessions") && p.includes("/agents/")) {
        if (req.method === "POST") {
          const id = `preview-created-${++seq}`,
            s = {
              ...sessions[0],
              ...data,
              sessionId: id,
              title: "工程验证新任务",
              hasTrace: false,
              workspace: data.workspace || `E:/QAWorkspaces/${id}`,
              createdAt: new Date().toISOString(),
              lastActiveAt: new Date().toISOString(),
            };
          sessions.unshift(s);
          return json(res, { session: s });
        }
        const rows = p.includes("/test_agent/") ? sessions : [];
        return json(res, {
          sessions: rows,
          hasMore: false,
          total: rows.length,
          counts: {
            active: rows.length,
            subagent: 0,
            schedule: 0,
            benchmark: 0,
            archived: 0,
          },
          workspaceCounts: {},
          workspaceLatest: {},
        });
      }
      if (p.endsWith("/messages"))
        return json(res, {
          messages: [
            {
              type: "model_msg",
              timestamp: "2026-10-16T10:00:00Z",
              payload: {
                type: "text",
                role: "user",
                text: "根据需求梳理登录页面的测试用例",
              },
            },
            {
              type: "model_msg",
              timestamp: "2026-10-16T10:00:03Z",
              payload: {
                type: "text",
                role: "assistant",
                text: process.env.QA_PREVIEW_HUMAN_CARD === "1" ? "等待你完成登录，原任务和浏览器已保留，测试尚未完成。" : "已完成本轮测试用例梳理。\n\n- 覆盖正常登录、输入校验和登录状态。\n- 待确认：连续登录失败后的锁定规则。\n\n这是客户端工程预览中的合成对话，未执行产品测试。",
                stop_reason: "completed",
              },
            },
          ],
        });
      if (p.match(/^\/api\/sessions\/[^/]+$/))
        return json(res, {
          session:
            sessions.find((s) => s.sessionId === p.split("/")[3]) ||
            sessions[0],
        });
      if (
        p.match(/^\/api\/sessions\/[^/]+\/(input|message|send|turn|tasks)$/)
      ) {
        const id = p.split("/")[3];
        inputBySession.set(id, data);
        return json(res, { sessionId: id });
      }
      if (p.endsWith("/usage/errors"))
        return json(res, { items: [], total: 0 });
      if (p.endsWith("/schedules")) return json(res, { schedules: [] });
      if (p === "/api/terminals") return json(res, { terminals: [] });
      if (p.endsWith("/files/list"))
        return json(res, { entries: [], path: "" });
      if (p.endsWith("/files/stat")) return json(res, { existing: [] });
      if (p.endsWith("/usage")) return json(res, { groups: [], totals: {} });
      if (p.endsWith("/processes")) return json(res, { processes: [] });
      if (p.endsWith("/background-tasks"))
        return json(res, { processes: [], subagents: [] });
      if (p.endsWith("/organizations")) return json(res, { organizations: [] });
      if (p.includes("/update") || p.includes("/version"))
        return json(res, {
          mode: "none",
          version: JSON.parse(readFileSync(resolve(app,'package.json'),'utf8')).version,
          buildDate: null,
          status: "up_to_date",
          flow: { kind: "idle" },
        });
      unhandled.add(p);
      writeFileSync(
        resolve(out, "preview-unhandled.json"),
        JSON.stringify([...unhandled], null, 2),
      );
      return json(res, {});
    }
    if (p === "/__requests") return json(res, calls);
    if (p === "/assets/" + asset) {
      res.setHeader("content-type", "text/javascript");
      res.end(clientAssets().bundle);
      return;
    }
    if (p === "/assets/qa-delivery-ui.js") {
      res.setHeader("content-type", "text/javascript");
      res.end(clientAssets().module);
      return;
    }
    if (p.startsWith("/assets/") || p.endsWith(".svg")) {
      const file = resolve(web, "." + p);
      if (relative(web, file).startsWith("..")) return json(res, {}, 403);
      res.setHeader(
        "content-type",
        {
          ".js": "text/javascript",
          ".css": "text/css",
          ".svg": "image/svg+xml",
          ".woff2": "font/woff2",
        }[extname(file)] || "application/octet-stream",
      );
      res.end(readFileSync(file));
      return;
    }
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(
      clientAssets().html.replace('href="/penguin-logo.svg"', 'href="'+brandDataUrl(readFileSync(resolve(root, 'penguin/ui/aith-logo.svg'), 'utf8'))+'"').replace(
        "<title>PenguinHarness</title>",
        "<title>AITestHarness · 工程预览</title>",
      ),
    );
  } catch (e) {
    console.error(e.message);
    json(res, { error: { message: e.message } }, 500);
  }
});
server.listen(port, "127.0.0.1", () =>
  console.log(
    `Isolated UI preview (synthetic API only): http://127.0.0.1:${server.address().port}/chat/new`,
  ),
);
