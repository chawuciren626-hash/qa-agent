import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { getRunContext, writeJson } from './orchestration-state.mjs';

const root = resolve(import.meta.dirname, '..');
const project = JSON.parse(readFileSync(resolve(root, 'config/project.json'), 'utf8'));
const [runId, artifact, reason] = process.argv.slice(2);
if (!runId || !artifact || !reason) throw new Error('Usage: remove-missing-artifact <run_id> <artifact> <reason>');
const { manifestPath, manifest } = getRunContext(root, project, runId);
if (!manifest.artifacts?.includes(artifact)) throw new Error('Artifact is not registered.');
if (existsSync(resolve(dirname(manifestPath), artifact))) throw new Error('Refusing to remove a reference to an existing artifact.');
manifest.artifacts = manifest.artifacts.filter(item => item !== artifact);
manifest.orchestration ??= { events: [] };
manifest.orchestration.events ??= [];
manifest.orchestration.events.push({ type: 'missing_artifact_reference_removed', at: new Date().toISOString(), artifact, reason });
manifest.updated_at = new Date().toISOString();
writeJson(manifestPath, manifest);
console.log(JSON.stringify({ run_id: runId, removed: artifact, reason }));
