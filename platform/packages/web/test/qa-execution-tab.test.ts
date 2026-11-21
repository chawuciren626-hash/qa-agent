import { describe, expect, it } from "vitest";
import { executionTabFor } from "../src/features/qa/task-detail";

describe("执行类型 tab 分流", () => {
  it("api_execution 一律归接口档", () => {
    expect(executionTabFor("api_execution", "web")).toBe("api");
    expect(executionTabFor("api_execution", "desktop")).toBe("api");
  });

  it("platform 决定执行档；desktop 是新增的桌面自动化档", () => {
    expect(executionTabFor("execution", "web")).toBe("web");
    expect(executionTabFor("execution", "android")).toBe("app");
    expect(executionTabFor("execution", "miniprogram")).toBe("miniprogram");
    expect(executionTabFor("execution", "desktop")).toBe("desktop");
    expect(executionTabFor("execution", "")).toBe("web");
  });
});
