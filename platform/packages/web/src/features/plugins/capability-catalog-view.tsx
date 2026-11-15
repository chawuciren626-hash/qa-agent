/**
 * The normal user's read-only capability catalog, mounted inside the existing page.
 *
 * It renders no install, uninstall, publish or rollback control: those belong to the admin pages
 * and the existing feature pages that already own those writes. A running task keeps the
 * references it started with, which is said once at the top rather than inferred per row.
 */
import { useManagedResources } from "../../lib/use-managed-resources";
import {
  CATALOG_KINDS,
  appliedLabel,
  buildCapabilityCatalog,
  stateLabel,
  type CapabilityEntry,
} from "./capability-catalog";

export function CapabilityCatalog() {
  const { resources, applied, enabled, error } = useManagedResources();
  // The catalog reads the same two answers as the managed-resource section; a user without an
  // owned project gets nothing, rather than an empty list that reads as "nothing published".
  if (!enabled) return null;
  if (resources.length === 0 && !error) return null;
  const catalog = buildCapabilityCatalog(resources, applied);
  return (
    <details className="mb-4 rounded-lg border border-[var(--border)] p-4" aria-label="能力目录">
      <summary className="cursor-pointer text-sm font-medium">
        能力目录 · {catalog.counts.total} 项
        {catalog.counts.upgradable > 0 ? ` · ${catalog.counts.upgradable} 项有更新` : ""}
      </summary>
      <p className="my-3 text-sm opacity-70">
        管理员发布的公共能力，只读展示。安装、卸载、发布由管理员或原有功能页完成；运行中的任务继续使用启动时锁定的版本。
      </p>
      {error && (
        <p role="alert" className="mb-3 text-red-600">
          无法读取能力目录：{error}
        </p>
      )}
      <div className="space-y-4">
        {CATALOG_KINDS.map(({ kind, title }) => {
          const rows = catalog.byKind[kind];
          if (rows.length === 0) return null;
          return (
            <section key={kind} aria-label={title}>
              <h3 className="text-sm font-medium">
                {title} · {rows.length}
              </h3>
              <ul className="mt-2 space-y-2">
                {rows.map(entry => (
                  <CatalogRow key={`${entry.kind}:${entry.id}`} entry={entry} />
                ))}
              </ul>
            </section>
          );
        })}
      </div>
      {!error && catalog.counts.total === 0 && <p className="text-sm opacity-70">尚未发布公共能力。</p>}
    </details>
  );
}

function CatalogRow({ entry }: { entry: CapabilityEntry }) {
  const tone =
    entry.state === "upgradable"
      ? "text-amber-700 dark:text-amber-400"
      : entry.state === "current"
        ? "text-emerald-700 dark:text-emerald-400"
        : "opacity-60";
  return (
    <li className="rounded border border-[var(--border)] p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <strong>{entry.name}</strong>
        <span className="text-xs opacity-70">v{entry.version}</span>
        <span className={`text-xs ${tone}`}>{stateLabel(entry.state)}</span>
      </div>
      <p className="mt-1 text-xs opacity-70">{entry.description || "暂无说明"}</p>
      {entry.assignedAgents.length > 0 && (
        <p className="mt-1 text-xs">
          配给智能体：{entry.assignedAgents.map(agent => agent.name).join("、")}
        </p>
      )}
      <p className="mt-1 text-xs">本机版本：{appliedLabel(entry)}</p>
      <ul className="mt-1 list-disc space-y-1 pl-5 text-xs opacity-70">
        {entry.hints.map(hint => (
          <li key={hint}>{hint}</li>
        ))}
      </ul>
    </li>
  );
}
