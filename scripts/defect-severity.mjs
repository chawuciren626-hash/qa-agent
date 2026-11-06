export const SEVERITY_LEVELS = ['Blocker', 'Critical', 'Major', 'Minor', 'Trivial', 'unknown'];
export const SEVERITY_RANK = { Blocker: 5, Critical: 4, Major: 3, Minor: 2, Trivial: 1, unknown: 0 };
export const SEVERITY_DIMENSION_VALUES = {
  user_business_impact: ['critical', 'major', 'minor', 'none', 'unknown'],
  reach_frequency: ['all', 'many', 'some', 'few', 'unknown'],
  recoverability: ['none', 'expensive', 'workaround', 'easy', 'unknown'],
  data_security_compliance: ['confirmed', 'suspected', 'none', 'unknown']
};
export const SEVERITY_DIMENSIONS = Object.keys(SEVERITY_DIMENSION_VALUES);
export const HIGH_RISK_SEVERITY = ['Blocker', 'Critical'];

const text = value => typeof value === 'string' && value.trim().length > 0;

export function severityOf(record) {
  return SEVERITY_LEVELS.includes(record?.severity) ? record.severity : 'unknown';
}

export function severityReasonOf(record) {
  return text(record?.severity_reason) ? record.severity_reason.trim() : '';
}

export function isStandardSeverityRecord(record) {
  return record?.severity_standard_version === 1;
}

/** Problems are returned, never thrown: callers decide whether an old record is legacy or a new contract violation. */
export function severityProblems(record, { requireStandard = false } = {}) {
  const problems = [];
  if (!record || typeof record !== 'object' || Array.isArray(record)) return ['severity record must be an object'];
  const hasSeverity = Object.hasOwn(record, 'severity');
  if (!hasSeverity) {
    if (requireStandard) problems.push('severity is required; use unknown with severity_reason when evidence is insufficient');
    return problems;
  }
  if (!SEVERITY_LEVELS.includes(record.severity)) {
    problems.push(`severity must be one of ${SEVERITY_LEVELS.join(', ')}; received ${JSON.stringify(record.severity)}`);
    return problems;
  }
  if (!requireStandard && !isStandardSeverityRecord(record)) return problems;

  if (!isStandardSeverityRecord(record)) problems.push('severity_standard_version must be 1 for a new severity assessment');
  if (!severityReasonOf(record)) problems.push('severity_reason is required to explain the level or the missing evidence');

  const dimensions = record.severity_dimensions;
  if (!dimensions || typeof dimensions !== 'object' || Array.isArray(dimensions)) {
    problems.push(`severity_dimensions is required with ${SEVERITY_DIMENSIONS.join(', ')}`);
  } else {
    for (const key of SEVERITY_DIMENSIONS) if (!(key in dimensions)) problems.push(`severity_dimensions.${key} is required`);
    for (const key of Object.keys(dimensions)) if (!(key in SEVERITY_DIMENSION_VALUES)) problems.push(`unknown severity dimension: ${key}`);
    for (const [key, values] of Object.entries(SEVERITY_DIMENSION_VALUES)) {
      if (dimensions[key] !== undefined && !values.includes(dimensions[key])) {
        problems.push(`severity_dimensions.${key} must be one of ${values.join(', ')}`);
      }
    }
  }

  if (record.severity_evidence !== undefined) {
    if (!Array.isArray(record.severity_evidence) || record.severity_evidence.some(value => !text(value))) {
      problems.push('severity_evidence must be an array of non-empty strings');
    } else if (!Array.isArray(record.evidence_refs)) {
      problems.push('evidence_refs is required when severity_evidence is provided');
    } else {
      const known = new Set(record.evidence_refs);
      const missing = record.severity_evidence.filter(ref => !known.has(ref));
      if (missing.length) problems.push(`severity_evidence must reference existing evidence_refs: ${missing.join(', ')}`);
    }
  }
  return problems;
}

export function severityCounts(records = []) {
  return {
    ...Object.fromEntries(SEVERITY_LEVELS.map(level => [level, records.filter(record => record?.severity === level).length])),
    missing: records.filter(record => record?.severity == null).length
  };
}

/** Separates new assessments from legacy records so unknown handling never rewrites history. */
export function severityStandardCounts(records = []) {
  return {
    standard: records.filter(isStandardSeverityRecord).length,
    legacy: records.filter(record => !isStandardSeverityRecord(record)).length,
    unknown: records.filter(record => record?.severity === 'unknown').length,
    missing: records.filter(record => record?.severity == null).length,
    missing_reason: records.filter(record => isStandardSeverityRecord(record) && !severityReasonOf(record)).length
  };
}

export function severityNeedsReview(record, policy = {}) {
  return isStandardSeverityRecord(record) && severityOf(record) === 'unknown' && policy.defect_severity?.review_on_unknown !== false;
}
