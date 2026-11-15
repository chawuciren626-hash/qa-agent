import { useState } from "react";
import type { SkillMetadataItem } from "@prismshadow/penguin-server/api";
import { Button, Modal, toastError } from "@prismshadow/penguin-ui";
import { agentSkillArchiveUrl } from "../../api/endpoints";
import { apiErrorText } from "../../lib/api-error";
import { downloadArchive } from "../agents/archive-download";
import { InstalledSkillFiles } from "./installed-skill-files";
import "./skill-preview-modal.css";

export type SkillPreviewSource = { agentId: string; label: string };

/** Shared installed-skill detail used by the skill market and administrator catalog. */
export function SkillPreviewModal({ projectId, skill, sources, title, onClose }: {
  projectId: string | null;
  skill: SkillMetadataItem | null;
  sources: SkillPreviewSource[];
  title?: string;
  onClose: () => void;
}) {
  const [sourceId, setSourceId] = useState("");
  const [exporting, setExporting] = useState(false);
  const selectedSource = sources.some(source => source.agentId === sourceId) ? sourceId : sources[0]?.agentId ?? "";
  return <Modal open={skill !== null} title={skill ? title || skill.name : "技能详情"} onClose={onClose} widthClass="sm:max-w-4xl">
    {skill && <div className="skill-preview-info"><p className="skill-preview-id">{skill.name}</p><p>{skill.description || "暂无描述"}</p><p>{skill.version ? `版本：${skill.version}` : "未声明版本"}</p><h3>已安装到</h3>{sources.map(source => <div className="skill-preview-export" key={source.agentId}><span>{source.label}</span><Button size="sm" disabled={exporting || !projectId} onClick={async () => { if (!projectId) return; setExporting(true); try { await downloadArchive(agentSkillArchiveUrl(projectId, source.agentId, skill.name, null), skill.name); } catch (cause) { toastError(apiErrorText(cause)); } finally { setExporting(false); } }}>导出技能</Button></div>)}</div>}
    {skill && projectId && selectedSource && <div className="mt-5 space-y-3"><label className="flex flex-wrap items-center gap-2 text-sm">阅览来源 <select aria-label="阅览来源" value={selectedSource} onChange={event => setSourceId(event.target.value)} className="min-w-0 rounded border border-line bg-surface px-2 py-1">{sources.map(source => <option key={source.agentId} value={source.agentId}>{source.label}</option>)}</select></label><InstalledSkillFiles projectId={projectId} agentId={selectedSource} name={skill.name} machineId={null} /></div>}
  </Modal>;
}
