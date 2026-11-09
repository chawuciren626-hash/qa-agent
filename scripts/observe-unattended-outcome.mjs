import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { directoryContext } from './directory-context.mjs';
import { runDirectory, readRunFile } from './design-quality.mjs';
import { summarizeRun } from './run-status-summary.mjs';
import { assertCompletedArtifacts } from './artifact-contracts.mjs';

// Read-only observer. Workflow completion does not claim the tested product passed.
const root = fileURLToPath(new URL('../', import.meta.url));
function observe(since) {
  const cutoff = Date.parse(since);
  if (!Number.isFinite(cutoff)) return null;
  const context = directoryContext(root);
  if (context.mode !== 'isolated') return null;
  let count = 0;
  let pending = false;
  for (const runId of readdirSync(context.run_root)) {
    if (!/^run-[A-Za-z0-9-]+$/.test(runId)) continue;
    try {
      const raw = readRunFile(runDirectory(root, runId), 'manifest.json').data;
      const manifest = JSON.parse(raw);
      if (!Number.isFinite(Date.parse(manifest.created_at)) || Date.parse(manifest.created_at) < cutoff) continue;
      count++;
      const summary = summarizeRun(raw, runId);
      if (summary.consistency !== 'consistent') { pending = true; continue; }
      if (summary.derived_status === 'failed') return 'failed';
      if (!summary.workflow_closed || summary.derived_status !== 'completed') { pending = true; continue; }
      for (const stage of summary.stages.filter(item => item.selected && item.status === 'completed')) {
        assertCompletedArtifacts(root, runId, manifest, stage.id);
      }
    } catch { pending = true; }
  }
  return count > 0 && !pending ? 'succeeded' : null;
}
try { process.stdout.write(JSON.stringify(observe(process.argv[2]))); }
catch { process.stdout.write('null'); }
