import type { Migration } from "../migration.js";

/**
 * 客户端登录直连改造（M-A 清理）：登录不再派生本地映射用户（acct_<哈希>），
 * 本地 principal 直接使用中央 userId。本迁移清理历史遗留：
 *
 * 1. demo 种子任务：旧版本任务列表切片的演示数据（source_system='demo'），
 *    真实数据由任务平台同步层下发，保留会与真数据混淆 —— 整体删除；
 * 2. 依赖 demo 行的本地附件同步删除；
 * 3. acct_* 映射用户与项目**不自动删除**（可能挂有用户本地工作数据），
 *    仅由管理员决定处置；绑定表照旧保留（迁移审计依据）。
 *
 * RE-RUNNABLE：全部条件删除 + 条件索引，重复执行无副作用。
 */
export const accountIdentityDirectMigration: Migration = {
  name: "2026-11-23-account-identity-direct",
  swapSafe: true,
  up(db) {
    // 1) demo 种子任务的本地附件
    db.exec(`
      DELETE FROM qa_task_attachments
       WHERE task_source = 'platform'
         AND task_id IN (SELECT link_id FROM platform_task_links WHERE source_system = 'demo');
    `);
    // 2) demo 种子任务本身
    db.exec(`
      DELETE FROM platform_task_links WHERE source_system = 'demo';
    `);
    // 3) 传输层孤儿包接收记录（demo 只在展示表；此处仅清理无对应任务映射的孤儿，防回填阶段复活假数据）
    db.exec(`
      DELETE FROM task_platform_packages
       WHERE task_link_id NOT IN (SELECT link_id FROM task_platform_task_links);
    `);
  },
  down(db) {
    // demo 种子由代码（seedDemoIfEmpty）可再生，无需数据恢复
    db.exec("SELECT 1");
  },
};
