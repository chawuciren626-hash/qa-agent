import { ensureColumn } from "../../database.js";
import type { Migration } from "../migration.js";

/**
 * G9（P6）：地图也要有版本号。
 *
 * 在此之前 `project_environments` 只记 `maps_path`——地图文件的**位置**。路径没变而内容
 * 变了（重新探索、页面改版），库里一点痕迹都没有，于是：
 *   - 按旧地图写出来的 plan 无法判断是否过期，只能靠人记得"上周地图更新过"；
 *   - 想批量问"哪些计划的地图版本已经不是当前环境了"，没有任何一列可以比。
 *
 * `maps_hash` 记的是**地图内容的 sha256**（不是文件 mtime：重建一次内容没变就不该算版本变更；
 * 也不是 maps_path 的哈希：换路径但内容相同仍是同一版地图）。
 *
 * 回填策略：历史行为 NULL，而不是拿当前文件倒推一个值。"当时的地图是什么"无法从现在的
 * 文件还原，倒推会把"不知道"伪装成"已知且一致"——比留空更糟。NULL 的语义是"这一行还没
 * 登记过地图版本"，读的时候按 `unknown` 处理，与 `versionStatus` 同款三态。
 *
 * 只做判别不对它设闸：地图变了不代表环境坏了（这是资产版本，不是环境指纹）。判定 stale
 * 只在两个检查点做——plan 固化点与执行前置——不在每次读地图时算 hash（每次读都重算，
 * 成本高且会误伤正在跑的任务）。
 */
export const mapsHash: Migration = {
  name: "2026-11-19-maps-hash",
  swapSafe: true,
  up(db) {
    ensureColumn(db, "project_environments", "maps_hash", "TEXT");
  },
  down(db) {
    db.exec("ALTER TABLE project_environments DROP COLUMN maps_hash");
  },
};
