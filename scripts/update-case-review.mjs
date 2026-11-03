import { resolve } from 'node:path';
import { updateCaseReview } from './case-review.mjs';
const input=JSON.parse(process.env.QA_CASE_REVIEW ?? 'null');
if (!input || !/^run-[A-Za-z0-9-]+$/.test(input.runId) || !/^session-[A-Za-z0-9-]+$/.test(input.sessionId)) throw Error('任务标识无效');
console.log(JSON.stringify(updateCaseReview(resolve(import.meta.dirname,'..'),input)));
