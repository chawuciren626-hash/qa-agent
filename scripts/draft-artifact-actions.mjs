import { existsSync, mkdirSync, readFileSync, realpathSync, lstatSync, writeFileSync, unlinkSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { runDirectory, readRunFile } from './design-quality.mjs';
import { assertStageHistory, writeJson } from './orchestration-state.mjs';
import { assertCompletedArtifacts, assertDependencyArtifacts } from './artifact-contracts.mjs';
import { runProjectCommand } from './command-runtime.mjs';
import { usesTaskArtifacts, inspectIndependentArtifacts, taskResultPath } from './independent-task.mjs';
import { CommandUsageError } from './command-contracts.mjs';
import { buildReportEvidence, reportFactsMarkdown } from './report-evidence.mjs';
import { preserveReportResults, resultFidelityMarkdown } from './report-result-fidelity.mjs';
import { browserLifecycle, browserCoverageMarkdown } from './browser-lifecycle.mjs';
import { ArtifactSafetyError } from './recovery-policy.mjs';
import { assertUnlinked } from './skill-resources.mjs';
import { reportDeliveryTitle } from './test-tracks.mjs';

function assertArtifactBoundary(dir,path) {
  try {assertUnlinked(dir,resolve(dir,path));}
  catch(error) {
    // Filesystem faults retain ordinary recovery; explicit boundary refusals do not.
    if(error.code) throw error;
    throw new ArtifactSafetyError(error.message,{cause:error});
  }
}

export const draftArtifactActions = {
  export_test_points: { stage: 'test_points', script: 'generate-test-points-xmind.mjs', inputs: ['design/test_points.json'], outputs: ['design/test_points.xmind'] },
  export_test_cases: { stage: 'test_cases', script: 'generate-test-cases-xlsx.mjs', inputs: ['design/test_cases.json'], outputs: ['design/test_cases.xlsx'] },
  assess_evidence: { stage: 'defects', script: 'assess-execution-evidence.mjs', inputs: ['execution/execution-state.json', 'execution/test_results.json', 'execution/execution-blocked.json'], outputs: ['quality/evidence-assessment.json'] },
  normalize_defects: { stage: 'defects', script: 'normalize-defects.mjs', inputs: ['defects/bugs.json', 'quality/evidence-assessment.json'], outputs: ['defects/defect-records.json', 'defects/lifecycle.json'] },
  build_report_metrics: { stage: 'report', script: 'build-quality-metrics.mjs', inputs: ['execution/execution-state.json', 'execution/test_results.json', 'execution/execution-blocked.json', 'quality/evidence-assessment.json', 'defects/defect-records.json', 'defects/lifecycle.json'], outputs: ['report/quality-metrics.json', 'report/reportable-results.json'] },
  export_report: { stage: 'report', kind: 'python', script: 'generate-report-documents.py', inputs: ['report/test_report.md', 'report/reportable-results.json', 'defects/bugs.json', 'report/quality-metrics.json', 'design/test_cases.json'], outputs: ['report/test_report.html', 'report/test_cases.xlsx'] }
};

function reuseSealedExport(root, runId, parent, manifest, definition, dispatch) {
  const stage=definition.stage;
  try {
    const events=manifest.orchestration.events;
    const completed=events.filter(event=>event.stage===stage && event.type==='completed').at(-1);
    if(manifest.stages[stage].dispatch_id!==dispatch.dispatch_id ||
      completed?.['dispatch-id']!==dispatch.dispatch_id || completed['parent-session-id']!==parent ||
      completed.evidence?.parent_session_id!==parent || events.indexOf(completed)<=events.indexOf(dispatch)) {
      throw new ArtifactSafetyError('No completed receipt owned by the current dispatch');
    }
    const receipt=completed.evidence.artifact_contract;
    if(receipt?.version!==1 || receipt.run_id!==runId || receipt.stage!==stage || receipt.status!=='passed' || !Array.isArray(receipt.files) || !receipt.files.length) {
      throw new Error('Current completion is missing a sealed artifact contract');
    }
    assertCompletedArtifacts(root,runId,manifest,stage);
    assertDependencyArtifacts(root,runId,manifest,stage);
    const visited=new Set([stage]);
    const checkDependencies=current=>{
      for(const dependency of manifest.orchestration.plan.stages.find(item=>item.id===current)?.depends_on ?? []) {
        if(visited.has(dependency)) continue;
        visited.add(dependency);
        assertStageHistory(manifest,dependency);
        if(!['completed','skipped'].includes(manifest.stages?.[dependency]?.status)) throw new Error(`Dependency is not complete: ${dependency}`);
        if(manifest.stages[dependency].status!=='skipped') checkDependencies(dependency);
      }
    };
    checkDependencies(stage);
    const requested=events.slice(events.indexOf(dispatch)+1).filter(event=>event.stage===stage && event.type==='confirmation_requested').at(-1);
    if(requested || manifest.stages[stage].status==='awaiting_confirmation') {
      const confirmations=(manifest.confirmations ?? []).filter(item=>item.stage===stage && item.id===requested?.confirmation_id);
      const confirmation=confirmations[0];
      const expected=manifest.stages[stage].status==='awaiting_confirmation'?'pending':'approved';
      const continued=expected==='approved' && confirmation?.status==='not_required' &&
        manifest.orchestration.plan.review_mode==='auto' && manifest.orchestration.plan.stages.find(item=>item.id===stage)?.confirmation==='none' &&
        events.slice(events.indexOf(requested)+1).some(event=>event.type==='review_mode_continued' && event.stage===stage && event.confirmation_id===confirmation.id && event.decision==='not_required');
      if(confirmations.length!==1 || (confirmation.status!==expected && !continued) || !isDeepStrictEqual(confirmation.artifact_contract,receipt)) {
        throw new ArtifactSafetyError('Current confirmation does not match the sealed completion');
      }
    }
    const paths=new Set(receipt.files.map(file=>file.path));
    // Older report contracts seal Word/PDF only; never advertise unsealed formats.
    const legacyReport=stage==='report' && !paths.has('report/test_report.html') && ['report/test_report.docx','report/test_report.pdf'].every(p=>paths.has(p));
    const required=legacyReport?['report/test_report.docx','report/test_report.pdf']:definition.outputs;
    if(required.some(path=>!paths.has(path))) throw new Error('Export output is missing from the sealed contract');
    return {status:'completed',exit_code:0,execution_mode:'in_process',launches_child:false,
      run_id:runId,stage,dispatch_id:dispatch.dispatch_id,reused:true,
      generated_artifacts:(legacyReport?required:definition.outputs).filter(path=>paths.has(path)),approval_granted:false};
  } catch(error) {
    throw new Error(`Sealed export reuse refused: ${error.message}. Repair only this presentation version against its sealed evidence; do not redispatch professional work, regenerate source content, or change confirmations or contracts through export.`,{cause:error});
  }
}

export async function runDraftArtifactAction(root, parent, action, runId, { signal } = {}) {
  let definition = draftArtifactActions[action];
  if (!definition) throw new Error('Unsupported draft artifact action');
  const dir = runDirectory(root, runId);
  const lock = resolve(dir, 'manifest.json.lock');
  assertArtifactBoundary(dir,'manifest.json');
  assertArtifactBoundary(dir,'manifest.json.lock');
  writeFileSync(lock, JSON.stringify({ pid: process.pid, action }), { flag: 'wx' });
  try {
    const manifest = JSON.parse(readRunFile(dir, 'manifest.json').data);
    const stage = definition.stage;
    assertStageHistory(manifest, stage);
    const dispatch = manifest.orchestration?.events?.filter(e => e.stage === stage && e.type === 'dispatched').at(-1);
    const latest = (manifest.confirmations ?? []).filter(c => c.stage === stage).at(-1);
    for(const path of [...definition.inputs,...definition.outputs,taskResultPath(stage),...(stage==='report'?['report/issues.json']:[])]) assertArtifactBoundary(dir,path);
    if(['export_test_points','export_test_cases','export_report'].includes(action) && ['completed','awaiting_confirmation'].includes(manifest.stages?.[stage]?.status)) {
      if(manifest.run_id!==runId || !manifest.orchestration?.plan?.stages?.some(s=>s.id===stage && s.selected) || !dispatch?.dispatch_id || dispatch['parent-session-id']!==parent) throw new ArtifactSafetyError('Sealed export reuse requires the owning selected professional dispatch');
      return reuseSealedExport(root,runId,parent,manifest,definition,dispatch);
    }
    if (manifest.run_id !== runId || !manifest.orchestration?.plan?.stages?.some(s => s.id === stage && s.selected) || manifest.stages?.[stage]?.status !== 'in_progress' || !dispatch?.dispatch_id || dispatch['parent-session-id'] !== parent) throw new ArtifactSafetyError('Artifact generation requires the owning active professional dispatch');
    if (['pending', 'approved', 'rejected'].includes(latest?.status)) throw new ArtifactSafetyError('Current confirmation forbids draft replacement');
    assertDependencyArtifacts(root, runId, manifest, stage);
    if(usesTaskArtifacts(root,runId,stage)) {
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
    assertArtifactBoundary(dir,archive);
    mkdirSync(base, { recursive: true });
    if (realpathSync(base) !== resolve(realpathSync(dir), archive)) throw new ArtifactSafetyError('Artifact archive must not redirect writes');
    // Preserve empty/corrupt outputs too: failed export bytes are evidence, not validated artifacts.
    const snapshot = (paths, phase) => paths.map(path => {
      const source = resolve(dir, path);
      if (lstatSync(dirname(source), { throwIfNoEntry: false })?.isSymbolicLink()) throw new ArtifactSafetyError('Artifact directory must not redirect writes');
      if (!existsSync(dirname(source))) return { path, missing: true };
      if (realpathSync(dirname(source)) !== resolve(realpathSync(dir), dirname(path))) throw new ArtifactSafetyError('Artifact directory must not redirect writes');
      const stat = lstatSync(source, { throwIfNoEntry: false });
      if (!stat) return { path, missing: true };
      if (stat.isSymbolicLink() || !stat.isFile() || realpathSync(source) !== resolve(realpathSync(dir), path)) throw new ArtifactSafetyError('Artifact must be a non-linked file in this run');
      const bytes = readFileSync(source);
      const target = resolve(base, phase, path); mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, bytes, { flag: 'wx' });
      return { path, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
    });
    const taskInputs = action === 'export_report' && usesTaskArtifacts(root, runId, stage) ? [taskResultPath('report')] : [];
    const record = { action, run_id: runId, stage, dispatch_id: dispatch.dispatch_id, parent_session: parent, before: snapshot([...definition.inputs, ...definition.outputs, ...taskInputs], 'before'), status: 'started' };
    writeJson(resolve(base, 'generation.json'), record);
    let args;
    if (action === 'export_report') args = [...[definition.inputs[0], definition.inputs[1], definition.inputs[2], 'report/test_report.docx','report/test_report.pdf', ...(definition.inputs[3]?[definition.inputs[3]]:[])].map(p => resolve(dir, p)), '--html-only', '--title='+reportDeliveryTitle(root,runId)];
    else if (action.startsWith('export_')) args = [...definition.inputs, ...definition.outputs].map(p => resolve(dir, p));
    else args = [`--run-id=${runId}`];
    if (action === 'export_report' && usesTaskArtifacts(root, runId, stage)) {
      const task = JSON.parse(readRunFile(dir, taskResultPath('report')).data);
      const index = buildReportEvidence(dir, manifest, task.source_paths.filter(p => p.startsWith('inputs/')), task.regression_comparison);
      const draftResults = JSON.parse(readRunFile(dir,'report/reportable-results.json').data);
      const fidelity = preserveReportResults(draftResults,index,path=>readRunFile(dir,path));
      if(fidelity.results.status==='partial' && index.facts.some(f=>['execution/test_results.json','execution/api/test_results.json'].includes(f.source_path) && f.partial)) {
        task.outcome='partial';
        task.limitations=[...new Set([...(task.limitations ?? []),...(fidelity.results.coverage?.untested ?? [])])];
        writeJson(resolve(dir,taskResultPath('report')),task);
      }
      if(index.facts.some(f=>f.source_path==='execution/test_results.json' && f.result_origin==='recovered')) {
        const actual=JSON.parse(readRunFile(dir,'execution/test_results.json').data);
        Object.assign(fidelity.results,{result_origin:'recovered',status:'partial',finished_at:null,browser_closed:'unknown',statistics:actual.statistics});
      }
      let coverageText='';
      if(browserLifecycle(manifest)) {
        const coverage=JSON.parse(readRunFile(dir,'execution/browser-coverage.json').data);
        fidelity.results.design_coverage=coverage;
        fidelity.results.statistics=JSON.parse(readRunFile(dir,'execution/test_results.json').data).statistics;
        coverageText=browserCoverageMarkdown(coverage);
      }
      // The before snapshot retains the model draft; canonical results keep source fields for every format.
      if (!isDeepStrictEqual(draftResults,fidelity.results)) writeJson(resolve(dir,'report/reportable-results.json'),fidelity.results);
      writeJson(resolve(base,'result-fidelity.json'),{version:1,changes:fidelity.changes});
      record.result_fidelity = `${archive}/result-fidelity.json`;
      writeJson(resolve(base, 'report-evidence.json'), index);
      // Render a derived snapshot; preserve the agent draft and all original execution bytes.
      const renderPath = resolve(base, 'report-with-facts.md');
      writeFileSync(renderPath, readRunFile(dir, 'report/test_report.md').data.toString('utf8') + '\n\n' + reportFactsMarkdown(index) + '\n\n' + resultFidelityMarkdown(fidelity.results) + '\n\n' + coverageText, { flag: 'wx' });
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
