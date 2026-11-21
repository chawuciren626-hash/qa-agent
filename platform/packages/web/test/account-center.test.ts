import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { accountSurface } from "../src/pages/integrated-account";
import { AccountCenter } from "../src/pages/account-center";

describe("embedded user management", () => {
  it("does not show the account-center login screen while checking the session", () => {
    const html = renderToStaticMarkup(createElement(AccountCenter, { registrationEnabled: false }));
    expect(html).toContain("正在加载用户管理");
    expect(html).not.toContain("正在检查登录状态");
    expect(html).not.toContain("登录后管理你的账号");
  });
});

describe("client server-account login", () => {
  it("uses the account login design for configured clients and blocks legacy fallback when configuration is missing", () => {
    expect(accountSurface({enabled:true})).toBe("server");
    expect(accountSurface({enabled:false,required:true})).toBe("unconfigured");
    expect(accountSurface({enabled:false})).toBe("legacy");
    const html = renderToStaticMarkup(createElement(AccountCenter, { registrationEnabled:false, integrated:true, apiBase:"/api/account-client" }));
    expect(html).toContain("ac-login-view");
    expect(html).toContain("管理员分配的账号登录客户端");
    expect(html).not.toContain("reset-admin-password");
    expect(html).not.toContain("注册并登录");
  });
});
