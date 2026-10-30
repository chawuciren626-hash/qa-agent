import type { ReactNode } from "react";
import { Heading, PenguinLogo, Text } from "@prismshadow/penguin-ui";
import { PENGUIN_LOGO_URL } from "../../lib/brand-logo";

const ADMIN_TASKS = [
  {
    title: "创建 Agent",
    detail: "梳理职责、工具和配置，生成可审阅的创建方案",
    prompt: "请帮我创建一个后台 Agent。先了解它的职责、使用场景、工具与权限要求，再给出可审阅的配置方案。",
  },
  {
    title: "配置模型",
    detail: "检查模型用途与参数，协助完成模型配置",
    prompt: "请帮我配置一个模型。先确认提供商、模型名称、用途和所需参数，再检查现有配置并给出操作建议。",
  },
  {
    title: "创建或审阅 Skill",
    detail: "检查技能内容、适用 Agent 和使用边界",
    prompt: "请帮我创建或审阅一个 Skill。先了解目标能力与所属 Agent，再检查技能说明、执行步骤和使用边界。",
  },
  {
    title: "排查流程问题",
    detail: "定位后台流程的异常步骤和可能原因",
    prompt: "请帮我排查当前后台流程问题。先询问复现步骤、预期结果和实际表现，再根据现有配置和日志定位原因。",
  },
  {
    title: "管理用户账号",
    detail: "协助核对账号状态和管理操作",
    prompt: "请帮我处理用户账号管理事项。先确认目标账号和需要执行的操作，再核对当前状态并说明影响。",
  },
  {
    title: "管理功能权限",
    detail: "核对账号授权并审阅权限调整",
    prompt: "请帮我核对或调整用户的功能权限。先确认目标账号、所需功能和授权范围，再给出可审阅的变更方案。",
  },
] as const;

export function AdminAssistantDashboard({
  composer,
  fill,
}: {
  composer: ReactNode;
  fill: (prompt: string, skills: readonly string[]) => void;
}) {
  return (
    <>
      <div className="mb-10 flex items-center gap-4">
        <PenguinLogo
          src={PENGUIN_LOGO_URL}
          className="h-20 w-20 shrink-0 rounded-[24%] ring-1 ring-line-muted"
        />
        <div>
          <Heading level={1} display>管理员助手</Heading>
          <Text className="mt-1 text-fg-muted">协助配置 Agent、模型和 Skill，排查流程并管理账号权限</Text>
        </div>
      </div>
      {composer}
      <section aria-label="管理员助手常用任务" className="mt-10 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {ADMIN_TASKS.map((task) => (
          <button
            key={task.title}
            type="button"
            className="rounded-lg border border-line-muted p-4 text-left hover:bg-bg-subtle focus-visible:outline-2 focus-visible:outline-offset-2"
            onClick={() => fill(task.prompt, [])}
          >
            <strong>{task.title}</strong>
            <p className="mt-2 text-sm text-fg-muted">{task.detail}</p>
          </button>
        ))}
      </section>
    </>
  );
}
