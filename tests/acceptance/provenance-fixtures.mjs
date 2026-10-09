import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderAnalysis } from '../../scripts/analysis-markdown.mjs';

export function provenanceFixture(dir, runId, statement = 'Synthetic') {
  mkdirSync(resolve(dir, 'analysis'), { recursive: true });
  const ledger = { version: 1, run_id: runId,
    sources: [{ id: 'SRC-SYNTHETIC', kind: 'user_requirement', path: 'inputs/requirements.md', origin: 'synthetic engineering fixture, not real authorization', locator: 'fixture requirement' }],
    rules: [{ id: 'RULE-SYNTHETIC', kind: 'requirement', scope: 'in_scope', status: 'confirmed', statement, citations: [{ source_id: 'SRC-SYNTHETIC', quote: readFileSync(resolve(dir, 'inputs/requirements.md'), 'utf8') }] }]
  };
  writeFileSync(resolve(dir, 'analysis/requirement-ledger.json'), JSON.stringify(ledger));
  writeFileSync(resolve(dir, 'analysis/requirement_analysis.md'), renderAnalysis(ledger));
  return ledger;
}
