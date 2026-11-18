/**
 * 项目列表的「环境」单元格：进度是字段，不是操作。
 *
 * 列表是「看」的地方：把进度做成弹窗，用户关掉就找不到了；做成列内字段，它自己往前走。
 * 四态必须一眼可分，且失败/未跑绝不显示 0 页——0 会被读成「扫过了确实没有页面」。
 */
import type { ManagedProject } from "./types";

export function EnvironmentCell({
  project,
  busy,
  onBootstrap,
  onOpen,
}: {
  project: ManagedProject;
  /** 该环境正在发起建档（按钮防重复提交，与 probing 不同：probing 是服务端在跑）。 */
  busy: boolean;
  onBootstrap: (project: ManagedProject) => void;
  onOpen: (project: ManagedProject) => void;
}) {
  const env = project.environment;
  if (!env) return <span className="qpm-env-none" title="该项目还没有连过环境地址">未连环境</span>;

  if (env.status === "probing") {
    return (
      <button type="button" className="qpm-env-cell" onClick={() => onOpen(project)} title="查看建档进度">
        <i className="qpm-env-dot is-run" aria-hidden="true" />
        <span className="qpm-env-main">建档中…</span>
      </button>
    );
  }

  if (env.status === "registered") {
    const pages = env.pages?.total;
    const apis = env.apis?.total;
    return (
      <button type="button" className="qpm-env-cell" onClick={() => onOpen(project)} title={env.baseUrl}>
        <i className="qpm-env-dot is-ok" aria-hidden="true" />
        <span className="qpm-env-main">{env.env}</span>
        <span className="qpm-env-meta">
          {pages === null || pages === undefined ? "—" : `${pages} 页`}
          {" · "}
          {apis === null || apis === undefined ? "—" : `${apis} 接口`}
        </span>
      </button>
    );
  }

  if (env.status === "failed") {
    return (
      <button type="button" className="qpm-env-cell" onClick={() => onOpen(project)} title={env.lastError ?? "建档失败"}>
        <i className="qpm-env-dot is-fail" aria-hidden="true" />
        <span className="qpm-env-main">建档失败</span>
        <span className="qpm-env-meta">重试</span>
      </button>
    );
  }

  // unregistered：有地址但没跑过建档——可点即建，不是「0 页」。
  return (
    <button type="button" className="qpm-env-add" disabled={busy} onClick={() => onBootstrap(project)}>
      {busy ? "发起中…" : "未建档 · 点击建档"}
    </button>
  );
}
