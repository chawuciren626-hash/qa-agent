import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { Button } from "@prismshadow/penguin-ui";
import { apiFetch, ApiError } from "../../api/client";
import { useProject } from "../../state/project";
import { useAuth } from "../../state/auth";
import { prepareNewChatDraft } from "../chat/new-chat";

type Status = {
  enabled: boolean;
  status: string;
  canInitialize: boolean;
  roles: { id: string; skills: string[] }[];
};
export function QaProjectEntry() {
  const { currentProject, reloadAgents } = useProject();
  const { user } = useAuth();
  const navigate = useNavigate();
  const id = currentProject?.projectId;
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const base = `/api/projects/${encodeURIComponent(id ?? "")}/agents/qa`;
  useEffect(() => {
    let alive = true;
    setStatus(null);
    setError("");
    if (id)
      apiFetch<Status>(base)
        .then((value) => {
          if (alive) setStatus(value);
        })
        .catch((e) => {
          if (alive && !(e instanceof ApiError && e.status === 404))
            setError("无法读取项目测试配置，请刷新重试。");
        });
    return () => {
      alive = false;
    };
  }, [id, base]);
  if (!status && !error) return null;
  const initialize = async () => {
    setBusy(true);
    setError("");
    try {
      await apiFetch(base + "/initialize", { method: "POST", body: {} });
      setStatus(await apiFetch<Status>(base));
      await reloadAgents();
    } catch (e) {
      setError(e instanceof Error ? e.message : "初始化失败，请稍后重试。");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section
      className="my-4 rounded-lg border border-gray-200 p-4 dark:border-gray-700"
      aria-label="项目测试工作流"
    >
      <h2 className="font-semibold">AITestHarness · 项目测试工作流</h2>
      <p className="my-2 text-sm">
        需求分析 → 测试点 → 测试用例 → Web／接口执行 → 缺陷分析 → HTML
        报告。依据资料分别生成功能、接口产物。
      </p>
      {status?.enabled ? (
        <Button
          onClick={() => {
            if (!user || !id) return;
            prepareNewChatDraft(user.userId, id);
            navigate("/chat/new", { state: { agentId: "test_agent" } });
          }}
        >
          开始测试任务
        </Button>
      ) : status?.canInitialize ? (
        <Button disabled={busy} onClick={() => void initialize()}>
          {busy ? "正在初始化…" : "启用本项目测试能力"}
        </Button>
      ) : (
        <p className="text-sm">请项目所有者启用测试能力。</p>
      )}
      {error && (
        <p role="alert" className="mt-2 text-sm text-red-600">
          {error}
        </p>
      )}
    </section>
  );
}
