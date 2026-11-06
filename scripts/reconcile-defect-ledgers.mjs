import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync, readdirSync, statSync, realpathSync } from 'node:fs';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';

const inside = (root, file) => {
  const rel = relative(root, file);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..\\`) && !rel.startsWith('../') && !isAbsolute(rel));
};
const json = file => JSON.parse(readFileSync(file, 'utf8'));
const readRunObservations = (session, warnings) => {
  const root = resolve(session.workspace);
  const runs = join(root, 'output', 'runs');
  let entries;
  try { entries = readdirSync(runs, { withFileTypes: true }); }
  catch { return []; }
  const observations = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^run-[A-Za-z0-9-]+$/.test(entry.name)) continue;
    const dir = join(runs, entry.name);
    const file = join(dir, 'defects', 'defect-records.json');
    if (!existsSync(file)) continue;
    try {
      if (!inside(realpathSync(root), realpathSync(file))) throw Error('linked outside workspace');
      if (!inside(realpathSync(root), realpathSync(join(dir, 'manifest.json')))) throw Error('linked manifest outside workspace');
      if (statSync(file).size > 4 * 1024 * 1024) throw Error('file too large');
      const manifest = json(join(dir, 'manifest.json'));
      if (manifest.run_id !== entry.name || (manifest.directory_context?.session_id && manifest.directory_context.session_id !== session.session_id)) throw Error('run identity mismatch');
      const data = json(file);
      if (!Array.isArray(data.records) || (data.run_id && data.run_id !== entry.name)) throw Error('invalid defect records');
      for (const record of data.records) {
        if (typeof record.defect_id !== 'string') throw Error('invalid defect id');
        observations.push({ projectId: session.project_id, sessionId: session.session_id, runId: entry.name,
          defectId: record.defect_id, title: record.title ?? '', status: record.lifecycle_status ?? null,
          relatedCases: Array.isArray(record.related_cases) ? record.related_cases : [],
          evidenceRefs: Array.isArray(record.evidence_refs) ? record.evidence_refs : [] });
      }
    } catch (error) { warnings.push({ projectId: session.project_id, sessionId: session.session_id, runId: entry.name, reason: String(error.message) }); }
  }
  return observations;
};

/** Read-only comparison. A mapping is explicit: no title or fingerprint heuristic changes history. */
export function reconcileDefectLedgers({ dbPath, projectId, mapping = [] }) {
  if (!Array.isArray(mapping)) throw Error('mapping must be an array');
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const sessions = db.prepare('SELECT session_id,project_id,workspace FROM sessions WHERE project_id=?').all(projectId);
    const defects = db.prepare('SELECT defect_id,status,title FROM qa_defects WHERE project_id=?').all(projectId);
    const occurrences = db.prepare('SELECT defect_id,session_id,run_id,case_key FROM qa_defect_occurrences WHERE project_id=?').all(projectId);
    const runConflicts = db.prepare('SELECT run_id,COUNT(DISTINCT session_id) AS sessions FROM qa_design_batches WHERE project_id=? GROUP BY run_id HAVING COUNT(DISTINCT session_id)>1').all(projectId);
    const warnings = [];
    const observations = sessions.flatMap(session => readRunObservations(session, warnings));
    const key = row => `${row.sessionId}\u0000${row.runId}\u0000${row.defectId}`;
    const mapKeys = new Set();
    const mappedQaOccurrences = new Set();
    const findings = [];
    for (const item of mapping) {
      if (!item || typeof item !== 'object' || !['sessionId','runId','defectId','qaDefectId'].every(name => typeof item[name] === 'string')) throw Error('invalid mapping entry');
      const id = key(item);
      if (mapKeys.has(id)) { findings.push({ kind: 'duplicate_mapping', key: id }); continue; }
      mapKeys.add(id);
      const observation = observations.find(row => key(row) === id);
      const defect = defects.find(row => row.defect_id === item.qaDefectId);
      if (!observation) { findings.push({ kind: 'missing_run_observation', ...item }); continue; }
      if (!defect) { findings.push({ kind: 'missing_qa_defect', ...item }); continue; }
      const linkedOccurrences = occurrences.filter(row => row.defect_id === item.qaDefectId && row.session_id === item.sessionId && row.run_id === item.runId && (!item.caseKey || row.case_key === item.caseKey));
      if (!linkedOccurrences.length) {
        findings.push({ kind: 'missing_qa_occurrence', ...item });
      } else {
        for (const row of linkedOccurrences) {
          if (mappedQaOccurrences.has(row)) findings.push({ kind: 'duplicate_qa_occurrence_mapping', ...item, caseKey: row.case_key });
          mappedQaOccurrences.add(row);
        }
      }
      if (observation.status && observation.status !== defect.status) findings.push({ kind: 'status_difference', ...item, runStatus: observation.status, currentStatus: defect.status });
    }
    for (const row of observations) if (!mapKeys.has(key(row))) findings.push({ kind: 'unmapped_run_observation', projectId, sessionId: row.sessionId, runId: row.runId, defectId: row.defectId });
    for (const row of occurrences) if (!mappedQaOccurrences.has(row)) findings.push({ kind: 'unmapped_qa_occurrence', projectId, qaDefectId: row.defect_id, sessionId: row.session_id, runId: row.run_id, caseKey: row.case_key });
    for (const row of defects) if (!occurrences.some(item => item.defect_id === row.defect_id)) findings.push({ kind: 'qa_defect_without_occurrence', projectId, qaDefectId: row.defect_id });
    for (const row of runConflicts) findings.push({ kind: 'historical_duplicate_run_id', projectId, runId: row.run_id, sessions: row.sessions });
    return { projectId, readOnly: true, sessions: sessions.length, runObservations: observations.length, qaDefects: defects.length,
      qaOccurrences: occurrences.length, mappings: mapping.length, findings, warnings };
  } finally { db.close(); }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const args = Object.fromEntries(process.argv.slice(2).map(part => { const match = /^--([^=]+)=(.+)$/.exec(part); if (!match) throw Error('Use --db=PATH --project=ID [--mapping=JSON]'); return [match[1], match[2]]; }));
  if (!args.db || !args.project) throw Error('Use --db=PATH --project=ID [--mapping=JSON]');
  process.stdout.write(`${JSON.stringify(reconcileDefectLedgers({ dbPath: args.db, projectId: args.project, mapping: args.mapping ? json(args.mapping) : [] }), null, 2)}\n`);
}
