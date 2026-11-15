import { useEffect, useState } from "react";
import { FileBrowser } from "@prismshadow/penguin-ui";
import type { TreeToggle } from "@prismshadow/penguin-ui";
import { getAgentSkillFiles } from "../../api/endpoints";
import { apiErrorText } from "../../lib/api-error";
import { S } from "../../lib/strings";
import { useReaderFind } from "../../lib/reader-find";
import { groupPluginFiles, pluginTreeRows } from "../plugins/plugin-detail";

/** Remount per installed copy so an older request or selection cannot cross source boundaries. */
export function InstalledSkillFiles(props: { projectId: string; agentId: string; name: string; machineId: string | null }) {
  return <SkillFiles key={JSON.stringify(props)} {...props} />;
}

function SkillFiles({ projectId, agentId, name, machineId }: { projectId: string; agentId: string; name: string; machineId: string | null }) {
  const [files, setFiles] = useState<Record<string, string> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [toggled, setToggled] = useState<TreeToggle | null>(null);
  const [revision, setRevision] = useState(0);
  const readerFind = useReaderFind();
  useEffect(() => {
    let alive = true;
    setError(null);
    void getAgentSkillFiles(projectId, agentId, name, machineId).then(
      result => { if (alive) setFiles(result.files); },
      reason => { if (alive) setError(apiErrorText(reason)); },
    );
    return () => { alive = false; };
  }, [projectId, agentId, name, machineId, revision]);
  const prefix = `skills/${name}/`;
  const groups = groupPluginFiles(Object.keys(files ?? {}).map(p => prefix + p), [name], S.plugins.detailHooks);
  const current = selected ?? groups[0]?.paths[0] ?? null;
  const relative = current?.slice(prefix.length);
  const content = relative === undefined ? undefined : files?.[relative];
  return <>
    {error && <button type="button" onClick={() => setRevision(n => n + 1)}>{S.common.retry}</button>}
    <FileBrowser
      rows={pluginTreeRows(groups, collapsed)}
      treeLabel={S.files.treeLabel}
      selectedPath={current}
      toggled={toggled}
      treeLoading={files === null && error === null}
      treeError={error}
      headerFallback={name}
      preview={current !== null && content !== undefined ? {path:current, name:current.split('/').at(-1)!, kind:/\.md$/i.test(current)?'md':'text',content} : null}
      emptyPreview={error ?? S.common.none}
      emptyDirLabel={S.files.empty}
      truncatedLabel={S.files.previewTruncated}
      unsupportedLabel={S.files.previewUnsupported}
      downloadLabel={S.files.download}
      stripFrontmatter
      {...readerFind}
      resolveRef={ref => {
        if (!current || ref.startsWith('/') || ref.startsWith('#')) return null;
        let decoded: string;
        try { decoded = decodeURIComponent(ref.split(/[?#]/)[0]!); } catch { return null; }
        const parts = current.split('/').slice(0,-1);
        for (const part of decoded.split('/')) {
          if (part === '..') parts.pop(); else if (part && part !== '.') parts.push(part);
        }
        const target = parts.join('/');
        return target.startsWith(prefix) && Object.hasOwn(files ?? {},target.slice(prefix.length)) ? {url:'#',treePath:target} : null;
      }}
      onToggleDir={dir => {
        const open = collapsed.has(dir);
        setToggled(last => ({dir,open,serial:(last?.serial ?? 0)+1}));
        setCollapsed(previous => {const next = new Set(previous); if(open) next.delete(dir); else next.add(dir); return next;});
      }}
      onOpenFile={setSelected}
    />
  </>;
}
