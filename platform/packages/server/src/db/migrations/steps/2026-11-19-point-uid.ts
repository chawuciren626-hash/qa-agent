import { ensureColumn } from "../../database.js";
import type { Migration } from "../migration.js";
import { pointUid } from "../../../services/qa-point-identity.js";

/**
 * G4（P6）：测试点获得跨批次稳定身份。
 *
 * 原有身份是 `(batch_id, point_key)`：每批重新编号，同一件事在两个批次里是两条互不相认的
 * 记录。于是"这条缺陷属于哪个测试点""这个点上一轮跑过没有""项目级覆盖了多少"三问只能
 * 靠人比对标题，而人比对的结论不积累——这正好是"跑得越多不一定越省力"的根因之一。
 *
 * 回填只补 `point_uid IS NULL` 的行，可重复执行。回填用的输入全部来自库里已有的列
 * （module / feature / description / evidence_refs），不依赖外部文件：迁移跑完之后
 * 历史批次与新批次算出的 uid 是同一套规则，不会出现"老数据一套、新数据一套"。
 *
 * 同一迁移里给 `qa_defects` 加 `related_points_json`：缺陷只记 `related_cases_json` 时，
 * 换个批次「这条缺陷属于哪个测试点」就断了。历史缺陷的 `related_points_json` 留空数组
 * （当时没记 uid，倒推不出可靠的归属），新缺陷在写入时按 run → batch → case → point 算出。
 *
 * **回填会留下一种真实情况**：早期批次的证据引用可能缺 `documentId`（只有 description），
 * 于是同一测试点在早期批次与现在算出的 uid 不同。这不是 bug，是当时没记来源的代价；
 * 处理方法写进文档——按 uid 分组时看不到老批次的那一条，而不是把它硬合并到某个新 uid 上。
 * 硬合并的危险在于：一旦合错，缺陷归属就永久错了，而且没有任何痕迹。
 */
export const pointUidColumn: Migration = {
  name: "2026-11-19-point-uid",
  swapSafe: true,
  up(db) {
    ensureColumn(db, "qa_test_points", "point_uid", "TEXT");
    // 缺陷挂测试点（同一件事的另一半）：缺陷原来只记 related_cases_json，而 case_key 是
    // 批次内的编号——换个批次，「这条缺陷属于哪个测试点」就断了。存 uid 数组后才能
    // 跨批次问"这个测试点历史上出过几次缺陷"。
    ensureColumn(db, "qa_defects", "related_points_json", "TEXT NOT NULL DEFAULT '[]'");
    // 覆盖率与缺陷挂点都是"按 uid 找同一测试点的所有批次"，没有这条索引就退化成全表扫。
    db.exec("CREATE INDEX IF NOT EXISTS idx_qa_test_points_uid ON qa_test_points(project_id, point_uid)");

    const rows = db.prepare(
      `SELECT row_id, module, feature, description, evidence_refs_json
         FROM qa_test_points WHERE point_uid IS NULL OR point_uid=''`,
    ).all() as { row_id: string; module: string; feature: string; description: string; evidence_refs_json: string }[];
    if (rows.length === 0) return;
    const update = db.prepare("UPDATE qa_test_points SET point_uid=? WHERE row_id=?");
    for (const row of rows) {
      let evidenceRefs: unknown = [];
      try {
        const parsed = JSON.parse(row.evidence_refs_json || "[]");
        evidenceRefs = Array.isArray(parsed) ? parsed : [];
      } catch {
        // 坏 JSON 不阻断迁移：这一行按"没有需求引用"算，uid 仍是确定的（只是少了需求维度）
        evidenceRefs = [];
      }
      update.run(
        pointUid({
          module: row.module,
          feature: row.feature,
          description: row.description,
          evidenceRefs: evidenceRefs as never,
        }),
        row.row_id,
      );
    }
  },
  down(db) {
    // 索引引用该列，必须先删索引再删列（SQLite 的 DROP COLUMN 不会替你处理）。
    db.exec("DROP INDEX IF EXISTS idx_qa_test_points_uid");
    db.exec("ALTER TABLE qa_test_points DROP COLUMN point_uid");
    db.exec("ALTER TABLE qa_defects DROP COLUMN related_points_json");
  },
};
