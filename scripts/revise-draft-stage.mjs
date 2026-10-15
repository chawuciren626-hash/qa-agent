import { resolve } from 'node:path';
import { reviseDraftStage } from './draft-stage-revision.mjs';

const [runId,stage,parentId,reason,...extra]=process.argv.slice(2);
if(extra.length) throw new Error('Unexpected revision arguments');
const result=reviseDraftStage(resolve(import.meta.dirname,'..'),runId,stage,parentId,reason);
console.log(JSON.stringify(result));
if(result.status==='ineligible') process.exitCode=2;
