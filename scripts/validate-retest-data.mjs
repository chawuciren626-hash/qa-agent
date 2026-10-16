import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const casesPath = resolve(root, "output/runs/run-2026-09-29-test-management/design/test_cases.json");
const cases = JSON.parse(readFileSync(casesPath, "utf8"));
const retestIds = new Set([
  "TC-L-08","TC-L-09","TC-L-13","TC-L-17","TC-L-19","TC-L-20","TC-L-21",
  "TC-S-01",
  "TC-U-03","TC-U-07","TC-U-08","TC-U-09","TC-U-10","TC-U-11",
  "TC-U-14","TC-U-15","TC-U-16","TC-U-17","TC-U-18",
  "TC-U-22","TC-U-23","TC-U-25","TC-U-26","TC-U-28","TC-U-29","TC-U-30","TC-U-31",
  "TC-U-32","TC-U-33","TC-U-34","TC-U-35","TC-U-36","TC-U-39"
]);

const selected = cases.filter(c => retestIds.has(c.case_id));
const errors = [];
const seenAccounts = new Set();

function chkLen(val, max, label) {
  if (typeof val === "string" && val.length > max) errors.push(`${label} 长度 ${val.length} 超过上限 ${max}`);
}
function chkAccount(acc) {
  if (!/^[A-Za-z0-9]{1,8}$/.test(acc)) errors.push(`账号 ${acc} 不符合 /^[A-Za-z0-9]{1,8}$/（仅数字或字母，1-8位）`);
}
function chkPhone(phone) {
  if (phone && !/^1[3-9]\d{9}$/.test(phone)) errors.push(`手机号 ${phone} 不符合 /^1[3-9]\\d{9}$/`);
}
function chkEmail(email) {
  if (email && !/^[A-Za-z0-9._%+-]+@[A-Za-z0-9\-]+(\.[A-Za-z0-9\-]+)*\.[A-Za-z]{2,}$/.test(email)) errors.push(`邮箱 ${email} 格式不正确`);
}

for (const c of selected) {
  const d = c.test_data || {};
  const account = d.account || d.user?.account || d.duplicate_account || d.target_user || d.non_exist_account;
  if (account) { chkLen(account, 8, "账号"); chkAccount(account); }
  if (d.password !== undefined) chkLen(String(d.password), 10, "密码");
  if (d.phone) { chkLen(d.phone, 11, "手机号"); chkPhone(d.phone); }
  if (d.email) { chkLen(d.email, 50, "邮箱"); chkEmail(d.email); }
  if (d.nickname !== undefined) chkLen(String(d.nickname), 20, "昵称");
  if (d.remark !== undefined) chkLen(String(d.remark), 100, "备注");
  if (d.user?.nickname) chkLen(d.user.nickname, 20, "昵称");
  if (d.user?.phone) { chkLen(d.user.phone, 11, "手机号"); chkPhone(d.user.phone); }
  if (d.user?.email) { chkLen(d.user.email, 50, "邮箱"); chkEmail(d.user.email); }
  if (d.user?.remark) chkLen(d.user.remark, 100, "备注");

  // uniqueness check for accounts used in add operations (exclude intentional duplicates like 'admin')
  if (account && !['admin','tester01','user02'].includes(account)) {
    if (seenAccounts.has(account)) {
      errors.push(`账号 ${account} 在多个用例中重复使用`);
    } else {
      seenAccounts.add(account);
    }
  }
}

if (errors.length) {
  console.error("测试数据校验发现以下问题（仍继续执行，以便复现实际行为）：");
  for (const e of errors) console.error(" - " + e);
  process.exit(0);
} else {
  console.log(`测试数据校验通过，共 ${selected.length} 条用例。`);
  process.exit(0);
}
