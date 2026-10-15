import { readRunFile, runDirectory } from './design-quality.mjs';
import { inspectRequirementLedger } from './requirement-provenance.mjs';
import { assertAnalysisMarkdown } from './analysis-markdown.mjs';

// Reuse each captured byte snapshot for validation and attribution.
export function analysisSummary(root, runId) {
  const dir = runDirectory(root, runId);
  const files = new Map();
  const capture = path => {
    if (!files.has(path)) files.set(path, readRunFile(dir, path));
    return files.get(path).data;
  };
  const { ledger } = inspectRequirementLedger(runId, capture);
  assertAnalysisMarkdown(ledger, capture('analysis/requirement_analysis.md'));
  const groups = { requirements: [], assumptions: [], observations: [] };
  const names = { requirement: 'requirements', assumption: 'assumptions', observation: 'observations' };
  for (const rule of ledger.rules) {
    groups[names[rule.kind]].push({ ...rule });
  }
  return {
    run_id: runId,
    groups,
    counts: Object.fromEntries(Object.entries(groups).map(([key, value]) => [key, value.length])),
    unresolved_ids: ledger.rules.filter(rule => ['pending', 'conflicted'].includes(rule.status)).map(rule => rule.id),
    out_of_scope_ids: ledger.rules.filter(rule => rule.scope === 'out_of_scope').map(rule => rule.id),
    sources: ledger.sources,
    semantic_review: ['Preserve mandatory/prohibited conditions and negation.', 'Preserve AND/OR relationships: feedback does not replace a required outcome or prohibited state change.', 'Compare statements with original citations; retain exact numbers and literal messages. Uncertain interpretations stay pending.'],
    evidence: [...files].map(([path, file]) => ({ path, sha256: file.sha256 })),
    coverage: 'Validated ledger and matching Markdown snapshot only. No inferred topics, completeness, priority or stage approval. Observations are not necessarily implementation observations.',
    presentation: 'Summarize only listed IDs and statements, retaining status and scope. No items means none recorded, not none exist. Read run_status separately for workflow confirmation. Priority is a professional judgment, not inferred from IDs. unresolved_ids is NOT a mandatory-answer list: ask only about alternative interpretations that change requested behavior or execution safety, explain the affected rule and outcomes. Present optional suggestions and material limitations separately, without inventing exclusions or promoting pending rules to approved. Requirements without implementation details must remain implementation-neutral.'
  };
}
