/**
 * The composer's `/personal-skill` chooser: a round-scoped personal Skill selection for the
 * Session on screen (Q1's `personal-resources` endpoints).
 *
 * The choice is pinned to this Session's next accepted round — it is never installed into the
 * Agent. The send path reads the active selection on the server and consumes it only after the
 * task was accepted; a failed send leaves it in place. Reopening this dialog after a send shows
 * the consumed record (or no active selection), so what the person sees is the service's state,
 * not a local guess.
 */
import { useEffect, useState } from "react";
import { Link } from "react-router";
import { Button, Modal } from "@prismshadow/penguin-ui";
import { apiFetch, ApiError } from "../../api/client";
import { apiErrorText } from "../../lib/api-error";
import { randomHex } from "../../lib/random-id";
import { useProject } from "../../state/project";
import {
  canCancel,
  selectionErrorHint,
  selectionHeadline,
  selectionLines,
  selectionStatusLabel,
  type PersonalResourceSummary,
  type RoundSelectionView,
} from "../qa/personal-skill-selection";

const PICKS_MAX = 20;

function errorText(error: unknown): string {
  const code = error instanceof ApiError ? error.code : undefined;
  return selectionErrorHint(code) ?? apiErrorText(error);
}

export function SessionPersonalSkill({
  sessionId,
  agentId,
  open,
  onClose,
}: {
  sessionId: string;
  agentId: string;
  open: boolean;
  onClose: () => void;
}) {
  const { currentProject } = useProject();
  const projectId = currentProject?.projectId;
  const base = `/api/projects/${encodeURIComponent(projectId ?? "")}/agents/qa/personal-resources`;

  const [resources, setResources] = useState<PersonalResourceSummary[] | null>(null);
  const [current, setCurrent] = useState<RoundSelectionView | null>(null);
  const [loading, setLoading] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !projectId) return;
    let alive = true;
    setLoading(true);
    setError(null);
    setNotice(null);
    Promise.all([
      apiFetch<{ resources: PersonalResourceSummary[] }>(base),
      apiFetch<{ selection: RoundSelectionView | null }>(`${base}/selection`, {
        query: { sessionId, agentId },
      }),
    ])
      .then(([list, answer]) => {
        if (!alive) return;
        setResources(list.resources);
        setCurrent(answer.selection);
        setPicked(answer.selection?.resources.map((resource) => resource.resourceId) ?? []);
      })
      .catch((failure: unknown) => {
        if (alive) setError(errorText(failure));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [open, base, projectId, sessionId, agentId]);

  async function create() {
    if (busy || picked.length === 0) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const answer = await apiFetch<{ selection: RoundSelectionView }>(`${base}/selection`, {
        method: "POST",
        body: {
          sessionId,
          agentId,
          resources: picked.map((resourceId) => ({ resourceId })),
          roundKey: `ui-${randomHex(16)}`,
        },
      });
      setCurrent(answer.selection);
      setNotice(`已记录第 ${answer.selection.round} 轮选择，仅本轮生效。`);
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    if (!current || busy) return;
    if (!window.confirm("取消本轮选择？本轮快照会被删除，默认 Skill 不受影响。")) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await apiFetch(`${base}/selection/${encodeURIComponent(current.selectionId)}`, {
        method: "DELETE",
      });
      setCurrent(null);
      setPicked([]);
      setNotice("已取消本轮选择，默认 Skill 保持不变。");
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(false);
    }
  }

  if (!open) return null;

  return (
    <Modal
      open={open}
      title="选择本轮个人技能"
      onClose={() => {
        if (!busy) onClose();
      }}
      footer={
        <>
          <Button size="sm" disabled={busy} onClick={onClose}>
            关闭
          </Button>
          {current?.status !== "active" && (
            <Button
              size="sm"
              variant="primary"
              disabled={busy || picked.length === 0 || (resources?.length ?? 0) === 0}
              onClick={() => void create()}
            >
              {busy ? "正在创建…" : "创建本轮选择"}
            </Button>
          )}
        </>
      }
    >
      <p className="mb-4 text-sm opacity-70">
        仅对本会话的下一次发送生效：服务端在任务被接受后自动清空本轮选择；发送失败不会消耗。
        个人资源不会被安装到智能体，未选择时默认 Skill 保持不变。
      </p>
      {!projectId ? (
        <p role="alert" className="text-sm text-red-600">
          当前会话还没有关联项目，无法读取个人资源。
        </p>
      ) : loading ? (
        <p className="text-sm opacity-70">正在读取个人资源和本轮选择…</p>
      ) : (
        <>
          {current !== null && (
            <div className="mb-4 rounded border border-[var(--border)] p-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <strong>{selectionHeadline(current)}</strong>
                <span className="text-xs opacity-70">
                  {selectionStatusLabel(current.status)}
                </span>
              </div>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-xs">
                {selectionLines(current, Date.now()).map((line, index) => (
                  <li key={`${index}-${line}`}>{line}</li>
                ))}
              </ul>
              {current.status === "active" ? (
                <Button
                  size="sm"
                  className="mt-3"
                  disabled={busy}
                  onClick={() => void cancel()}
                >
                  取消本轮选择
                </Button>
              ) : current.status === "consumed" ? (
                <p className="mt-2 text-xs opacity-70">
                  本轮已随任务发送被使用；下一轮回到默认 Skill，除非重新选择。
                </p>
              ) : (
                <p className="mt-2 text-xs opacity-70">
                  本轮选择已失效；可重新选择资源创建新一轮。
                </p>
              )}
            </div>
          )}
          {resources === null ? (
            error && (
              <p role="alert" className="text-sm text-red-600">
                {error}
              </p>
            )
          ) : resources.length === 0 ? (
            <p className="text-sm opacity-70">
              还没有可选择的个人资源。请到<Link className="underline" to="/qa/personal-skills">我的技能</Link>上传技能 ZIP。
            </p>
          ) : (
            <>
              <p className="mb-2 text-xs opacity-70">
                资源版本与内容哈希会随本轮选择一起固定，发送后在任务上下文中生效。
              </p>
              <ul className="max-h-72 space-y-2 overflow-y-auto pr-1">
                {resources.map((resource) => {
                  const checked = picked.includes(resource.id);
                  const full = picked.length >= PICKS_MAX && !checked;
                  return (
                    <li key={resource.id}>
                      <label className="flex gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={busy || full || current?.status === "active"}
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
              <p className="mt-3 text-xs opacity-70">
                最多选择 {PICKS_MAX} 个资源；多个资源里的同名 Skill 不能同时选择。
                已有生效选择时请先取消，再重新创建。
              </p>
            </>
          )}
          {error && resources !== null && (
            <p role="alert" className="mt-3 text-sm text-red-600">
              {error}
            </p>
          )}
          {notice && (
            <p role="status" className="mt-3 text-sm opacity-70">
              {notice}
            </p>
          )}
        </>
      )}
    </Modal>
  );
}
