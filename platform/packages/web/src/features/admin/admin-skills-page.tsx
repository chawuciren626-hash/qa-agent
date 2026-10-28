import { useState } from "react";
import { PageFrame, PageHeader } from "@prismshadow/penguin-ui";
import { useProject } from "../../state/project";
import { SkillsTab } from "../agents/skills-tab";

/** Existing skill editor, with only a target selector added for the management entrance. */
export function AdminSkillsPage() {
  const { agents, currentProject } = useProject();
  const [selected, setSelected] = useState("");
  const agentId = agents.some(agent => agent.agentId === selected) ? selected : agents[0]?.agentId;
  return <PageFrame><PageHeader title="技能管理" description="沿用智能体现有的技能查看、导入和导出功能。" />
    <select className="mb-4 rounded border bg-transparent p-2" aria-label="技能所属智能体" value={agentId || ""} onChange={event => setSelected(event.target.value)}>
      {agents.map(agent => <option key={agent.agentId} value={agent.agentId}>{agent.name || agent.agentId}</option>)}
    </select>
    {agentId && <SkillsTab key={`${currentProject?.projectId}:${agentId}`} agentId={agentId} />}
  </PageFrame>;
}
