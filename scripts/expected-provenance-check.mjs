import { inspectExpectationBasis, collectSourceTexts } from './expectation-basis.mjs';
import { inspectCaseExpectations } from './expected-source.mjs';
import { readRuntimeState } from './tool-gate.mjs';

// Verify a case's quoted source and assertion state. This does not prove that
// the quote semantically entails the expectation; that still needs review.
export function inspectExpectedProvenance(rows, root, dir = null, { sources = null } = {}) {
  const skipped = { problems: [], located: 0, notRecorded: 0, verified: 0, skipped: true };
  if (readRuntimeState(root).disabled.has('expected.provenance')) return skipped;
  const problems = [];
  let located = 0;
  let notRecorded = 0;
  let verified = 0;
  sources ??= dir ? collectSourceTexts(dir) : new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const caseId = row?.case_id ?? 'case';
    const basis = inspectExpectationBasis(row, sources);
    basis.errors.forEach(error => problems.push(`${caseId}: ${error}`));
    if (basis.status === 'source_located') located += 1; else notRecorded += 1;
    if (row?.expectations === undefined) continue;
    try {
      const { expectations } = inspectCaseExpectations(row, caseId);
      for (const item of expectations) if (item.state === 'verified') verified += 1;
    } catch (error) { problems.push(error.message); }
  }
  return { problems, located, notRecorded, verified, skipped: false };
}
