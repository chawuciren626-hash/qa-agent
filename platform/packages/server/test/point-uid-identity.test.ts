/**
 * G4：测试点的稳定身份（`point_uid`）。
 *
 * 这个文件钉两件事：
 *   1. **算 uid 的规则**——同内容同值、可调的属性不进身份、改一字就变；
 *   2. **迁移回填**——历史行按同一套规则补齐，不依赖外部文件，可重复执行。
 *
 * 规则本身用纯函数断言（快、无副作用）；只有"列在不在、回填对不对"需要真库。
 */
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SCHEMA_SQL } from "../src/db/schema.js";
import { pointUidColumn } from "../src/db/migrations/steps/2026-11-19-point-uid.js";
import { POINT_UID_LENGTH, duplicatePointReason, normalizePointText, pointUid, requirementRefsOf } from "../src/services/qa-point-identity.js";

const documentRef = (documentId: string, revision = 1) => ({ type: "document" as const, documentId, revision, section: "1.1", quote: "原文" });
const ruleRef = (ruleId: string) => ({ type: "rule" as const, ruleId, version: 1 });

describe("point_uid 计算规则", () => {
  it("同样的需求引用 + 模块 + 功能 + 描述，算出同一个值", () => {
    const input = { module: "登录", feature: "验证码锁定", description: "连续 5 次错误后锁定 15 分钟", evidenceRefs: [documentRef("doc-1")] };
    expect(pointUid(input)).toBe(pointUid({ ...input }));
    expect(pointUid(input)).toHaveLength(POINT_UID_LENGTH);
    expect(pointUid(input)).toMatch(/^[0-9a-f]{32}$/);
  });

  it("归一化只做无损处理：全角半角、大小写、空白折叠都算同一个点", () => {
    const base = { module: "Login", feature: "Captcha", description: "Lock after 5 failures", evidenceRefs: [] };
    expect(pointUid(base)).toBe(pointUid({ ...base, module: "Ｌｏｇｉｎ" }));
    expect(pointUid(base)).toBe(pointUid({ ...base, description: "Lock   after\t5  failures " }));
    expect(normalizePointText("  Ａ  b\tc  ")).toBe("a b c");
  });

  it("改一个字就是另一个测试点——宁可多一条，不可误合并", () => {
    const base = { module: "登录", feature: "验证码锁定", description: "连续 5 次错误后锁定 15 分钟", evidenceRefs: [documentRef("doc-1")] };
    expect(pointUid(base)).not.toBe(pointUid({ ...base, description: "连续 5 次错误后锁定 30 分钟" }));
    expect(pointUid(base)).not.toBe(pointUid({ ...base, module: "注册" }));
    // 需求来源不同也是不同测试点：两个模块下描述字面相同的边界点必须分开
    expect(pointUid(base)).not.toBe(pointUid({ ...base, evidenceRefs: [documentRef("doc-2")] }));
    // 同一 id 但类型不同不共身份（document:doc-1 ≠ rule:doc-1）
    expect(pointUid(base)).not.toBe(pointUid({ ...base, evidenceRefs: [ruleRef("doc-1")] }));
  });

  it("需求引用只认来源 id，升版与引用位置变动都不改变身份", () => {
    expect(requirementRefsOf([documentRef("doc-1", 1)])).toEqual(requirementRefsOf([documentRef("doc-1", 7)]));
    expect(requirementRefsOf([documentRef("doc-1", 1)])).toEqual(["document:doc-1"]);
    expect(requirementRefsOf([ruleRef("rule-9"), documentRef("doc-1")])).toEqual(["document:doc-1", "rule:rule-9"]);
    // 非需求类引用（执行证据）不参与身份：否则重跑一次就换一个身份
    expect(requirementRefsOf([{ type: "execution", sessionId: "s", runId: "r", evidencePath: "a.png" } as never])).toEqual([]);
  });

  it("批次内撞 uid：描述一致算重复设计，只有归一化后一撞才算冲突", () => {
    const left = { module: "登录", feature: "锁定", description: "连续 5 次错误后锁定", evidenceRefs: [] };
    expect(duplicatePointReason(left, { ...left })).toBe("identical");
    expect(duplicatePointReason(left, { ...left, description: "连续 5 次错误后锁定  " })).toBe("identical");
    expect(duplicatePointReason(left, { ...left, description: "连续 5 次错误后锁定账号" })).toBeNull();
  });
});

describe("point_uid 迁移", () => {
  let db: DatabaseSync;

  const columns = (table: string) => (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(item => item.name);

  const insertPoint = (rowId: string, pointKey: string, description: string, evidenceRefsJson: string) => {
    db.prepare(`INSERT INTO qa_test_points
      (row_id, batch_id, project_id, point_key, module, feature, description, risk, coverage_type_json, evidence_refs_json, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
      rowId, "batch-g4", "proj_g4", pointKey, "登录", "锁定", description, "high", "[]", evidenceRefsJson, "2026-11-19T00:00:00Z",
    );
  };

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    db.exec(SCHEMA_SQL);
    // 模拟"迁移之前"的库：SCHEMA_SQL 是最新形态，先把这两列去掉
    db.exec("ALTER TABLE qa_test_points DROP COLUMN point_uid");
    db.exec("ALTER TABLE qa_defects DROP COLUMN related_points_json");
    db.exec("INSERT INTO users(user_id, password_hash, is_admin, created_at) VALUES ('owner1','x',0,'2026-01-01')");
    db.exec("INSERT INTO projects(project_id, owner_user_id, created_at) VALUES ('proj_g4','owner1','2026-01-01')");
    db.prepare(`INSERT INTO qa_design_batches
      (batch_id, project_id, session_id, run_id, revision, status, source_json, test_point_count, test_case_count, content_hash, created_at, created_by)
      VALUES ('batch-g4','proj_g4','session-1','run-1',1,'open','{}',3,0,'sha256:0','2026-11-19T00:00:00Z','owner1')`).run();
    insertPoint("row-1", "TP-001", "连续 5 次错误后锁定", JSON.stringify([documentRef("doc-1")]));
    insertPoint("row-2", "TP-002", "登录失败提示剩余次数", JSON.stringify([documentRef("doc-1")]));
    // 坏 JSON：不阻断迁移，按"没有需求引用"算（uid 仍确定，只是少了需求维度）
    insertPoint("row-3", "TP-003", "审计日志落库", "{坏掉的 json");
  });

  afterEach(() => db.close());

  it("加列并回填历史行，用的是与新增时同一套规则", () => {
    expect(columns("qa_test_points")).not.toContain("point_uid");
    pointUidColumn.up!(db);
    expect(columns("qa_test_points")).toContain("point_uid");
    expect(columns("qa_defects")).toContain("related_points_json");

    const rows = db.prepare("SELECT point_key, point_uid FROM qa_test_points ORDER BY point_key").all() as { point_key: string; point_uid: string }[];
    expect(rows.map(row => row.point_uid)).toEqual([
      pointUid({ module: "登录", feature: "锁定", description: "连续 5 次错误后锁定", evidenceRefs: [documentRef("doc-1")] as never }),
      pointUid({ module: "登录", feature: "锁定", description: "登录失败提示剩余次数", evidenceRefs: [documentRef("doc-1")] as never }),
      pointUid({ module: "登录", feature: "锁定", description: "审计日志落库", evidenceRefs: [] }),
    ]);
    // 索引建在 (project_id, point_uid)：覆盖率与缺陷挂点都按这两列找同一测试点的所有批次
    const indexes = (db.prepare("PRAGMA index_list(qa_test_points)").all() as { name: string }[]).map(item => item.name);
    expect(indexes).toContain("idx_qa_test_points_uid");
  });

  it("可重复执行，已回填的值不被改写", () => {
    pointUidColumn.up!(db);
    db.prepare("UPDATE qa_test_points SET point_uid=? WHERE row_id=?").run("f".repeat(POINT_UID_LENGTH), "row-1");
    pointUidColumn.up!(db);
    expect(db.prepare("SELECT point_uid FROM qa_test_points WHERE row_id=?").get("row-1")).toEqual({ point_uid: "f".repeat(POINT_UID_LENGTH) });
  });

  it("回滚只丢这两列，行与批次都还在", () => {
    pointUidColumn.up!(db);
    pointUidColumn.down!(db);
    expect(columns("qa_test_points")).not.toContain("point_uid");
    expect(columns("qa_defects")).not.toContain("related_points_json");
    expect(db.prepare("SELECT COUNT(*) AS n FROM qa_test_points").get()).toEqual({ n: 3 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM qa_design_batches").get()).toEqual({ n: 1 });
  });
});
