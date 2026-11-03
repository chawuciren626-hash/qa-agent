/**
 * "Round-only personal Skills": the panel beside a project's imported resources.
 *
 * The person picks one of their loaded tasks, chooses imported resources, and the service records
 * a round selection that pins their versions. The panel never installs anything: it says the
 * choice lasts one round, that the Agent's default Skills stay as they were, and that the resources
 * themselves remain in the personal area afterwards.
 *
 * The task send path picks up the active selection by user, project, Session and Agent.
 * A successful send consumes it; no selectionId is needed in the task request.
 */
import { useEffect, useMemo, useState } from "react";
import type { AgentSummary, SessionInfo } from "@prismshadow/penguin-server/api";
import { Button, Modal } from "@prismshadow/penguin-ui";
import { apiFetch, ApiError } from "../../api/client";
import { apiErrorText } from "../../lib/api-error";
import { randomHex } from "../../lib/random-id";
import { agentDisplayName, useProject } from "../../state/project";
import { useSessions } from "../../state/sessions";
import {
  canCancel,
  selectionErrorHint,
  selectionHeadline,
  selectionLines,
  selectionStatusLabel,
  type PersonalResourceSummary,
  type RoundSelectionView,
} from "./personal-skill-selection";

/** Agent and Session ids never contain this; a select's value is the pair. */
const TASK_SEPARATOR = "|";
/** How many recent tasks one Agent contributes to the picker. */
const TASKS_PER_AGENT = 5;
const TASKS_TOTAL = 30;
/** The server refuses more than this; the panel refuses earlier, before anything is sent. */
const PICKS_MAX = 20;

interface TaskOption {
  key: string;
  agentId: string;
  sessionId: string;
  label: string;
}

function taskOptions(
  agents: AgentSummary[],
  byAgent: ReadonlyMap<string, SessionInfo[]>,
): TaskOption[] {
  const options: TaskOption[] = [];
  for (const agent of agents) {
    for (const session of (byAgent.get(agent.agentId) ?? []).slice(0, TASKS_PER_AGENT)) {
      options.push({
        key: `${agent.agentId}${TASK_SEPARATOR}${session.sessionId}`,
        agentId: agent.agentId,
        sessionId: session.sessionId,
        label: `${agentDisplayName(agent)} · ${session.title?.trim() || session.sessionId.slice(0, 8)}`,
      });
      if (options.length >= TASKS_TOTAL) return options;
    }
  }
  return options;
}

function targetOf(key: string): { agentId: string; sessionId: string } | null {
  const at = key.indexOf(TASK_SEPARATOR);
  if (at <= 0 || at === key.length - 1) return null;
  return { agentId: key.slice(0, at), sessionId: key.slice(at + 1) };
}

function errorText(error: unknown): string {
  const code = error instanceof ApiError ? error.code : undefined;
  return selectionErrorHint(code) ?? apiErrorText(error);
}

export function PersonalSkillSelection({ resources }: { resources: PersonalResourceSummary[] }) {
  const { currentProject, agents } = useProject();
  const { byAgent } = useSessions();
  const projectId = currentProject?.projectId;
  const base = `/api/projects/${encodeURIComponent(projectId ?? "")}/agents/qa/personal-resources`;
  const tasks = useMemo(() => taskOptions(agents, byAgent), [agents, byAgent]);

  const [task, setTask] = useState("");
  const [current, setCurrent] = useState<RoundSelectionView | null>(null);
  const [checking, setChecking] = useState(false);
  const [status, setStatus] = useState<{ tone: "error" | "notice"; text: string } | null>(null);
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  // Another Project's tasks and selections are not this Project's: drop both on a switch.
  useEffect(() => {
    setTask("");
    setCurrent(null);
    setStatus(null);
  }, [projectId]);

  useEffect(() => {
    const target = targetOf(task);
    if (!projectId || target === null) {
      setCurrent(null);
      setChecking(false);
      return;
    }
    let alive = true;
    setChecking(true);
    setCurrent(null);
    setStatus(null);
    apiFetch<{ selection: RoundSelectionView | null }>(`${base}/selection`, {
      query: { sessionId: target.sessionId, agentId: target.agentId },
    })
      .then((answer) => {
        if (alive) setCurrent(answer.selection);
      })
      .catch((error: unknown) => {
        if (alive) setStatus({ tone: "error", text: errorText(error) });
      })
      .finally(() => {
        if (alive) setChecking(false);
      });
    return () => {
      alive = false;
    };
  }, [base, projectId, task]);

  async function create() {
    const target = targetOf(task);
    if (!target || busy || picked.length === 0) return;
    setBusy(true);
    setStatus(null);
    try {
      const answer = await apiFetch<{ idempotent: boolean; selection: RoundSelectionView }>(
        `${base}/selection`,
        {
          method: "POST",
          body: {
            sessionId: target.sessionId,
            agentId: target.agentId,
            resources: picked.map((resourceId) => ({ resourceId })),
            roundKey: `ui-${randomHex(16)}`,
          },
        },
      );
      setCurrent(answer.selection);
      setOpen(false);
      setPicked([]);
      setStatus({
        tone: "notice",
        text: `已记录第 ${answer.selection.round} 轮选择，仅本轮生效。`,
      });
    } catch (error) {
      setStatus({ tone: "error", text: errorText(error) });
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    if (!current || busy) return;
    if (!window.confirm("取消本轮选择？本轮快照会被删除，默认 Skill 不受影响。")) return;
    setBusy(true);
    setStatus(null);
    try {
      await apiFetch(`${base}/selection/${encodeURIComponent(current.selectionId)}`, {
        method: "DELETE",
      });
      setCurrent(null);
      setStatus({ tone: "notice", text: "已取消本轮选择，默认 Skill 保持不变。" });
    } catch (error) {
      setStatus({ tone: "error", text: errorText(error) });
    } finally {
      setBusy(false);
    }
  }

  const targetLabel = tasks.find((option) => option.key === task)?.label;
  if (!projectId) return null;
  return (
    <section className="mt-6 border-t border-[var(--border)] pt-4" aria-label="本轮个人技能">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-medium">本轮个人技能</h3>
          <p className="mt-1 text-xs opacity-70">
            仅对所选任务的本轮生效；不写入智能体的默认 Skill 目录，未选择时默认 Skill 保持不变。
          </p>
        </div>
        {task !== "" && !checking && current === null && (
          <Button
            size="sm"
            variant="primary"
            disabled={busy || resources.length === 0}
            onClick={() => {
              setPicked([]);
              setStatus(null);
              setOpen(true);
            }}
          >
            选择本轮技能
          </Button>
        )}
        {task !== "" && !checking && current !== null && (
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={busy || resources.length === 0}
              onClick={() => {
                setPicked(current.resources.map((resource) => resource.resourceId));
                setStatus(null);
                setOpen(true);
              }}
            >
              更换本轮选择
            </Button>
            {canCancel(current) && (
              <Button size="sm" disabled={busy} onClick={() => void cancel()}>
                取消本轮选择
              </Button>
            )}
          </div>
        )}
      </div>
      <label className="mt-3 block text-xs">
        任务
        <select
          className="ml-2 max-w-full rounded border bg-transparent p-2 text-sm"
          aria-label="选择本轮任务"
          value={task}
          disabled={busy}
          onChange={(event) => {
            setTask(event.target.value);
            setStatus(null);
          }}
        >
          <option value="">请选择任务</option>
          {tasks.map((option) => (
            <option key={option.key} value={option.key}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      {tasks.length === 0 && (
        <p className="mt-2 text-xs opacity-70">
          当前项目还没有已加载的任务。请先在对话中发起任务，或刷新任务列表后再选择。
        </p>
      )}
      {status && !open && (
        <p
          role={status.tone === "error" ? "alert" : "status"}
          className={`mt-2 text-sm ${status.tone === "error" ? "text-red-600" : "opacity-70"}`}
        >
          {status.text}
        </p>
      )}
      {checking && <p className="mt-2 text-xs opacity-70">正在读取本轮选择…</p>}
      {current !== null && (
        <div className="mt-3 rounded border border-[var(--border)] p-3 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <strong>{selectionHeadline(current)}</strong>
            <span className="text-xs opacity-70">{selectionStatusLabel(current.status)}</span>
          </div>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-xs">
            {selectionLines(current, Date.now()).map((line, index) => (
              <li key={`${index}-${line}`}>{line}</li>
            ))}
          </ul>
          <p className="mt-2 text-xs opacity-70">
            本轮选择已记录。向所选任务发送消息后自动生效并清空；下一轮仍使用默认 Skill，除非重新选择。
          </p>
        </div>
      )}
      <Modal
        open={open}
        title="选择本轮个人技能"
        onClose={() => {
          if (!busy) setOpen(false);
        }}
        footer={
          <>
            <Button size="sm" disabled={busy} onClick={() => setOpen(false)}>
              取消
            </Button>
            <Button
              size="sm"
              variant="primary"
              disabled={busy || picked.length === 0}
              onClick={() => void create()}
            >
              {busy ? "正在创建…" : "创建本轮选择"}
            </Button>
          </>
        }
      >
        <p className="mb-4 text-sm opacity-70">
          只对这一轮生效，发送后清空；资源本身不会安装到智能体，下一次不选就回到默认 Skill。
        </p>
        {targetLabel && <p className="mb-2 text-sm">任务：{targetLabel}</p>}
        {resources.length === 0 ? (
          <p className="text-sm opacity-70">还没有可选择的个人资源，请先上传技能。</p>
        ) : (
          <ul className="space-y-2">
            {resources.map((resource) => {
              const checked = picked.includes(resource.id);
              const full = picked.length >= PICKS_MAX && !checked;
              return (
                <li key={resource.id}>
                  <label className="flex gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={busy || full}
                      onChange={(event) =>
                        setPicked((value) =>
                          event.target.checked
                            ? [...value, resource.id]
                            : value.filter((id) => id !== resource.id),
                        )
                      }
                    />
                    <span>
                      <strong>{resource.name}</strong>
                      <span className="ml-2 text-xs opacity-70">
                        v{resource.version ?? 1} · {resource.skills.join("、") || "无 Skill"}
                      </span>
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        )}
        <p className="mt-4 text-xs opacity-70">最多选择 {PICKS_MAX} 个资源；多个资源里的同名 Skill 不能同时选择。</p>
        {status?.tone === "error" && (
          <p role="alert" className="mt-3 text-sm text-red-600">
            {status.text}
          </p>
        )}
      </Modal>
    </section>
  );
}
