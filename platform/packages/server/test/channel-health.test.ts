/**
 * Channel health：把"管理端点过检测"变成运行期读得到的事实（P5 §6.2）。
 *
 * 三条断言各自挡一种静默失败：
 *   1. 没有 engine root 时**不写也不假装写**（否则页面显示"已记录"，运行期永远读不到）；
 *   2. 同一个 (baseUrl, protocol) 覆盖而不是追加（否则刷新十次就有十条"历史"，谁也看不出当前状态）；
 *   3. 文件损坏时读回空而不是抛错（健康状态坏了不该把管理页拖下水），但 `updatedAt: null`
 *      要说出来——"没有数据"和"数据读不出来"必须能区分。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CHANNEL_HEALTH_LIMIT,
  CHANNEL_HEALTH_PATH,
  readChannelHealth,
  recordChannelHealth,
} from "../src/services/channel-health.js";

let root: string | null = null;
const previous = process.env.AITEST_ENGINE_ROOT;

function useEngineRoot(): string {
  root = mkdtempSync(join(tmpdir(), "aitest-health-"));
  process.env.AITEST_ENGINE_ROOT = root;
  return root;
}

beforeEach(() => {
  delete process.env.AITEST_ENGINE_ROOT;
});

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = null;
  if (previous === undefined) delete process.env.AITEST_ENGINE_ROOT;
  else process.env.AITEST_ENGINE_ROOT = previous;
});

describe("channel health", () => {
  it("没有 engine root：不记录、不创建文件，并且说清楚原因", () => {
    const result = recordChannelHealth({ projectId: "p1", baseUrl: "https://api.example", protocol: "openai-chat", probes: [], source: "detect" });
    expect(result).toEqual({ recorded: false, reason: "engine_root_unset" });
    const reading = readChannelHealth("p1");
    expect(reading.enforced).toBe(false);
    expect(reading.reason).toBe("engine_root_unset");
    expect(reading.entries).toEqual([]);
  });

  it("记录后能读回，同一 baseUrl+protocol 覆盖而不是追加", () => {
    const dir = useEngineRoot();
    recordChannelHealth({ projectId: "p1", baseUrl: "https://api.example/v1", protocol: "openai-chat",
      probes: [{ clientType: "openai-chat", url: "https://api.example/v1/chat/completions", outcome: "served", status: 401 }], source: "detect" });
    recordChannelHealth({ projectId: "p1", baseUrl: "https://api.example/v1", protocol: "openai-chat",
      probes: [], source: "test", status: "reachable" });
    const reading = readChannelHealth("p1");
    expect(reading.enforced).toBe(true);
    expect(reading.path).toBe(CHANNEL_HEALTH_PATH);
    expect(reading.entries).toHaveLength(1);
    // 后一次是真实连通测试（更强信号），应覆盖前一次的探测结论
    expect(reading.entries[0]!.status).toBe("reachable");
    expect(reading.entries[0]!.source).toBe("test");
    expect(existsSync(join(dir, CHANNEL_HEALTH_PATH))).toBe(true);
  });

  it("不同协议是不同条目：同一地址可能同时提供两套协议", () => {
    useEngineRoot();
    recordChannelHealth({ projectId: "p1", baseUrl: "https://api.example", protocol: "openai-chat", probes: [], source: "detect" });
    recordChannelHealth({ projectId: "p1", baseUrl: "https://api.example", protocol: "ant-messages", probes: [], source: "detect" });
    expect(readChannelHealth("p1").entries).toHaveLength(2);
  });

  it("只保留最近 50 条：健康文件不能无限长", () => {
    useEngineRoot();
    for (let index = 0; index < CHANNEL_HEALTH_LIMIT + 5; index += 1) {
      recordChannelHealth({ projectId: "p1", baseUrl: `https://api-${index}.example`, protocol: "openai-chat", probes: [], source: "detect" });
    }
    expect(readChannelHealth("p1").entries).toHaveLength(CHANNEL_HEALTH_LIMIT);
  });

  it("文件损坏：读回空且 updatedAt 为 null，不抛错", () => {
    const dir = useEngineRoot();
    mkdirSync(join(dir, "output/runtime"), { recursive: true });
    writeFileSync(join(dir, CHANNEL_HEALTH_PATH), "{ not json");
    const reading = readChannelHealth("p1");
    expect(reading.enforced).toBe(true);
    expect(reading.entries).toEqual([]);
    expect(reading.updatedAt).toBeNull();
    // 写入仍然可用：坏文件被整体替换，而不是让它永远坏着
    recordChannelHealth({ projectId: "p1", baseUrl: "https://api.example", protocol: "openai-chat", probes: [], source: "detect" });
    expect(JSON.parse(readFileSync(join(dir, CHANNEL_HEALTH_PATH), "utf8")).projects.p1).toHaveLength(1);
  });

  it("项目之间互不可见", () => {
    useEngineRoot();
    recordChannelHealth({ projectId: "p1", baseUrl: "https://a.example", protocol: "openai-chat", probes: [], source: "detect" });
    expect(readChannelHealth("p2").entries).toEqual([]);
  });
});
