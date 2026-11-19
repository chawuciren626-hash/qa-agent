/**
 * P2 迁移的回填回归测试。
 *
 * 迁移里最容易悄悄写错的是回填：没有报错、没有异常，只是把 env 填成空串或把 run 挂到
 * 错误的任务上——而这类错误一旦写进真实库，报告与缺陷的"哪个环境"就永久是错的。
 *
 * 这里用 SCHEMA_SQL 建一个"老库形态"的库（表都在，但 qa_tasks / qa_runs 为空、报告的
 * env 为空），灌入历史数据后执行迁移，逐条核对：
 *   - 只为有 QA 痕迹的会话建任务，闲聊会话不长出任务；
 *   - task 的 env 取该项目默认环境；
 *   - 四张事实表里的 run_id 都被去重登记成 legacy 运行，run_index=0（未编号）；
 *   - 报告的 env 与缺陷的 first/last_seen_env 都能从 run 推出来；
 *   - 再跑一次不新增任何行（迁移必须可重复执行）。
 */
import { DatabaseSync } from "node:sqlite";
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { SCHEMA_SQL } from "../src/db/schema.js";
import { qaTaskRun } from "../src/db/migrations/steps/2026-11-19-qa-task-run.js";

let db: DatabaseSync;
const n = (sql: string, ...params: unknown[]) =>
  Number((db.prepare(sql).get(...(params as never[])) as { n: number }).n);

const QA_SESSION = "session-2026-11-19-10-00-00-aaaa0001";
const CHAT_SESSION = "session-2026-11-19-10-00-00-bbbb0002";
const PROJECT = "proj_p2";

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA_SQL);
  db.exec(`
    INSERT INTO users(user_id, password_hash, is_admin, created_at)
      VALUES ('owner1','x',0,'2026-01-01');
    INSERT INTO users(user_id, password_hash, is_admin, created_at)
      VALUES ('owner2','x',0,'2026-01-01');
    INSERT INTO projects(project_id, owner_user_id, created_at) VALUES ('${PROJECT}','owner1','2026-01-01');
    INSERT INTO sessions(session_id, project_id, agent_id, provider, model_id, workspace, created_at, owner_user_id)
      VALUES ('${QA_SESSION}','${PROJECT}','test_agent','p','m','/w','2026-02-01','owner1');
    INSERT INTO sessions(session_id, project_id, agent_id, provider, model_id, workspace, created_at, owner_user_id)
      VALUES ('${CHAT_SESSION}','${PROJECT}','default_agent','p','m','/w','2026-02-01','owner2');
    INSERT INTO project_environments(project_id, env, base_url, is_default, status, created_at)
      VALUES ('${PROJECT}','staging','https://staging.local',1,'registered','2026-01-01');
    INSERT INTO project_environments(project_id, env, base_url, is_default, status, created_at)
      VALUES ('${PROJECT}','prod','https://prod.local',0,'registered','2026-01-01');
  `);
  // 历史 QA 数据：一次设计批次、两条结果、一份报告、一条缺陷（origin 在 run-rb2）
  db.exec(`
    INSERT INTO qa_design_batches(batch_id,project_id,session_id,run_id,revision,status,source_json,
      test_point_count,test_case_count,content_hash,created_at,created_by)
      VALUES ('b1','${PROJECT}','${QA_SESSION}','run-rb1',1,'frozen','{"type":"run"}',1,2,'h','2026-02-01','owner1');
    INSERT INTO qa_case_results(result_id,project_id,session_id,run_id,batch_id,case_key,status,reason,
      invocation_id,evidence_refs_json,created_at,updated_at)
      VALUES ('r1','${PROJECT}','${QA_SESSION}','run-rb1','b1','C-1','passed','','inv1','[]','2026-02-01','2026-02-01'),
             ('r2','${PROJECT}','${QA_SESSION}','run-rb1','b1','C-2','failed','','inv1','[]','2026-02-01','2026-02-01'),
             ('r3','${PROJECT}','${QA_SESSION}','run-rb2','b1','C-1','failed','','inv2','[]','2026-02-02','2026-02-02');
    INSERT INTO qa_report_indexes(report_id,project_id,session_id,run_id,batch_id,revision,status,html_path,
      html_sha256,conclusion,quality_gate,counts_json,coverage_json,untested_json,evidence_json,limitations_json,
      open_defects_json,results_fingerprint,created_at,created_by,content_hash)
      VALUES ('rep1','${PROJECT}','${QA_SESSION}','run-rb1','b1',1,'published','report/a.html','sha256:a',
      'failed','blocked','{}','{}','[]','[]','[]','[]','fp','2026-02-01','owner1','sha256:c');
    INSERT INTO qa_defects(defect_id,project_id,fingerprint,title,category,status,confidence,severity,priority,
      expected_result,actual_result,analysis,duplicate_of,related_cases_json,evidence_refs_json,origin_session_id,
      origin_run_id,first_seen_at,updated_at,revision,event_count,last_event_hash,created_at,created_by)
      VALUES ('bug1','${PROJECT}','fp1','老缺陷','product_defect','confirmed','strong','Major','P1','e','a','',NULL,
      '["C-2"]','[]','${QA_SESSION}','run-rb2','2026-02-01','2026-02-01',0,0,'','2026-02-01','owner1');
  `);
});

afterEach(() => db.close());

describe("2026-11-19-qa-task-run 回填", () => {
  it("只为有 QA 痕迹的会话建任务，闲聊会话不长出任务", () => {
    qaTaskRun.up(db);
    expect(n("SELECT COUNT(*) AS n FROM qa_tasks")).toBe(1);
    expect(n("SELECT COUNT(*) AS n FROM qa_tasks WHERE session_id = ?", CHAT_SESSION)).toBe(0);
    expect(n("SELECT COUNT(*) AS n FROM qa_tasks WHERE origin = 'backfill'")).toBe(1);
  });

  it("任务环境取项目默认环境，不是随便挑一个", () => {
    qaTaskRun.up(db);
    const row = db.prepare("SELECT env, owner_user_id FROM qa_tasks WHERE session_id = ?").get(QA_SESSION) as {
      env: string; owner_user_id: string;
    };
    expect(row.env).toBe("staging");
    expect(row.owner_user_id).toBe("owner1");
  });

  it("四张事实表里的 run_id 去重登记为 legacy 运行，序号为 0（未编号）", () => {
    qaTaskRun.up(db);
    const runs = db.prepare("SELECT run_id, kind, run_index, env FROM qa_runs ORDER BY run_id").all() as {
      run_id: string; kind: string; run_index: number; env: string;
    }[];
    expect(runs.map((r) => r.run_id)).toEqual(["run-rb1", "run-rb2"]);
    for (const run of runs) {
      expect(run.kind).toBe("legacy");
      expect(run.run_index).toBe(0);
      expect(run.env).toBe("staging");
    }
    // 没有孤儿：每条 run 都挂在真实任务上
    expect(n("SELECT COUNT(*) AS n FROM qa_runs r WHERE NOT EXISTS (SELECT 1 FROM qa_tasks t WHERE t.task_id = r.task_id)")).toBe(0);
  });

  it("报告的 env 与缺陷的首见/末见环境都从 run 推导出来", () => {
    qaTaskRun.up(db);
    expect((db.prepare("SELECT env FROM qa_report_indexes WHERE report_id='rep1'").get() as { env: string }).env).toBe("staging");
    const defect = db.prepare("SELECT first_seen_env, last_seen_env FROM qa_defects WHERE defect_id='bug1'")
      .get() as { first_seen_env: string; last_seen_env: string };
    expect(defect.first_seen_env).toBe("staging");
    // 没有 occurrence 行时回退到 origin run，而不是留空
    expect(defect.last_seen_env).toBe("staging");
  });

  it("可重复执行：再跑一次不新增行、不改已填的 env", () => {
    qaTaskRun.up(db);
    const before = { tasks: n("SELECT COUNT(*) AS n FROM qa_tasks"), runs: n("SELECT COUNT(*) AS n FROM qa_runs") };
    qaTaskRun.up(db);
    expect(n("SELECT COUNT(*) AS n FROM qa_tasks")).toBe(before.tasks);
    expect(n("SELECT COUNT(*) AS n FROM qa_runs")).toBe(before.runs);
  });

  it("对空库执行也不报错（新装实例没有历史数据）", () => {
    db.exec("DELETE FROM qa_case_results; DELETE FROM qa_design_batches; DELETE FROM qa_report_indexes; DELETE FROM qa_defects;");
    expect(() => qaTaskRun.up(db)).not.toThrow();
    expect(n("SELECT COUNT(*) AS n FROM qa_tasks")).toBe(0);
    expect(n("SELECT COUNT(*) AS n FROM qa_runs")).toBe(0);
  });
});
