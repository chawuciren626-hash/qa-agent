import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reconcileDefectLedgers } from '../../scripts/reconcile-defect-ledgers.mjs';

test('read-only ledger comparison requires an explicit mapping and preserves each source', () => {
  const root = mkdtempSync(join(tmpdir(), 'qa-ledger-audit-'));
  try {
    const dbPath = join(root, 'web.db');
    const db = new DatabaseSync(dbPath);
    db.exec('CREATE TABLE sessions(session_id TEXT,project_id TEXT,workspace TEXT); CREATE TABLE qa_defects(defect_id TEXT,project_id TEXT,status TEXT,title TEXT); CREATE TABLE qa_defect_occurrences(defect_id TEXT,project_id TEXT,session_id TEXT,run_id TEXT,case_key TEXT); CREATE TABLE qa_design_batches(project_id TEXT,session_id TEXT,run_id TEXT)');
    db.prepare('INSERT INTO sessions VALUES (?,?,?)').run('session-a','project-a',root);
    db.prepare('INSERT INTO qa_defects VALUES (?,?,?,?)').run('bug-a','project-a','closed','登入失败');
    db.prepare('INSERT INTO qa_defect_occurrences VALUES (?,?,?,?,?)').run('bug-a','project-a','session-a','run-a','case-a');
    db.prepare('INSERT INTO qa_design_batches VALUES (?,?,?)').run('project-a','session-a','run-a');
    db.prepare('INSERT INTO qa_design_batches VALUES (?,?,?)').run('project-a','session-b','run-a');
    db.close();
    const dir = join(root, 'output', 'runs', 'run-a');
    mkdirSync(join(dir, 'defects'), { recursive: true });
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ run_id: 'run-a', directory_context: { session_id: 'session-a' } }));
    writeFileSync(join(dir, 'defects', 'defect-records.json'), JSON.stringify({ run_id: 'run-a', records: [{ defect_id: 'D-1', title: '登入失败', lifecycle_status: 'confirmed', related_cases: ['case-a'] }] }));
    const unmapped = reconcileDefectLedgers({ dbPath, projectId: 'project-a' });
    assert.deepEqual(unmapped.findings.map(item => item.kind), ['unmapped_run_observation', 'unmapped_qa_occurrence', 'historical_duplicate_run_id']);
    const mapped = reconcileDefectLedgers({ dbPath, projectId: 'project-a', mapping: [{ sessionId: 'session-a', runId: 'run-a', defectId: 'D-1', qaDefectId: 'bug-a', caseKey: 'case-a' }] });
    assert.deepEqual(mapped.findings.map(item => item.kind), ['status_difference', 'historical_duplicate_run_id']);
    assert.deepEqual(mapped.warnings, []);
    assert.equal(mapped.qaOccurrences, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('ledger comparison exposes project-only occurrences and defects without an occurrence', () => {
  const root = mkdtempSync(join(tmpdir(), 'qa-ledger-audit-'));
  try {
    const dbPath = join(root, 'web.db');
    const db = new DatabaseSync(dbPath);
    db.exec('CREATE TABLE sessions(session_id TEXT,project_id TEXT,workspace TEXT); CREATE TABLE qa_defects(defect_id TEXT,project_id TEXT,status TEXT,title TEXT); CREATE TABLE qa_defect_occurrences(defect_id TEXT,project_id TEXT,session_id TEXT,run_id TEXT,case_key TEXT); CREATE TABLE qa_design_batches(project_id TEXT,session_id TEXT,run_id TEXT)');
    db.prepare('INSERT INTO qa_defects VALUES (?,?,?,?)').run('project-only','project-a','confirmed','仅项目账本');
    db.prepare('INSERT INTO qa_defects VALUES (?,?,?,?)').run('without-occurrence','project-a','confirmed','无发生记录');
    db.prepare('INSERT INTO qa_defect_occurrences VALUES (?,?,?,?,?)').run('project-only','project-a','session-a','run-a','case-a');
    db.close();
    const result = reconcileDefectLedgers({ dbPath, projectId: 'project-a' });
    assert.deepEqual(result.findings, [
      { kind: 'unmapped_qa_occurrence', projectId: 'project-a', qaDefectId: 'project-only', sessionId: 'session-a', runId: 'run-a', caseKey: 'case-a' },
      { kind: 'qa_defect_without_occurrence', projectId: 'project-a', qaDefectId: 'without-occurrence' },
    ]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('ledger comparison flags two run observations mapped to one project occurrence', () => {
  const root = mkdtempSync(join(tmpdir(), 'qa-ledger-audit-'));
  try {
    const dbPath = join(root, 'web.db');
    const db = new DatabaseSync(dbPath);
    db.exec('CREATE TABLE sessions(session_id TEXT,project_id TEXT,workspace TEXT); CREATE TABLE qa_defects(defect_id TEXT,project_id TEXT,status TEXT,title TEXT); CREATE TABLE qa_defect_occurrences(defect_id TEXT,project_id TEXT,session_id TEXT,run_id TEXT,case_key TEXT); CREATE TABLE qa_design_batches(project_id TEXT,session_id TEXT,run_id TEXT)');
    db.prepare('INSERT INTO sessions VALUES (?,?,?)').run('session-a','project-a',root);
    db.prepare('INSERT INTO qa_defects VALUES (?,?,?,?)').run('bug-a','project-a','confirmed','登入失败');
    db.prepare('INSERT INTO qa_defect_occurrences VALUES (?,?,?,?,?)').run('bug-a','project-a','session-a','run-a','case-a');
    db.close();
    const dir = join(root, 'output', 'runs', 'run-a');
    mkdirSync(join(dir, 'defects'), { recursive: true });
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ run_id: 'run-a', directory_context: { session_id: 'session-a' } }));
    writeFileSync(join(dir, 'defects', 'defect-records.json'), JSON.stringify({ run_id: 'run-a', records: [{ defect_id: 'D-1' }, { defect_id: 'D-2' }] }));
    const result = reconcileDefectLedgers({ dbPath, projectId: 'project-a', mapping: [
      { sessionId: 'session-a', runId: 'run-a', defectId: 'D-1', qaDefectId: 'bug-a', caseKey: 'case-a' },
      { sessionId: 'session-a', runId: 'run-a', defectId: 'D-2', qaDefectId: 'bug-a', caseKey: 'case-a' },
    ] });
    assert.deepEqual(result.findings.map(item => item.kind), ['duplicate_qa_occurrence_mapping']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
