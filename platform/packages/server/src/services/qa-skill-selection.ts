/**
 * Round-scoped personal Skill selections.
 *
 * A selection is a private, user/project-scoped record that pins the imported resource
 * version and copies its Skill files into a snapshot. It never writes into an Agent's
 * installed `skills/` directory, so the default Skill set stays untouched and the next
 * round does not inherit the choice.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { HttpError } from '../http/errors.js';

export const DEFAULT_SELECTION_TTL_MS = 6 * 60 * 60 * 1000;
const SKILL_NAME = /^[A-Za-z0-9_-]+$/;
const TARGET_ID = /^[A-Za-z0-9_-]{1,120}$/;

export interface PersonalSkillResource {
  id: string;
  name: string;
  kind: 'skill' | 'plugin';
  version?: number;
  contentHash?: string;
  createdAt: string;
  skills: { name: string; files: Record<string, string> }[];
}

export interface SkillPick { resourceId: string; skills?: string[] }

export interface SelectionFile { path: string; sha256: string }

export interface SelectionSkill {
  name: string;
  resourceId: string;
  resourceName: string;
  resourceVersion: number;
  contentHash: string;
  files: SelectionFile[];
}

export interface SelectionResource {
  resourceId: string;
  name: string;
  version: number;
  contentHash: string;
  skills: string[];
}

export interface RoundSkillSelection {
  id: string;
  projectId: string;
  sessionId: string;
  agentId: string;
  round: number;
  roundKey?: string;
  status: 'active' | 'consumed' | 'superseded' | 'expired';
  createdAt: string;
  expiresAt: string;
  consumedAt?: string;
  supersededAt?: string;
  authorization: { userId: string; projectId: string; sessionId: string; agentId: string };
  resources: SelectionResource[];
  skills: SelectionSkill[];
}

export interface SelectionView {
  selectionId: string;
  scope: 'round';
  status: RoundSkillSelection['status'];
  round: number;
  projectId: string;
  sessionId: string;
  agentId: string;
  createdAt: string;
  expiresAt: string;
  consumedAt?: string;
  resources: SelectionResource[];
  skills: { name: string; resourceId: string; resourceName: string; resourceVersion: number; contentHash: string }[];
}

const digest = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const nowIso = (now: number) => new Date(now).toISOString();

export function selectionDirectory(root: string, userHash: string, projectId: string): string {
  return path.join(root, '.qa-skill-selections', userHash, projectId);
}

export function skillResourceFingerprint(resource: PersonalSkillResource): string {
  const rows: string[] = [];
  for (const skill of resource.skills) {
    for (const name of Object.keys(skill.files).sort()) {
      rows.push(`${skill.name}/${name}:${digest(Buffer.from(skill.files[name]!, 'base64'))}`);
    }
  }
  return `sha256:${digest(rows.join('\n'))}`;
}

export function skillResourceVersion(resource: PersonalSkillResource): number {
  return Number.isSafeInteger(resource.version) && Number(resource.version) > 0 ? Number(resource.version) : 1;
}

async function readPersonalResource(resourceDir: string, resourceId: string): Promise<PersonalSkillResource> {
  if (!TARGET_ID.test(resourceId)) throw new HttpError(404, 'resource_not_found', '个人资源不存在。');
  try {
    const resource = JSON.parse(await fs.readFile(path.join(resourceDir, `${resourceId}.json`), 'utf8')) as PersonalSkillResource;
    if (!resource || typeof resource !== 'object' || !Array.isArray(resource.skills)) throw new HttpError(404, 'resource_not_found', '个人资源不存在。');
    return resource;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new HttpError(404, 'resource_not_found', '个人资源不存在。');
    throw error;
  }
}

function safeSkillPath(rel: string): string[] {
  if (typeof rel !== 'string' || !rel || rel.includes('\\') || path.posix.isAbsolute(rel)) throw new HttpError(409, 'invalid_resource_file', 'Skill 文件路径不安全。');
  const parts = rel.split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) throw new HttpError(409, 'invalid_resource_file', 'Skill 文件路径不安全。');
  return parts;
}

async function saveSelection(dir: string, selection: RoundSkillSelection): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${selection.id}.json`);
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temp, JSON.stringify(selection));
    await fs.rename(temp, file);
  } finally {
    await fs.rm(temp, { force: true });
  }
}

async function readSelection(dir: string, id: string, now: number): Promise<RoundSkillSelection> {
  if (!TARGET_ID.test(id)) throw new HttpError(404, 'selection_not_found', '本轮选择不存在。');
  let selection: RoundSkillSelection;
  try {
    selection = JSON.parse(await fs.readFile(path.join(dir, `${id}.json`), 'utf8')) as RoundSkillSelection;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new HttpError(404, 'selection_not_found', '本轮选择不存在。');
    throw error;
  }
  if (selection.status === 'active' && Date.parse(selection.expiresAt) <= now) {
    selection.status = 'expired';
    await saveSelection(dir, selection).catch(() => undefined);
    await fs.rm(snapshotRoot(dir, selection.id), { recursive: true, force: true }).catch(() => undefined);
  }
  return selection;
}

function snapshotRoot(dir: string, selectionId: string): string {
  return path.join(dir, 'snapshots', selectionId);
}

async function listSelections(dir: string, now: number): Promise<RoundSkillSelection[]> {
  let names: string[];
  try { names = await fs.readdir(dir); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  const selections: RoundSkillSelection[] = [];
  for (const name of names.filter(item => /^[a-zA-Z0-9-]+\.json$/.test(item) && !item.endsWith('.tmp'))) {
    const id = name.slice(0, -5);
    try { selections.push(await readSelection(dir, id, now)); } catch { /* An unreadable record is not a usable selection. */ }
  }
  return selections.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
}

export function selectionView(selection: RoundSkillSelection): SelectionView {
  return {
    selectionId: selection.id,
    scope: 'round',
    status: selection.status,
    round: selection.round,
    projectId: selection.projectId,
    sessionId: selection.sessionId,
    agentId: selection.agentId,
    createdAt: selection.createdAt,
    expiresAt: selection.expiresAt,
    ...(selection.consumedAt ? { consumedAt: selection.consumedAt } : {}),
    resources: selection.resources,
    skills: selection.skills.map(skill => ({
      name: skill.name,
      resourceId: skill.resourceId,
      resourceName: skill.resourceName,
      resourceVersion: skill.resourceVersion,
      contentHash: skill.contentHash
    }))
  };
}

function selectionSignature(resources: SelectionResource[]): string {
  return resources
    .map(resource => `${resource.resourceId}:${[...resource.skills].sort().join(',')}`)
    .sort()
    .join('|');
}

export async function createRoundSelection(input: {
  dir: string;
  resourceDir: string;
  projectId: string;
  userId: string;
  sessionId: string;
  agentId: string;
  picks: SkillPick[];
  roundKey?: string;
  protectedNames?: Set<string>;
  now?: number;
  ttlMs?: number;
}): Promise<{ selection: RoundSkillSelection; idempotent: boolean }> {
  const now = input.now ?? Date.now();
  const ttlMs = input.ttlMs ?? DEFAULT_SELECTION_TTL_MS;
  if (!TARGET_ID.test(input.sessionId) || !TARGET_ID.test(input.agentId)) throw new HttpError(400, 'invalid_selection', '任务或智能体标识无效。');
  if (!Array.isArray(input.picks) || !input.picks.length || input.picks.length > 20) throw new HttpError(400, 'invalid_selection', '请选择 1 至 20 个个人资源。');
  const ids = input.picks.map(pick => pick?.resourceId);
  if (ids.some(id => typeof id !== 'string' || !id) || new Set(ids).size !== ids.length) throw new HttpError(400, 'invalid_selection', '个人资源不能重复选择。');
  for (const pick of input.picks) {
    if (pick.skills !== undefined && (!Array.isArray(pick.skills) || !pick.skills.length || pick.skills.some(name => typeof name !== 'string' || !SKILL_NAME.test(name)) || new Set(pick.skills).size !== pick.skills.length)) {
      throw new HttpError(400, 'invalid_selection', '技能选择无效。');
    }
  }

  const existing = await listSelections(input.dir, now);

  const protectedNames = new Set([...(input.protectedNames ?? [])].map(name => name.toLowerCase()));
  const byName = new Map<string, string>();
  const resources: SelectionResource[] = [];
  const resolved: { resource: PersonalSkillResource; version: number; contentHash: string; selected: { name: string; files: Record<string, string> }[] }[] = [];
  for (const pick of input.picks) {
    const resource = await readPersonalResource(input.resourceDir, pick.resourceId);
    if (resource.kind !== 'skill' && resource.kind !== 'plugin') throw new HttpError(400, 'resource_kind_invalid', '只能选择个人 Skill 资源。');
    if (!resource.skills.length) throw new HttpError(409, 'resource_kind_invalid', '个人资源中没有可选择的 Skill。');
    const available = new Map(resource.skills.map(skill => [skill.name, skill]));
    const names = pick.skills ?? [...available.keys()];
    const selected = names.map(name => {
      const skill = available.get(name);
      if (!skill) throw new HttpError(404, 'skill_not_in_resource', `资源中不存在 Skill：${name}`);
      if (!SKILL_NAME.test(skill.name)) throw new HttpError(409, 'invalid_resource_file', 'Skill 名称无效。');
      if (protectedNames.has(skill.name.toLowerCase())) throw new HttpError(409, 'protected_skill', `不能选择内置测试 Skill：${skill.name}`);
      const key = skill.name.toLowerCase();
      if (byName.has(key)) throw new HttpError(409, 'skill_selection_conflict', `多个资源包含同名 Skill：${skill.name}`);
      byName.set(key, resource.id);
      return skill;
    });
    const version = skillResourceVersion(resource);
    const contentHash = resource.contentHash ?? skillResourceFingerprint(resource);
    resources.push({ resourceId: resource.id, name: resource.name, version, contentHash, skills: selected.map(skill => skill.name) });
    resolved.push({ resource, version, contentHash, selected });
  }

  if (input.roundKey) {
    const duplicate = existing.find(item => item.roundKey === input.roundKey && item.sessionId === input.sessionId && item.agentId === input.agentId);
    if (duplicate) {
      if (selectionSignature(duplicate.resources) !== selectionSignature(resources)) {
        throw new HttpError(409, 'selection_conflict', '同一请求标识的选择内容不一致。');
      }
      return { selection: duplicate, idempotent: true };
    }
  }

  const sameTarget = existing.filter(item => item.sessionId === input.sessionId && item.agentId === input.agentId);
  const round = Math.max(0, ...sameTarget.map(item => item.round)) + 1;
  const id = randomUUID();
  const createdAt = nowIso(now);
  const expiresAt = nowIso(now + ttlMs);
  const skills: SelectionSkill[] = [];
  try {
    for (const item of resolved) {
      for (const skill of item.selected) {
        const rows: SelectionFile[] = [];
        for (const rel of Object.keys(skill.files).sort()) {
          const parts = safeSkillPath(rel);
          const bytes = Buffer.from(skill.files[rel]!, 'base64');
          const dest = path.join(snapshotRoot(input.dir, id), skill.name, ...parts);
          await fs.mkdir(path.dirname(dest), { recursive: true });
          await fs.writeFile(dest, bytes);
          rows.push({ path: rel, sha256: digest(bytes) });
        }
        skills.push({
          name: skill.name,
          resourceId: item.resource.id,
          resourceName: item.resource.name,
          resourceVersion: item.version,
          contentHash: `sha256:${digest(rows.map(row => `${row.path}:${row.sha256}`).join('\n'))}`,
          files: rows
        });
      }
    }
    const selection: RoundSkillSelection = {
      id,
      projectId: input.projectId,
      sessionId: input.sessionId,
      agentId: input.agentId,
      round,
      ...(input.roundKey ? { roundKey: input.roundKey } : {}),
      status: 'active',
      createdAt,
      expiresAt,
      authorization: { userId: input.userId, projectId: input.projectId, sessionId: input.sessionId, agentId: input.agentId },
      resources,
      skills
    };
    await saveSelection(input.dir, selection);
    for (const prior of sameTarget.filter(item => item.status === 'active')) {
      prior.status = 'superseded';
      prior.supersededAt = createdAt;
      await saveSelection(input.dir, prior);
      await fs.rm(snapshotRoot(input.dir, prior.id), { recursive: true, force: true }).catch(() => undefined);
    }
    return { selection, idempotent: false };
  } catch (error) {
    await fs.rm(snapshotRoot(input.dir, id), { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

export async function currentSelection(input: { dir: string; sessionId: string; agentId: string; now?: number }): Promise<RoundSkillSelection | null> {
  if (!TARGET_ID.test(input.sessionId) || !TARGET_ID.test(input.agentId)) throw new HttpError(400, 'invalid_selection', '任务或智能体标识无效。');
  const now = input.now ?? Date.now();
  const items = await listSelections(input.dir, now);
  return items.find(item => item.status === 'active' && item.sessionId === input.sessionId && item.agentId === input.agentId) ?? null;
}

export async function getSelection(input: { dir: string; id: string; now?: number }): Promise<RoundSkillSelection> {
  return readSelection(input.dir, input.id, input.now ?? Date.now());
}

export async function consumeSelection(input: { dir: string; id: string; now?: number }): Promise<{ selection: RoundSkillSelection; idempotent: boolean }> {
  const now = input.now ?? Date.now();
  const selection = await readSelection(input.dir, input.id, now);
  if (selection.status === 'consumed') return { selection, idempotent: true };
  if (selection.status !== 'active') throw new HttpError(409, 'selection_not_active', '本轮选择已过期或已被取代。');
  selection.status = 'consumed';
  selection.consumedAt = nowIso(now);
  await saveSelection(input.dir, selection);
  return { selection, idempotent: false };
}

export async function cancelSelection(input: { dir: string; id: string; now?: number }): Promise<void> {
  const selection = await readSelection(input.dir, input.id, input.now ?? Date.now());
  if (selection.status === 'consumed') throw new HttpError(409, 'selection_not_active', '已使用的选择保留审计记录，不能删除。');
  await fs.rm(path.join(input.dir, `${selection.id}.json`), { force: true });
  await fs.rm(snapshotRoot(input.dir, selection.id), { recursive: true, force: true }).catch(() => undefined);
}

export async function selectionSkillFiles(input: { dir: string; id: string; skillName: string; now?: number }): Promise<{ skill: SelectionSkill; files: { path: string; contentBase64: string; sha256: string }[] }> {
  const selection = await readSelection(input.dir, input.id, input.now ?? Date.now());
  if (selection.status === 'expired' || selection.status === 'superseded') throw new HttpError(409, 'selection_not_active', '本轮选择已过期或已被取代。');
  const skill = selection.skills.find(item => item.name === input.skillName);
  if (!skill) throw new HttpError(404, 'skill_not_in_resource', `本轮选择中没有 Skill：${input.skillName}`);
  const files: { path: string; contentBase64: string; sha256: string }[] = [];
  for (const file of skill.files) {
    const parts = safeSkillPath(file.path);
    const bytes = await fs.readFile(path.join(snapshotRoot(input.dir, selection.id), skill.name, ...parts)).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new HttpError(410, 'selection_snapshot_missing', '本轮选择的内容快照已不可读取。');
      throw error;
    });
    files.push({ path: file.path, contentBase64: bytes.toString('base64'), sha256: digest(bytes) });
  }
  return { skill, files };
}

export async function activeSelectionReferences(input: { dir: string; resourceId: string; now?: number }): Promise<RoundSkillSelection[]> {
  const items = await listSelections(input.dir, input.now ?? Date.now());
  return items.filter(item => item.status === 'active' && item.resources.some(resource => resource.resourceId === input.resourceId));
}
