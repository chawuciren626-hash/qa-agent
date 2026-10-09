export function defectGateReasons(records, history = []) {
  const open = [...records, ...history].filter(record => !['closed', 'rejected'].includes(record.lifecycle_status));
  const reasons = [];
  if (open.some(record => record.lifecycle_status === 'needs_review')) reasons.push('needs_review');
  if (open.some(record => record.category === 'product_defect' && record.lifecycle_status === 'draft')) reasons.push('draft_product_defect');
  if (open.some(record => record.lifecycle_status === 'fixed')) reasons.push('unverified_fix');
  if (open.some(record => record.category === 'product_defect' && record.lifecycle_status === 'confirmed')) reasons.push('open_product_defect');
  if (history.some(record => !['closed', 'rejected'].includes(record.lifecycle_status))) reasons.push('unresolved_historical_defects');
  return reasons;
}
export function qualityGateStatus(policy, reasons) {
  const integrity = ['missing_quality_inputs', 'no_executed_cases', 'incomplete_evidence_assessment', 'stale_derived_artifacts', 'lifecycle_integrity_error'];
  if (reasons.some(reason => integrity.includes(reason) || (policy.block_on ?? []).includes(reason))) return 'blocked';
  if (reasons.some(reason => ['untriaged_failures', 'unverified_fix', 'unresolved_historical_defects'].includes(reason) || (policy.review_on ?? []).includes(reason))) return 'review_required';
  if (reasons.some(reason => ['high_severity_defect', 'open_product_defect'].includes(reason))) return 'risk_present';
  return 'informational';
}
