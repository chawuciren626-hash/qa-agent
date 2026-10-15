import { existsSync, mkdirSync, readFileSync, realpathSync, lstatSync, writeFileSync, unlinkSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { runDirectory, readRunFile } from './design-quality.mjs';
import { assertStageHistory, writeJson } from './orchestration-state.mjs';
import { assertDependencyArtifacts } from './artifact-contracts.mjs';
import { runProjectCommand } from './command-runtime.mjs';
import { isIndependent, inspectIndependentArtifacts, taskResultPath } from './independent-task.mjs';
import { CommandUsageError } from './command-contracts.mjs';
import { buildReportEvidence, reportFactsMarkdown } from './report-evidence.mjs';

export const draftArtifactActions = {
  export_test_points: { stage: 'test_points', script: 'generate-test-points-xmind.mjs', inputs: ['design/test_points.json'], outputs: ['design/test_points.xmind'] },
  export_test_cases: { stage: 'test_cases', script: 'generate-test-cases-xlsx.mjs', inputs: ['design/test_cases.json'], outputs: ['design/test_cases.xlsx'] },
  assess_evidence: { stage: 'defects', script: 'assess-execution-evidence.mjs', inputs: ['execution/execution-state.json', 'execution/test_results.json', 'execution/execution-blocked.json'], outputs: ['quality/evidence-assessment.json'] },
  normalize_defects: { stage: 'defects', script: 'normalize-defects.mjs', inputs: ['defects/bugs.json', 'quality/evidence-assessment.json'], outputs: ['defects/defect-records.json', 'defects/lifecycle.json'] },
  build_report_metrics: { stage: 'report', script: 'build-quality-metrics.mjs', inputs: ['execution/execution-state.json', 'execution/test_results.json', 'execution/execution-blocked.json', 'quality/evidence-assessment.json', 'defects/defect-records.json', 'defects/lifecycle.json'], outputs: ['report/quality-metrics.json', 'report/reportable-results.json'] },
  export_report: { stage: 'report', kind: 'python', script: 'generate-report-documents.py', inputs: ['report/test_report.md', 'report/reportable-results.json', 'defects/bugs.json', 'report/quality-metrics.json', 'design/test_cases.json'], outputs: ['report/test_report.docx', 'report/test_report.pdf', 'report/test_report.html', 'report/test_cases.xlsx'] }
};

export async function runDraftArtifactAction(root, parent, action, runId, { signal } = {}) {
  let definition = draftArtifactActions[action];
  if (!definition) throw new Error('Unsupported draft artifact action');
  const dir = runDirectory(root, runId);
  const lock = resolve(dir, 'manifest.json.lock');
  writeFileSync(lock, JSON.stringify({ pid: process.pid, action }), { flag: 'wx' });
  try {
    const manifest = JSON.parse(readRunFile(dir, 'manifest.json').data);
    const stage = definition.stage;
    assertStageHistory(manifest, stage);
    const dispatch = manifest.orchestration?.events?.filter(e => e.stage === stage && e.type === 'dispatched').at(-1);
    const latest = (manifest.confirmations ?? []).filter(c => c.stage === stage).at(-1);
    if (manifest.run_id !== runId || !manifest.orchestration?.plan?.stages?.some(s => s.id === stage && s.selected) || manifest.stages?.[stage]?.status !== 'in_progress' || !dispatch?.dispatch_id || dispatch['parent-session-id'] !== parent) throw new Error('Artifact generation requires the owning active professional dispatch');
    if (['pending', 'approved', 'rejected'].includes(latest?.status)) throw new Error('Current confirmation forbids draft replacement');
    assertDependencyArtifacts(root, runId, manifest, stage);
    if(isIndependent(root,runId)) {
      if(!['export_test_points','export_test_cases','export_report'].includes(action)) throw new CommandUsageError(`action=${action} is lifecycle-only; this run uses independent task mode. No lifecycle files are required. For report, write report/test_report.md, report/reportable-results.json, report/issues.json (top-level array; [] when empty) and report/report-task.json, then diagnose_task(stage=report), export_report and validate_artifacts(stage=report) via JSON request files. Do not create metrics or ask the user to unlock.`);
      const check=inspectIndependentArtifacts(root,runId,stage,{draft:true});
      if(check.status!=='passed') {
        const ErrorType=check.input_correction?CommandUsageError:Error;
        throw new ErrorType(`${check.errors.join('; ')}. Correct the run-local draft under ${dir}, including ${taskResultPath(stage)}, then retry ${action}. No product test or export was started.`);
      }
      if(action==='export_report') definition={...definition,inputs:['report/test_report.md','report/reportable-results.json','report/issues.json']};
    }
    const archive = `audit/artifact-generations/${randomUUID()}`;
    const base = resolve(dir, archive);
    mkdirSync(base, { recursive: true });
    if (realpathSync(base) !== resolve(realpathSync(dir), archive)) throw new Error('Artifact archive must not redirect writes');
    // Preserve empty/corrupt outputs too: failed export bytes are evidence, not validated artifacts.
    const snapshot = (paths, phase) => paths.map(path => {
      const source = resolve(dir, path);
      if (lstatSync(dirname(source), { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error('Artifact directory must not redirect writes');
      if (!existsSync(dirname(source))) return { path, missing: true };
      if (realpathSync(dirname(source)) !== resolve(realpathSync(dir), dirname(path))) throw new Error('Artifact directory must not redirect writes');
      const stat = lstatSync(source, { throwIfNoEntry: false });
      if (!stat) return { path, missing: true };
      if (stat.isSymbolicLink() || !stat.isFile() || realpathSync(source) !== resolve(realpathSync(dir), path)) throw new Error('Artifact must be a non-linked file in this run');
      const bytes = readFileSync(source);
      const target = resolve(base, phase, path); mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, bytes, { flag: 'wx' });
      return { path, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
    });
    const record = { action, run_id: runId, stage, dispatch_id: dispatch.dispatch_id, parent_session: parent, before: snapshot([...definition.inputs, ...definition.outputs], 'before'), status: 'started' };
    writeJson(resolve(base, 'generation.json'), record);
    let args;
    if (action === 'export_report') args = [definition.inputs[0], definition.inputs[1], definition.inputs[2], ...definition.outputs.slice(0, 2), ...(definition.inputs[3]?[definition.inputs[3]]:[])].map(p => resolve(dir, p));
    else if (action.startsWith('export_')) args = [...definition.inputs, ...definition.outputs].map(p => resolve(dir, p));
    else args = [`--run-id=${runId}`];
    if (action === 'export_report' && isIndependent(root, runId)) {
      const task = JSON.parse(readRunFile(dir, taskResultPath('report')).data);
      const index = buildReportEvidence(dir, manifest, task.source_paths.filter(p => p.startsWith('inputs/')));
      writeJson(resolve(base, 'report-evidence.json'), index);
      // Render a derived snapshot; preserve the agent draft and all original execution bytes.
      const renderPath = resolve(base, 'report-with-facts.md');
      writeFileSync(renderPath, readRunFile(dir, 'report/test_report.md').data.toString('utf8') + '\n\n' + reportFactsMarkdown(index), { flag: 'wx' });
      args[0] = renderPath;
      record.report_facts = `${archive}/report-evidence.json`;
    }
    try {
      const result = await runProjectCommand(root, { kind: definition.kind ?? 'node', script: definition.script, args, runId, signal });
      record.status = result.status; record.command_evidence = result.evidence_dir;
      if (result.result?.termination_confirmed) record.after = snapshot(definition.outputs, 'after');
      return { ...result, artifact_archive: archive, generated_artifacts: definition.outputs, approval_granted: false };
    } catch (error) { record.status = 'runner_error'; record.error = error.message; throw error; }
    finally { writeJson(resolve(base, 'generation.json'), record); }
  } finally { unlinkSync(lock); }
}
