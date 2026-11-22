// A7：执行授权逐通道列明。执行阶段的「确认」等于授权对目标环境的真实操作，
// 这里按通道（端×类型×环境）列明本次授权会触碰的目标与数据影响。
// 只读展示、不做推断：目标环境取项目默认环境（环境列表来自项目环境登记），
// 多环境时明确提示以运行计划为准，绝不把"可能有别的环境"写成唯一结论。
import { useEffect, useState } from "react";
import { listEnvironments } from "./project-management/api";
import type { EnvironmentView } from "./project-management/types";

const automationKind = (stageId: string) => stageId === "api_execution" ? "接口自动化" : "UI 自动化";
const automationEnd = (stageId: string, executionPlatform: string) => stageId === "api_execution"
  ? "接口"
  : executionPlatform === "android" ? "App"
    : executionPlatform === "miniprogram" ? "小程序"
      : executionPlatform === "desktop" ? "桌面客户端" : "Web";
const automationImpact = (stageId: string) => stageId === "api_execution"
  ? "对目标环境发起真实接口调用，可能读取或写入业务数据"
  : "对目标环境发起真实页面/客户端操作（导航、点击、表单提交），可能产生业务数据变更";

export type ExecutionChannel = { kind: string; end: string; env: string; baseUrl: string; impact: string };

export function executionChannels(stageId: string, executionPlatform: string, environments: EnvironmentView[]): ExecutionChannel[] {
  const target = environments.find(env => env.isDefault) ?? environments[0];
  if (!target) return [];
  return [{ kind: automationKind(stageId), end: automationEnd(stageId, executionPlatform), env: target.env, baseUrl: target.baseUrl, impact: automationImpact(stageId) }];
}

export function ExecutionChannelAuthorization({ projectId, stageId, executionPlatform }: { projectId: string; stageId: string; executionPlatform: string }) {
  const [environments, setEnvironments] = useState<EnvironmentView[] | null>(null);
  useEffect(() => {
    let alive = true;
    setEnvironments(null);
    void listEnvironments(projectId)
      .then(result => { if (alive) setEnvironments(result.environments); })
      .catch(() => { if (alive) setEnvironments([]); });
    return () => { alive = false; };
  }, [projectId]);
  if (environments === null) return null;
  const channels = executionChannels(stageId, executionPlatform, environments);
  return <div className="qtd-exec-channels" aria-label="执行授权通道">
    <strong>本次确认将授权的执行通道</strong>
    {channels.length ? channels.map((channel, index) => <div className="qtd-exec-channel" key={index}>
      <span className="qtd-exec-channel-name">{channel.kind} · {channel.end}端</span>
      <span>目标环境：{channel.env}（{channel.baseUrl}）</span>
      <span className="qtd-exec-channel-impact">数据影响：{channel.impact}</span>
    </div>) : <p className="qtd-exec-channel-warning">项目尚未连接执行环境；执行前请先到「项目环境」页登记目标地址，确认前请核对运行会话中的环境说明。</p>}
    {environments.length > 1 && <p className="qtd-exec-channel-note">项目登记了 {environments.length} 个环境；确认前请核对运行会话说明，实际目标环境以运行计划为准。</p>}
  </div>;
}
