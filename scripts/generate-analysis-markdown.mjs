import { existsSync, lstatSync, realpathSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { readRunFile, runDirectory } from './design-quality.mjs';
import { inspectRequirementLedger } from './requirement-provenance.mjs';
import { renderAnalysis } from './analysis-markdown.mjs';
import { publishAnalysisDraft } from './analysis-draft.mjs';

const [runId, ...extra] = process.argv.slice(2);
if (!runId || extra.length) throw new Error('Usage: generate-analysis-markdown.mjs <run_id>');
const root = resolve(import.meta.dirname, '..');
const dir = runDirectory(root, runId);
const { ledger } = inspectRequirementLedger(runId, path => readRunFile(dir, path).data);
const parent = resolve(dir, 'analysis');
if (realpathSync(parent) !== resolve(realpathSync(dir), 'analysis')) throw new Error('Analysis directory must not redirect writes');
const path = resolve(parent, 'requirement_analysis.md');
const output = renderAnalysis(ledger);
let generation;
if (process.env.QA_CONTROLLER_SESSION) generation=publishAnalysisDraft(root,runId,output,process.env.QA_CONTROLLER_SESSION);
else if (existsSync(path)) {
  if (lstatSync(path).isSymbolicLink() || readRunFile(dir, path).data.toString('utf8') !== output) throw new Error('Existing analysis differs; preserve it through reviewed revision before generating. No overwrite performed.');
} else writeFileSync(path, output, { encoding: 'utf8', flag: 'wx' });
console.log(JSON.stringify({ run_id: runId, artifact: 'analysis/requirement_analysis.md', status: 'generated', generation, approval_granted: false }));
