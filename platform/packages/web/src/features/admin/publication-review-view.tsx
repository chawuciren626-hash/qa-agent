/** Presentational pieces for publication review: no fetching, no role checks — the page owns both. */
import { Button } from "@prismshadow/penguin-ui";
import type { ManagedKind } from "../../lib/managed-resources";
import {
  canRestore,
  validationReport,
  versionChanges,
  versionSummaryLines,
  versionTitle,
  type ResourceVersion,
  type ValidationResult,
} from "./publication-review";

/** A validation result as an administrator reads it before publishing. */
export function ValidationResultBody({ result }: { result: ValidationResult }) {
  const report = validationReport(result);
  return (
    <div role={report.ok ? "status" : "alert"}>
      <p>
        <strong>{report.title}</strong>
      </p>
      <ul className="mt-3 list-disc space-y-1 pl-5 text-sm">
        {report.details.map((line, index) => (
          <li key={`${index}-${line}`}>{line}</li>
        ))}
      </ul>
      {report.warnings.length > 0 && (
        <div className="mt-4 rounded border border-[var(--border)] p-3 text-sm">
          <strong>发布前注意</strong>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            {report.warnings.map((line, index) => (
              <li key={`${index}-${line}`}>{line}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/**
 * Published versions, newest first. A restore is offered only for an older version of a
 * published resource: the server records it as a new version and never rewrites history.
 */
export function VersionHistoryList({
  history,
  kind,
  published,
  busy,
  onRestore,
}: {
  history: ResourceVersion[];
  kind: ManagedKind;
  published: boolean;
  busy: boolean;
  onRestore: (item: ResourceVersion) => void;
}) {
  if (history.length === 0) return <p className="text-sm opacity-70">尚无已发布版本。</p>;
  const current = history.find((item) => item.current);
  return (
    <ul className="space-y-3">
      {history.map((item) => (
        <li key={item.version} className="rounded border border-[var(--border)] p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <strong className="text-sm">{versionTitle(item)}</strong>
            {canRestore(item, published) && (
              <Button size="sm" disabled={busy} onClick={() => onRestore(item)}>
                恢复为 v{item.version}
              </Button>
            )}
          </div>
          <p className="mt-2 text-xs opacity-60">{item.created_at}</p>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-xs">
            {versionSummaryLines(item, kind).map((line, index) => (
              <li key={`${index}-${line}`}>{line}</li>
            ))}
          </ul>
          {!item.current && (
            <p className="mt-2 text-xs opacity-70">
              恢复后的差异：{versionChanges(item, current, kind).join("；")}
            </p>
          )}
        </li>
      ))}
    </ul>
  );
}
