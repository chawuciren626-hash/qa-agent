import { createHash } from 'node:crypto';
import { HttpError } from '../http/errors.js';
import { DOCUMENT_MAX_BYTES, QaProjectKnowledgeStore, type DocumentDetail } from './qa-project-knowledge.js';
import { FORMAT_BY_EXTENSION } from './qa-knowledge-library.js';

interface PersonalDocument { id: string; name: string; kind: string; content: string; encoding: string; revision: string; }
type LoadPersonal = (projectId: string, userId: string, id: string) => Promise<PersonalDocument>;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

/** Explicit one-way promotion. Personal files remain private; project revisions are immutable copies. */
export class QaLibraryReference {
  constructor(private readonly store: QaProjectKnowledgeStore, private readonly load: LoadPersonal) {}

  private documentId(projectId: string, userId: string, itemId: string) {
    return `doc-library-${digest(JSON.stringify([projectId, userId, itemId]))}`;
  }

  private linked(projectId: string, userId: string, itemId: string): DocumentDetail | null {
    try { return this.store.getDocument(projectId, this.documentId(projectId, userId, itemId)); }
    catch (error) { if (error instanceof HttpError && error.status === 404) return null; throw error; }
  }

  private async source(projectId: string, userId: string, itemId: string) {
    if (!/^[a-f0-9-]{36}$/.test(itemId)) throw new HttpError(400, 'invalid_library_item', '资料标识无效。');
    let file: PersonalDocument;
    try { file = await this.load(projectId, userId, itemId); }
    catch (error) {
      const status = (error as {status?: number}).status;
      if (status === 404) throw new HttpError(404, 'library_item_missing', '原资料不存在或已删除。');
      throw error;
    }
    const format = FORMAT_BY_EXTENSION[file.name.split('.').pop()?.toLowerCase() ?? ''];
    if (file.kind !== 'file' || !format) throw new HttpError(400, 'library_format_unsupported', '仅支持将文本资料纳入项目参考资料；文件夹、链接及未解析文件仍可保存在我的资料中。');
    const bytes = Buffer.from(file.content, file.encoding === 'base64' ? 'base64' : 'utf8');
    if (bytes.length > DOCUMENT_MAX_BYTES) throw new HttpError(413, 'document_too_large', '项目参考文本不能超过 2 MiB。');
    let content: string;
    try { content = new TextDecoder('utf-8', {fatal:true}).decode(bytes); }
    catch { throw new HttpError(400, 'library_encoding_unsupported', '该文件不是有效的 UTF-8 文本，不能直接纳入参考资料。'); }
    return {file, format, content, contentHash:`sha256:${digest(content)}`};
  }

  async preview(projectId: string, userId: string, itemId: string) {
    const source = await this.source(projectId, userId, itemId);
    const linked = this.linked(projectId, userId, itemId);
    const ref = `local-library:${itemId}:${source.file.revision}:${source.contentHash}`;
    return {
      source: {itemId, name:source.file.name, revision:source.file.revision, contentHash:source.contentHash, byteSize:Buffer.byteLength(source.content)},
      reference: linked ? {documentId:linked.document.documentId, revision:linked.document.revision, status:linked.document.status,
        sameSourceRevision:linked.document.source.ref === ref,
        matchesSource:linked.document.contentHash === source.contentHash && linked.document.title === source.file.name,
      } : null,
      destination:'local_project', notice:'确认后将当前文本版本纳入本机项目参考资料，按项目权限可见；不上传服务端。原资料保留，后续修改需要再次确认更新。',
    };
  }

  async promote(projectId: string, userId: string, itemId: string, input: {confirmed?: unknown; sourceRevision?: unknown; contentHash?: unknown; expectedDocumentRevision?: unknown}) {
    if (input.confirmed !== true) throw new HttpError(400, 'library_confirmation_required', '请明确确认纳入项目参考资料。');
    const source = await this.source(projectId, userId, itemId);
    if (source.file.revision !== input.sourceRevision || source.contentHash !== input.contentHash) throw new HttpError(409, 'library_source_changed', '原资料已更新，请重新预览后确认。');
    const linked = this.linked(projectId, userId, itemId);
    const provenance = {type:'upload' as const, filename:source.file.name, ref:`local-library:${itemId}:${source.file.revision}:${source.contentHash}`, capturedAt:new Date().toISOString()};
    if (linked?.document.status === 'archived') throw new HttpError(409, 'document_archived', '关联参考资料已归档，历史仍保留；不会自动重新启用。');
    if (linked && linked.document.format !== source.format) throw new HttpError(409, 'library_format_changed', '原资料的格式已改变，请恢复原格式后更新，或作为新资料单独纳入。');
    if (linked && linked.document.source.ref === provenance.ref && linked.document.contentHash === source.contentHash && linked.document.title === source.file.name) return {idempotent:true, document:linked};
    if ((linked?.document.revision ?? null) !== input.expectedDocumentRevision) throw new HttpError(409, 'document_revision_conflict', '项目参考资料已变化，请重新预览后确认，避免覆盖其他修订。');
    const document = linked
      ? this.store.updateDocument({projectId, userId, documentId:linked.document.documentId, expectedRevision:linked.document.revision,
          title:source.file.name, content:source.content, internalSource:provenance, changeNote:`从我的资料更新，源修订 ${source.file.revision}`})
      : this.store.createDocument({projectId, userId, internalDocumentId:this.documentId(projectId,userId,itemId), title:source.file.name,
          content:source.content, format:source.format, source:provenance, changeNote:`从我的资料纳入，源修订 ${source.file.revision}`});
    return {idempotent:false, document};
  }
}
