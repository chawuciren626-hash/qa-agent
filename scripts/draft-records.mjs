import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { readRunFile, runDirectory, textLengths } from './design-quality.mjs';
import { withRunLock, writeJson, assertStageHistory } from './orchestration-state.mjs';
import { assertUnlinked } from './skill-resources.mjs';
import { CommandUsageError, safeInputName } from './command-contracts.mjs';

const contracts = {
  test_points: { path: 'design/test_points.json', id: 'id', keys: ['points', 'test_points'] },
  test_cases: { path: 'design/test_cases.json', id: 'case_id', keys: ['cases', 'test_cases'] }
};
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const requireInput = (ok, message) => { if (!ok) throw new CommandUsageError(message); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
function parseDraft(bytes) {
  try { return JSON.parse(bytes); }
  catch { throw new CommandUsageError('现有草稿JSON不可解析；保留原文件，修正语法后再inspect，不重建整个阶段。'); }
}
function collection(value, contract) {
  const keys = contract.keys.filter(key => Array.isArray(value?.[key]));
  requireInput(Array.isArray(value) || keys.length === 1, '草稿必须是数组或仅含一个支持的条目集合；保留原文件并修正格式。');
  const rows = Array.isArray(value) ? value : value[keys[0]];
  requireInput(rows.every(row => object(row) && typeof row[contract.id] === 'string' && row[contract.id].trim()), '条目缺少稳定ID；本批次未写入。');
  requireInput(new Set(rows.map(row => row[contract.id])).size === rows.length, '存在重复ID；本批次未写入。');
  return { rows, replace: next => Array.isArray(value) ? next : { ...value, [keys[0]]: next } };
}
export function validateDraftOperation(operation) {
  requireInput(object(operation) && ['inspect', 'upsert', 'seed'].includes(operation.type), 'draft_records.operation.type应为inspect、upsert或seed。');
  const fields = operation.type === 'inspect' ? ['type', 'ids'] : operation.type === 'seed' ? ['type', 'request_id', 'base_sha256', 'source_path'] : ['type', 'request_id', 'base_sha256', 'entries', 'samples'];
  requireInput(Object.keys(operation).every(key => fields.includes(key)), '未知草稿操作字段；本批次未写入。');
  if (operation.type === 'inspect') {
    requireInput(operation.ids === undefined || (Array.isArray(operation.ids) && operation.ids.length <= 20 && operation.ids.every(id => typeof id === 'string')), 'inspect.ids最多20个ID。');
    return;
  }
  requireInput(/^[A-Za-z0-9_-]{1,80}$/.test(operation.request_id ?? ''), '使用稳定request_id；不确定写入结果时重用同一请求。');
  requireInput(/^(?:missing|[a-f0-9]{64})$/.test(operation.base_sha256 ?? ''), '先inspect获取base_sha256；新文件使用missing。');
  if (operation.type === 'seed') {
    requireInput(operation.base_sha256 === 'missing' && /^inputs\//.test(operation.source_path ?? '') && safeInputName(operation.source_path.slice(7)), 'seed仅从本run已归档inputs文件初始化缺失草稿；不覆盖已有草稿。');
    return;
  }
  requireInput(Array.isArray(operation.entries) && operation.entries.length > 0 && operation.entries.length <= 20 && operation.entries.every(object), '每批1至20条完整条目；更新按ID替换整条，其他条目不变。');
  requireInput(Buffer.byteLength(JSON.stringify(operation)) <= 128 * 1024, '批次过大；拆成更小批次，不缩减测试范围。');
  requireInput(operation.samples === undefined || (Array.isArray(operation.samples) && operation.samples.length <= 20), 'samples最多20条。');
}
function status(file, contract, ids = []) {
  const { rows } = collection(file ? parseDraft(file.data) : [], contract);
  return { path: contract.path, sha256: file?.sha256 ?? 'missing', count: rows.length, ids: rows.map(row => row[contract.id]),
    entries: rows.filter(row => ids.includes(row[contract.id])), validation_required: true };
}
function ownedDraft(manifest, stage, parent) {
  assertStageHistory(manifest, stage);
  const dispatch = manifest.orchestration?.events?.filter(event => event.stage === stage && event.type === 'dispatched').at(-1);
  requireInput(manifest.stages?.[stage]?.status === 'in_progress' && dispatch?.['parent-session-id'] === parent &&
    dispatch.dispatch_id === manifest.stages[stage].dispatch_id, '仅当前所属设计子任务可写草稿；不要新建run绕过，先沿用现有派发。');
  const latest = (manifest.confirmations ?? []).filter(item => item.stage === stage).at(-1);
  requireInput(!['pending', 'approved', 'rejected'].includes(latest?.status), '确认版本不得直接改写；使用既有修订流程保留历史。');
  return dispatch;
}
export function draftRecords(root, parent, request) {
  validateDraftOperation(request.operation);
  const contract = contracts[request.stage];
  requireInput(contract, 'draft_records仅支持test_points和test_cases，不写执行证据。');
  const dir = runDirectory(root, request.run_id), project = JSON.parse(readFileSync(resolve(root, 'config/project.json')));
  return withRunLock(root, project, request.run_id, () => {
    const manifest = JSON.parse(readRunFile(dir, 'manifest.json').data);
    const dispatch = ownedDraft(manifest, request.stage, parent);
    const target = resolve(dir, contract.path);
    assertUnlinked(dir, target);
    const current = existsSync(target) ? readRunFile(dir, contract.path) : null;
    const op = request.operation;
    if (op.type === 'inspect') return status(current, contract, op.ids);
    const key = digest(`${dispatch.dispatch_id}:${op.request_id}`), operationHash = digest(JSON.stringify(op));
    const audit = `audit/draft-batches/${key}.json`, auditPath = resolve(dir, audit);
    assertUnlinked(dir, auditPath);
    if (existsSync(auditPath)) {
      const record = JSON.parse(readRunFile(dir, audit).data);
      requireInput(record.operation_sha256 === operationHash, '同一request_id内容发生变化；先inspect，再用新ID提交修正批次。');
      if (record.status === 'applied' || current?.sha256 === record.after_sha256) {
        if (record.status !== 'applied') writeJson(auditPath, { ...record, status: 'applied' });
        return { ...status(current, contract), already_applied: true, batch_sha256: record.after_sha256, audit };
      }
      requireInput((current?.sha256 ?? 'missing') === record.before_sha256, '中断后草稿版本已变化；先inspect，不覆盖现有进展。');
      if (record.seed) requireInput(readRunFile(dir, record.seed.path).sha256 === record.seed.sha256, '中断后种子来源已变化；保留审计，使用新批次重新核验。');
    }
    requireInput((current?.sha256 ?? 'missing') === op.base_sha256, `草稿版本冲突，当前sha256=${current?.sha256 ?? 'missing'}；先inspect读取待修改ID，重新合并，不全量重写。`);
    if (op.type === 'seed') requireInput(existsSync(resolve(dir, op.source_path)), 'seed来源不存在；使用派发给出的inputs路径，不重建run。');
    const seed = op.type === 'seed' ? readRunFile(dir, op.source_path) : null;
    const value = current ? parseDraft(current.data) : seed ? parseDraft(seed.data) : [];
    const existing = collection(value, contract), entries = op.type === 'seed' ? [] : structuredClone(op.entries);
    collection(entries, contract);
    for (const sample of op.samples ?? []) {
      requireInput(request.stage === 'test_cases' && object(sample) && Object.keys(sample).every(key => ['case_id', 'key', 'unit', 'count'].includes(key)), 'samples仅用于用例test_data字段。');
      const entry = entries.find(row => row.case_id === sample.case_id);
      requireInput(entry && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(sample.key ?? '') && typeof sample.unit === 'string' && [...sample.unit].length === 1 && Number.isInteger(sample.count) && sample.count >= 0 && sample.count <= 10000, '样例需要本批次case_id、安全字段名、一个Unicode码点unit及0至10000的count。');
      requireInput(entry.test_data === undefined || object(entry.test_data), 'test_data必须是对象。');
      entry.test_data ??= {};
      entry.test_data[sample.key] = sample.unit.repeat(sample.count);
    }
    const updates = new Map(entries.map(row => [row[contract.id], row]));
    const merged = existing.rows.map(row => updates.get(row[contract.id]) ?? row);
    const oldIds = new Set(existing.rows.map(row => row[contract.id]));
    merged.push(...entries.filter(row => !oldIds.has(row[contract.id])));
    const next = existing.replace(merged);
    if (seed && !Array.isArray(next) && Object.hasOwn(next, 'run_id')) next.run_id = request.run_id;
    const bytes = Buffer.from(JSON.stringify(next, null, 2) + '\n');
    const before = current?.sha256 ?? 'missing', after = digest(bytes);
    mkdirSync(resolve(dir, 'audit/draft-batches'), { recursive: true });
    const backup = `audit/draft-batches/${key}.before.json`;
    assertUnlinked(dir, resolve(dir, backup));
    if (current && !existsSync(resolve(dir, backup))) writeFileSync(resolve(dir, backup), current.data, { flag: 'wx' });
    const record = { version: 1, request_id: op.request_id, dispatch_id: dispatch.dispatch_id, stage: request.stage,
      operation_sha256: operationHash, before_sha256: before, after_sha256: after, changed_ids: [...updates.keys()], status: 'prepared',
      ...(seed ? { seed: { path: op.source_path, sha256: seed.sha256 }, inherited_approval: false } : {}) };
    writeJson(auditPath, record);
    mkdirSync(resolve(dir, 'design'), { recursive: true });
    writeJson(target, next);
    writeJson(auditPath, { ...record, status: 'applied' });
    return { ...status({ data: bytes, sha256: after }, contract), audit, changed_ids: record.changed_ids,
      measurements: entries.flatMap(row => Object.entries(row.test_data ?? {}).filter(([, value]) => typeof value === 'string').map(([key, value]) => ({ case_id: row.case_id, key, ...textLengths(value) }))),
      next_action: '继续下一批；完成后diagnose、export并validate。保存成功不代表内容校验或阶段完成。' };
  });
}

export function reuseDesignArtifact(root, parent, request) {
  requireInput(/^run-[A-Za-z0-9-]+$/.test(request.source_run_id ?? '') && request.source_run_id !== request.run_id, '来源必须是本会话另一个已完成设计run；优先继续原run。');
  requireInput(safeInputName(request.name) && request.name.endsWith('.json'), '复用目标为安全JSON文件名。');
  const contract = contracts[request.stage];
  requireInput(contract, '仅复用测试点/用例设计；不复制执行证据、授权、环境或凭据。');
  const source = runDirectory(root, request.source_run_id), target = runDirectory(root, request.run_id);
  requireInput(existsSync(resolve(source, 'manifest.json')), '来源run不存在于当前工作区；复制实际run_id，不扫描其他会话。');
  const project = JSON.parse(readFileSync(resolve(root, 'config/project.json')));
  return withRunLock(root, project, request.source_run_id, () => withRunLock(root, project, request.run_id, () => {
    const sourceManifest = JSON.parse(readRunFile(source, 'manifest.json').data);
    const targetManifest = JSON.parse(readRunFile(target, 'manifest.json').data);
    const context = JSON.parse(readRunFile(target, 'audit/user-input-context.json').data);
    requireInput(context.session_id === parent, '目标运行不属于当前父会话。');
    requireInput(!Object.values(targetManifest.stages ?? {}).some(stage => stage.status === 'in_progress'), '先导入再派发，避免子任务读取中途变化的输入。');
    assertStageHistory(sourceManifest, request.stage);
    const completed = sourceManifest.orchestration?.events?.filter(event => event.stage === request.stage && event.type === 'completed').at(-1);
    requireInput(sourceManifest.stages?.[request.stage]?.status === 'completed' && completed?.type === 'completed' && completed['parent-session-id'] === parent, '来源不是当前父会话已交付的设计，不扫描其他会话或归档目录。');
    const sealed = completed.evidence?.artifact_contract?.files?.find(file => file.path === contract.path);
    const file = readRunFile(source, contract.path);
    requireInput(sealed?.sha256 === file.sha256, '来源已变更或缺少交付校验，不复制未核验版本。');
    collection(JSON.parse(file.data), contract);
    const path = `inputs/${request.name}`, output = resolve(target, path);
    assertUnlinked(target, output);
    const receiptPath = resolve(target, `audit/reused-design-${digest(path)}.json`);
    assertUnlinked(target, receiptPath);
    const receipt = { version: 1, source_run_id: request.source_run_id, source_path: contract.path, source_sha256: file.sha256,
      path, session_id: parent, draft_only: true, approval_granted: false, execution_started: false };
    if (existsSync(output)) requireInput(readRunFile(target, path).sha256 === file.sha256, '同名输入已有不同内容；保留原文件，选择新名称。');
    if (existsSync(receiptPath)) requireInput(JSON.stringify(JSON.parse(readFileSync(receiptPath))) === JSON.stringify(receipt), '同名输入的复用来源不同；使用新名称保留来源。');
    mkdirSync(resolve(target, 'audit'), { recursive: true });
    writeJson(receiptPath, receipt);
    if (!existsSync(output)) {
      const temporary = `${output}.${randomUUID()}.tmp`;
      try {
        writeFileSync(temporary, file.data, { flag: 'wx' });
        requireInput(!existsSync(output), '导入期间出现同名输入；保留它，不覆盖。');
        renameSync(temporary, output);
      } finally { if (existsSync(temporary)) unlinkSync(temporary); }
    }
    return { ...receipt, sha256: file.sha256, next_action: '将此输入路径交给子任务；按当前需求复核，不沿用原运行批准或完成状态。' };
  }));
}
