/**
 * Local user preferences: the signed-in user's own cross-project notes, kept outside every
 * Project and keyed by the authenticated user id. This card is the explicit entry point —
 * nothing here is inferred from conversations, task summaries or tool output, and a preference
 * only reaches a task after the user saves it here (or imports a document).
 *
 * Disabling keeps the entry and stops it from entering the next task; deleting removes it.
 * Both take effect from the next task: a running task keeps the snapshot it started with.
 * Export/import move the whole set as one document whose entries carry content hashes; an
 * import is previewed (file, size, hash, receiver, scope, plan) before anything is written,
 * and the file must still hold the previewed bytes when the user confirms.
 */
import { useCallback, useEffect, useState } from "react";
import type { ChangeEvent } from "react";
import type {
  UserPreferenceDto,
  UserPreferenceExportDocument,
  UserPreferenceImportResponse,
  UserPreferencesResponse,
} from "@prismshadow/penguin-server/api";
import {
  Button,
  Card,
  ConfirmModal,
  HiddenFileInput,
  Input,
  Modal,
  Notice,
  Textarea,
  toastError,
  toastSuccess,
} from "@prismshadow/penguin-ui";
import * as api from "../../api/endpoints";
import { S } from "../../lib/strings";
import { apiErrorText } from "../../lib/api-error";
import { formatRelativeDate } from "../../lib/format";
import { useLocale } from "../../state/locale";

type ImportMode = "skip" | "overwrite" | "replace";

interface PendingImport {
  fileName: string;
  file: File;
  /** The exact bytes the preview was taken from; the file must still match on confirm. */
  text: string;
  hash: string;
  doc: UserPreferenceExportDocument;
  plan: UserPreferenceImportResponse;
}

async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function isExportDocument(value: unknown): value is UserPreferenceExportDocument {
  if (typeof value !== "object" || value === null) return false;
  const doc = value as Partial<UserPreferenceExportDocument>;
  return (
    doc.format === "penguin-user-preferences" &&
    doc.version === 1 &&
    Array.isArray(doc.entries)
  );
}

export function UserPreferencesCard() {
  const { locale } = useLocale();
  const [data, setData] = useState<UserPreferencesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<{ id?: string; expectedHash?: string } | null>(null);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [removing, setRemoving] = useState<UserPreferenceDto | null>(null);
  const [importing, setImporting] = useState<PendingImport | null>(null);
  const [importMode, setImportMode] = useState<ImportMode>("skip");
  const [importBusy, setImportBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      setData(await api.listUserPreferences());
    } catch (e) {
      setError(apiErrorText(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const openAdd = () => {
    setTitle("");
    setContent("");
    setEditing({});
  };

  const openEdit = (entry: UserPreferenceDto) => {
    setTitle(entry.title);
    setContent(entry.content);
    setEditing({ id: entry.id, expectedHash: entry.contentHash });
  };

  const save = async () => {
    if (!editing || title.trim() === "" || content.trim() === "" || busy) return;
    setBusy(true);
    try {
      const res = editing.id
        ? await api.updateUserPreference(editing.id, {
            title,
            content,
            ...(editing.expectedHash !== undefined
              ? { expectedHash: editing.expectedHash }
              : {}),
          })
        : await api.saveUserPreference({ title, content });
      if (res.conflicts.length > 0) {
        toastSuccess(S.memory.preferencesConflict);
      } else {
        toastSuccess(S.agent.savedTakesEffect);
      }
      setEditing(null);
      await load();
    } catch (e) {
      toastError(apiErrorText(e));
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (entry: UserPreferenceDto) => {
    try {
      await api.setUserPreferenceDisabled(entry.id, !entry.disabled);
      await load();
    } catch (e) {
      toastError(apiErrorText(e));
    }
  };

  const confirmRemove = async () => {
    if (!removing) return;
    const target = removing;
    setRemoving(null);
    try {
      await api.deleteUserPreference(target.id);
      toastSuccess(S.memory.deleteDone);
      await load();
    } catch (e) {
      toastError(apiErrorText(e));
    }
  };

  const exportAll = async () => {
    try {
      const doc = await api.exportUserPreferences();
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(doc, null, 2)], { type: "application/json" }),
      );
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `user-preferences-${doc.exportedAt.slice(0, 10)}.json`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      toastError(apiErrorText(e));
    }
  };

  const runPreview = async (text: string, doc: UserPreferenceExportDocument, mode: ImportMode) => {
    setImportBusy(true);
    try {
      const plan = await api.importUserPreferences({ payload: doc, mode, dryRun: true });
      return plan;
    } finally {
      setImportBusy(false);
    }
  };

  const pickImport = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      const text = await file.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        toastError(S.memory.preferencesImportInvalid);
        return;
      }
      if (!isExportDocument(parsed)) {
        toastError(S.memory.preferencesImportInvalid);
        return;
      }
      const hash = await sha256Hex(text);
      setImportMode("skip");
      const plan = await runPreview(text, parsed, "skip");
      setImporting({ fileName: file.name, file, text, hash, doc: parsed, plan });
    } catch (e) {
      toastError(apiErrorText(e));
    }
  };

  const changeImportMode = async (mode: ImportMode) => {
    if (!importing) return;
    setImportMode(mode);
    try {
      const plan = await runPreview(importing.text, importing.doc, mode);
      setImporting({ ...importing, plan });
    } catch (e) {
      toastError(apiErrorText(e));
    }
  };

  const submitImport = async () => {
    if (!importing || importBusy) return;
    // Bind the confirmation to the version that was previewed: the picked file's bytes are
    // re-read here, so a file swapped between preview and confirm never gets this approval.
    const current = await sha256Hex(await importing.file.text());
    if (current !== importing.hash) {
      toastError(S.memory.preferencesImportChanged);
      setImporting(null);
      return;
    }
    setImportBusy(true);
    try {
      const res = await api.importUserPreferences({
        payload: importing.doc,
        mode: importMode,
        confirm: importMode === "replace",
      });
      const touched = res.added.length + res.overwritten.length + res.removed.length;
      if (touched === 0) toastSuccess(S.memory.preferencesImportNothingNew);
      else
        toastSuccess(
          S.memory.preferencesImportDone(
            res.added.length,
            res.overwritten.length,
            res.removed.length,
          ),
        );
      setImporting(null);
      await load();
    } catch (e) {
      toastError(apiErrorText(e));
    } finally {
      setImportBusy(false);
    }
  };

  return (
    <Card as="section" padding="md" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-200">
          {S.memory.preferencesSection}
        </h3>
        <div className="flex flex-wrap gap-1.5">
          <Button size="sm" variant="ghost" onClick={() => void exportAll()}>
            {S.memory.preferencesExport}
          </Button>
          <label className="shrink-0">
            <HiddenFileInput
              accept=".json,application/json"
              onChange={(e) => void pickImport(e)}
            />
            <span className="inline-flex cursor-pointer items-center rounded-md px-2 py-1 text-xs text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800">
              {S.memory.preferencesImport}
            </span>
          </label>
          <Button size="sm" variant="ghost" onClick={openAdd}>
            {S.memory.preferencesAdd}
          </Button>
        </div>
      </div>
      <p className="text-xs text-gray-500 dark:text-gray-400">{S.memory.preferencesHint}</p>

      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

      {data === null ? (
        <p className="text-xs text-gray-400">{S.common.loading}</p>
      ) : data.entries.length === 0 ? (
        <p className="text-xs text-gray-400 dark:text-gray-500">{S.memory.preferencesEmpty}</p>
      ) : (
        <ul className="divide-y divide-gray-100 dark:divide-gray-800">
          {data.entries.map((entry) => (
            <li key={entry.id} className="space-y-1 py-2">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="text-sm font-medium text-gray-800 dark:text-gray-200">
                  {entry.title}
                </span>
                <span className="text-xs text-gray-400 dark:text-gray-500">
                  {formatRelativeDate(entry.updatedAt, locale)}
                </span>
              </div>
              <p className="whitespace-pre-wrap text-xs text-gray-600 dark:text-gray-300">
                {entry.content}
              </p>
              <div className="flex flex-wrap items-center gap-2 text-xs text-gray-400 dark:text-gray-500">
                <span>
                  {entry.source === "explicit_user_import"
                    ? S.memory.preferencesSourceImport
                    : S.memory.preferencesSourceExplicit}
                </span>
                {entry.sourceTask && <span>{S.memory.preferencesSourceTask(entry.sourceTask)}</span>}
                {entry.disabled && <span>{S.memory.preferencesDisabled}</span>}
                {entry.conflict === "unresolved" && (
                  <span className="text-amber-600 dark:text-amber-400">
                    {S.memory.preferencesConflict}
                  </span>
                )}
                <span className="ml-auto flex gap-1.5">
                  <Button size="sm" variant="ghost" onClick={() => openEdit(entry)}>
                    {S.memory.edit}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => void toggle(entry)}>
                    {entry.disabled ? S.memory.preferencesEnable : S.memory.preferencesDisable}
                  </Button>
                  <Button size="sm" variant="danger" onClick={() => setRemoving(entry)}>
                    {S.memory.delete}
                  </Button>
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
      <p className="text-[11px] text-gray-400 dark:text-gray-500">
        {S.memory.preferencesSnapshotHint}
      </p>

      <Modal
        open={editing !== null}
        title={
          editing?.id ? S.memory.preferencesEditTitle : S.memory.preferencesAddTitle
        }
        onClose={() => setEditing(null)}
        widthClass="sm:max-w-lg"
      >
        {editing && (
          <div className="space-y-3">
            <Input
              label={S.memory.preferencesTitleLabel}
              required
              value={title}
              placeholder={S.memory.preferencesTitlePlaceholder}
              onChange={(e) => setTitle(e.target.value)}
            />
            <Textarea
              label={S.memory.preferencesContentLabel}
              required
              size="sm"
              rows={5}
              value={content}
              placeholder={S.memory.preferencesContentPlaceholder}
              onChange={(e) => setContent(e.target.value)}
            />
            <div className="flex justify-end gap-2">
              <Button size="sm" onClick={() => setEditing(null)}>
                {S.common.cancel}
              </Button>
              <Button
                size="sm"
                variant="primary"
                disabled={title.trim() === "" || content.trim() === "" || busy}
                onClick={() => void save()}
              >
                {S.memory.preferencesSave}
              </Button>
            </div>
          </div>
        )}
      </Modal>

      <ConfirmModal
        open={removing !== null}
        tone="danger"
        title={S.memory.preferencesDeleteTitle}
        confirmLabel={S.memory.delete}
        cancelLabel={S.common.cancel}
        onClose={() => setRemoving(null)}
        onConfirm={() => void confirmRemove()}
      >
        <p className="text-sm text-gray-700 dark:text-gray-300">
          {removing ? S.memory.preferencesDeleteConfirm(removing.title) : ""}
        </p>
      </ConfirmModal>

      <Modal
        open={importing !== null}
        title={S.memory.preferencesImportTitle}
        onClose={() => setImporting(null)}
        widthClass="sm:max-w-lg"
      >
        {importing && (
          <div className="space-y-3">
            <p className="text-xs text-gray-500 dark:text-gray-400">
              {S.memory.preferencesImportWhy}
            </p>
            <p className="break-all font-mono text-xs text-gray-500 dark:text-gray-400">
              {S.memory.preferencesImportFile(
                importing.fileName,
                new TextEncoder().encode(importing.text).byteLength,
                importing.hash,
              )}
            </p>
            <Notice tone="neutral" variant="inline">
              {`${data?.ownerUserId ?? ""} · ${S.memory.preferencesSection}`}
            </Notice>
            <div className="flex flex-wrap gap-2 text-xs">
              {(["skip", "overwrite", "replace"] as const).map((mode) => (
                <Button
                  key={mode}
                  size="sm"
                  variant={importMode === mode ? "primary" : "ghost"}
                  onClick={() => void changeImportMode(mode)}
                >
                  {mode === "skip"
                    ? S.memory.preferencesImportModeSkip
                    : mode === "overwrite"
                      ? S.memory.preferencesImportModeOverwrite
                      : S.memory.preferencesImportModeReplace}
                </Button>
              ))}
            </div>
            <p className="text-xs text-gray-600 dark:text-gray-300">
              {S.memory.preferencesImportPlan(
                importing.plan.added.length,
                importing.plan.overwritten.length,
                importing.plan.removed.length,
              )}
            </p>
            {importing.plan.conflicts.length > 0 && (
              <p className="text-xs text-amber-600 dark:text-amber-400">
                {S.memory.preferencesConflict}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button size="sm" onClick={() => setImporting(null)}>
                {S.common.cancel}
              </Button>
              <Button
                size="sm"
                variant="primary"
                disabled={importBusy}
                onClick={() => void submitImport()}
              >
                {S.memory.preferencesImportConfirm}
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </Card>
  );
}
