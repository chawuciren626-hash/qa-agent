import { PageFrame, PageHeader } from "@prismshadow/penguin-ui";
import { useEffect } from "react";
import { Link } from "react-router";
import { ChatPage } from "../chat/chat-page";
import { useProject } from "../../state/project";

const ADMIN_ASSISTANT_AGENT = "default_agent";

/** The administrator's local authoring project uses the existing conversation page. */
export function AdminAssistantPage() {
  const { currentProject, agents, agentsLoading, currentAgent, setCurrentAgentId } = useProject();
  const ready = currentProject?.projectId === "admin_agent_catalog" && !agentsLoading;
  const available = ready && agents.some(agent => agent.agentId === ADMIN_ASSISTANT_AGENT);
  useEffect(() => {
    if (available && currentAgent?.agentId !== ADMIN_ASSISTANT_AGENT) setCurrentAgentId(ADMIN_ASSISTANT_AGENT);
  }, [available, currentAgent?.agentId, setCurrentAgentId]);
  if (!ready) return <PageFrame><PageHeader title="管理员助手" /><p role="status">正在加载管理员配置项目…</p></PageFrame>;
  if (!available) return <PageFrame><PageHeader title="管理员助手" /><p role="alert">管理员配置项目中没有 General Agent（default_agent），请先检查智能体配置。</p><Link to="/agents">打开 Agent 管理</Link></PageFrame>;
  if (currentAgent?.agentId !== ADMIN_ASSISTANT_AGENT) return <PageFrame><PageHeader title="管理员助手" /><p role="status">正在选择 General Agent…</p></PageFrame>;
  return <ChatPage fixedAgentId={ADMIN_ASSISTANT_AGENT} />;
}
