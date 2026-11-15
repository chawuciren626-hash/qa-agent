import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AccountCenter } from "../src/pages/account-center";

describe("embedded user management", () => {
  it("does not show the account-center login screen while checking the session", () => {
    const html = renderToStaticMarkup(createElement(AccountCenter, { registrationEnabled: false }));
    expect(html).toContain("正在加载用户管理");
    expect(html).not.toContain("正在检查登录状态");
    expect(html).not.toContain("登录后管理你的账号");
  });
});
