/**
 * 批次 2U：Agent 设置「工具」标签的平台工具只读区块。
 *
 * 只回答「这个 Agent 被授权了哪些平台工具」：数据来自工具管理的同一份台账
 * （central_tools / central_tool_agents），按 agentId 过滤，未绑定的工具不出现。
 * 绑定、解绑与启停只在工具管理页维护（那里有审计），这里不提供任何写入口。
 */
import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { Button, Table, TableBody, TableCell, TableHead, TableHeaderCell, TableRow } from "@prismshadow/penguin-ui";
import { controlRequest } from "../../api/control";
import { apiErrorText } from "../../lib/api-error";

type PlatformTool = {
  id: string; name: string; displayName: string; categoryId: string;
  permissions: "read" | "write"; enabled: boolean; agents: string[];
};
type Category = { id: string; name: string };

export function CentralAgentPlatformTools({ agentId }: { agentId: string }) {
  const navigate = useNavigate();
  const [tools, setTools] = useState<PlatformTool[] | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!agentId) return;
    let cancelled = false;
    setTools(null); setError("");
    void controlRequest("/api/control/tools/admin").then(result => {
      if (cancelled) return;
      setCategories(result.categories as Category[]);
      setTools((result.tools as PlatformTool[]).filter(tool => tool.agents.includes(agentId)));
    }).catch(cause => { if (!cancelled) setError(apiErrorText(cause)); });
    return () => { cancelled = true; };
  }, [agentId]);
  if (!agentId) return null;
  const categoryName = (id: string) => categories.find(item => item.id === id)?.name ?? id;
  return (
    <section className="space-y-2" aria-label="平台工具">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-medium">平台工具（只读）</h2>
          <p className="text-xs text-fg-subtle">此 Agent 已获授权的平台工具。绑定与启停请在工具管理页维护，此处不可修改。</p>
        </div>
        <Button size="sm" onClick={() => navigate("/tools")}>在工具管理中查看</Button>
      </div>
      {error !== "" && <p role="alert" className="text-sm text-red-600">{error}</p>}
      {error === "" && tools === null && <p role="status" className="text-xs text-fg-subtle">正在读取平台工具…</p>}
      {error === "" && tools !== null && tools.length === 0 && <p className="text-xs text-fg-subtle">该 Agent 尚未绑定任何平台工具。</p>}
      {error === "" && tools !== null && tools.length > 0 && (
        <Table tableClassName="min-w-[480px]">
          <TableHead>
            <TableHeaderCell>工具</TableHeaderCell>
            <TableHeaderCell>所属阶段</TableHeaderCell>
            <TableHeaderCell>权限</TableHeaderCell>
            <TableHeaderCell>状态</TableHeaderCell>
          </TableHead>
          <TableBody>
            {tools.map(tool => (
              <TableRow key={tool.id}>
                <TableCell className="align-top">
                  <span className="block text-xs">{tool.displayName}</span>
                  <span className="block font-mono text-xs text-fg-subtle">{tool.name}</span>
                </TableCell>
                <TableCell className="align-top text-xs">{categoryName(tool.categoryId)}</TableCell>
                <TableCell className="align-top font-mono text-xs">{tool.permissions}</TableCell>
                <TableCell className="align-top text-xs">
                  <span className={tool.enabled ? "" : "text-fg-subtle"}>{tool.enabled ? "已启用" : "已停用"}</span>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </section>
  );
}