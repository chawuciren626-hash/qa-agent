import { getRunContext, withRunLock, writeJson, recomputeRunStatus, assertStageHistory, hasApprovedConfirmation } from './orchestration-state.mjs';

export function extendRunPlan(root, project, runId, requested, reason) {
  if (!Array.isArray(requested) || !requested.length || requested.some(id => typeof id !== 'string' || !id.trim()) || new Set(requested).size !== requested.length) throw new Error('Provide unique stage IDs to add');
  if (typeof reason !== 'string' || !reason.trim()) throw new Error('Record the requested continuation scope');
  return withRunLock(root, project, runId, () => {
    const { manifest, manifestPath } = getRunContext(root, project, runId);
    if (manifest.run_id !== runId) throw new Error('Manifest run ID mismatch');
    const plan = manifest.orchestration?.plan;
    if (!Array.isArray(plan?.stages) || !plan.stages.length) throw new Error('No existing plan; use plan_run first');
    const definitions = new Map(plan.stages.map(stage => [stage.id, stage]));
    if (definitions.size !== plan.stages.length) throw new Error('Duplicate stage IDs in saved plan');
    const wanted = new Set();
    const visiting = new Set();
    // Use the saved plan, not today's configuration: extension must not migrate existing contracts.
    function visit(id) {
      if (visiting.has(id)) throw new Error('Cyclic dependency in saved plan');
      if (wanted.has(id)) return;
      const stage = definitions.get(id);
      if (!stage || !Array.isArray(stage.depends_on)) throw new Error(`Unknown stage or invalid dependency: ${id}`);
      if (typeof stage.selected !== 'boolean' || !stage.agent || !Array.isArray(stage.skills) || !stage.skills.length || !['before', 'after', 'none'].includes(stage.confirmation)) throw new Error(`Invalid saved stage contract: ${id}`);
      visiting.add(id);
      stage.depends_on.forEach(visit);
      visiting.delete(id);
      wanted.add(id);
    }
    requested.forEach(visit);
    for (const stage of plan.stages.filter(stage => stage.selected)) {
      visit(stage.id);
      if (stage.depends_on.some(id => !definitions.get(id)?.selected)) throw new Error('Existing selected stages have an unselected dependency');
      assertStageHistory(manifest, stage.id);
    }
    const added = plan.stages.filter(stage => wanted.has(stage.id) && !stage.selected);
    for (const stage of added) {
      const state = manifest.stages?.[stage.id];
      if (state?.status !== 'skipped' || manifest.confirmations?.some(c => c.stage === stage.id) || manifest.orchestration.events?.some(e => e.stage === stage.id)) throw new Error(`Stage ${stage.id} has prior activity or a decision; extension cannot recover it`);
    }
    const response = () => ({ run_id: runId, workflow: plan.workflow_id, selected_stages: plan.stages.filter(s => s.selected).map(s => s.id), added_stages: added.map(s => s.id), unchanged: added.length === 0, status: manifest.status, resume_from: manifest.orchestration.resume_from, approval_granted: false, starts_execution: false });
    if (!added.length) return response();
    const at = new Date().toISOString();
    manifest.orchestration.events ??= [];
    for (const stage of added) {
      stage.selected = true;
      manifest.stages[stage.id] = { status: 'planned', updated_at: at, reason: 'Added to the existing run plan' };
      manifest.orchestration.events.push({ type: 'stage_added_to_plan', at, stage: stage.id, reason });
    }
    manifest.orchestration.events.push({ type: 'plan_extended', at, requested_stages: [...requested], added_stages: added.map(s => s.id), reason });
    plan.updated_at = at;
    manifest.orchestration.resume_from = plan.stages.find(s => s.selected && (!['completed', 'skipped'].includes(manifest.stages?.[s.id]?.status) || (manifest.stages?.[s.id]?.status === 'completed' && s.confirmation === 'after' && !hasApprovedConfirmation(manifest, s.id))))?.id ?? 'completed';
    manifest.status = recomputeRunStatus(manifest);
    manifest.updated_at = at;
    writeJson(manifestPath, manifest);
    return response();
  });
}
