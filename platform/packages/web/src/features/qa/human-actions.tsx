import { useEffect, useState } from "react";
import { Button } from "@prismshadow/penguin-ui";
import { apiFetch } from "../../api/client";

interface HumanAction {
  run_id: string;
  action_id: string;
  question: string;
  status: string;
}
export function QaHumanActions({ sessionId }: { sessionId: string }) {
  const [actions, setActions] = useState<HumanAction[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const base = `/api/sessions/${encodeURIComponent(sessionId)}/human-actions`;
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    setActions([]);
    setError("");
    const poll = async () => {
      try {
        const value = await apiFetch<{ actions: HumanAction[] }>(base);
        if (alive) {
          setActions(value.actions);
          setError("");
        }
      } catch {
        if (alive) setError("人工操作状态暂不可用，请稍后重试。");
      } finally {
        if (alive) timer = setTimeout(() => void poll(), 5000);
      }
    };
    void poll();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [base]);
  const answer = async (action: HumanAction, decision: "continue" | "cancel") => {
    setBusy(action.action_id);
    setError("");
    try {
      await apiFetch(base, {
        method: "POST",
        body: { run_id: action.run_id, action_id: action.action_id, decision },
      });
      setActions((await apiFetch<{ actions: HumanAction[] }>(base)).actions);
    } catch (e) {
      setError(e instanceof Error ? e.message : "原任务暂不能续接，请刷新查看。");
    } finally {
      setBusy(null);
    }
  };
  const pending = actions.filter((a) => a.status === "waiting_human" || a.status === "not_sent");
  if (!pending.length && !error) return null;
  return (
    <section className="my-2 rounded-lg border border-amber-400 p-3" aria-label="测试人工操作">
      {pending.map((a) => (
        <div key={a.action_id} className="mb-2">
          <p className="mb-2 text-sm">{a.question}</p>
          <div className="flex gap-2">
            <Button disabled={busy !== null} onClick={() => void answer(a, "continue")}>
              已完成，继续原任务
            </Button>
            <Button disabled={busy !== null} onClick={() => void answer(a, "cancel")}>
              取消并收集已有结果
            </Button>
          </div>
        </div>
      ))}
      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}
    </section>
  );
}
