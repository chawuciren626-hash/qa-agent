import { dataPath } from './directory-context.mjs';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { summarizeRun } from './run-status-summary.mjs';
import { browserWaiting } from './browser-task-resume.mjs';

const [runId, ...extra] = process.argv.slice(2);
try {
  if (!/^run-[A-Za-z0-9-]+$/.test(runId ?? '') || extra.length) throw new Error('Usage: show-run-status.mjs <run_id>');
  const root = resolve(import.meta.dirname, '..');
  const project = JSON.parse(readFileSync(resolve(root, 'config/project.json'), 'utf8'));
  const raw = readFileSync(dataPath(root, project.run_root, runId, 'manifest.json'));
  const result=summarizeRun(raw,runId);
  try {
    const waiting=browserWaiting(root,runId,JSON.parse(raw));
    if(waiting) {
      result.next_action='wait_for_human_intervention';
      result.human_intervention={kind:waiting.human_kind,question:waiting.question,browser_retained:true};
      result.user_summary=`已完成：已打开测试浏览器，当前交互进度已保留。\n产物：阶段结果尚未交付。\n需要你操作：${waiting.question}`;
    }
  } catch { /* Optional browser status cannot invalidate a readable run summary. */ }
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.log(JSON.stringify({ status: 'summary_unavailable', error: error.message, next_action: 'stop_and_request_review' }, null, 2));
  process.exitCode = 2;
}
