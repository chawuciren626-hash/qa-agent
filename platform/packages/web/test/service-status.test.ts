import { expect, it } from "vitest";
import { serviceStatusViewModel } from "../src/pages/service-status.js";

const base = { enabled: true, origin: "http://center.local" };

it("shows the last verified publication while offline", () => {
  const view = serviceStatusViewModel({
    ...base,
    sync: {
      state: "offline", connection: "offline",
      publication: { setHash: "sha256:x", agents: [{ agentId: "qa", version: 2 }] },
      update: { state: "offline", errorCode: "catalog_unavailable", message: "无法连接资源目录" },
      offlineUsable: [{ agentId: "qa", version: 2 }],
    },
  });
  expect(view.connection).toBe("服务端不可用");
  expect(view.publication).toBe("当前发布：qa v2");
  expect(view.update).toContain("无法连接资源目录");
  expect(view.offline).toBe("离线可用：qa v2");
});

it("explains an update failure without claiming a new publication", () => {
  const view = serviceStatusViewModel({
    ...base,
    sync: {
      state: "update_failed", connection: "online",
      publication: { setHash: "sha256:old", agents: [{ agentId: "qa", version: 1 }] },
      update: { state: "update_failed", errorCode: "verification_failed", message: "发布内容校验失败" },
      offlineUsable: [{ agentId: "qa", version: 1 }],
    },
  });
  expect(view.publication).toBe("当前发布：qa v1");
  expect(view.update).toContain("发布内容校验失败");
});
