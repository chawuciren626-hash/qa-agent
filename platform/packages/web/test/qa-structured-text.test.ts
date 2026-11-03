import { expect, it } from "vitest";
import { breakNumberedItems } from "../src/features/qa/structured-text";
import { localizedValue } from "../src/features/qa/stage-localization";

it("puts numbered steps and recommendations on separate lines without changing ordinary prose", () => {
  expect(breakNumberedItems("1.打开登录页；2.输入账号密码；3.点击登录。"))
    .toBe("1.打开登录页\n2.输入账号密码\n3.点击登录。");
  expect(breakNumberedItems("1.确认账号；2.排查接口；3.重新执行"))
    .toBe("1.确认账号\n2.排查接口\n3.重新执行");
  expect(breakNumberedItems("版本 1.2；延迟 2.5 秒")).toBe("版本 1.2；延迟 2.5 秒");
});

it("localizes defect metadata and activity codes", () => {
  expect(localizedValue("product_defect")).toBe("产品缺陷");
  expect(localizedValue("draft")).toBe("草稿");
  expect(localizedValue("Critical")).toBe("严重");
  expect(localizedValue("confirmation_requested")).toBe("已发起确认");
});
