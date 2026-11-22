/**
 * 管理后台 → 渠道管理（按 2026-10-16 已确认原型 model-channel-redesign.html 重做）。
 *
 * 职责分层不变：**平台管渠道，用户管模型**——管理员维护渠道（显示名、接口地址、协议），
 * 用户在 设置→模型配置 里选渠道并填自己的 API Key（BYOK）。
 *
 * 原型 → 现实的映射（不虚构数据）：
 * - 连通状态：调 `detectProtocol` 无 key 探测（协议形状的 401/403 也证明路由可达）；
 *   结果只存在本次会话内存里，不持久化——「最近检测」只统计已检测过的渠道。
 * - 接口地址为空的渠道用的是协议内置默认地址，无从探测——检测按钮禁用并说明原因。
 * - 原型示意里的「mnsap」「N 个智能体使用中」「已发布」等字段平台数据模型没有，不做假数据：
 *   托管模型行显示 modelId / 别名 / 视觉标记 / 默认标记。
 * - 「默认」徽章 = 当前默认模型（`defaultModel`）所在渠道。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  Button,
  GlyphIcon,
  ICONS,
  ICON_SIZE,
  IconButton,
  Modal,
  Select,
  toastError,
  toastSuccess,
  RequiredMark,
} from "@prismshadow/penguin-ui";
import * as api from "../../api/endpoints";
import type { ModelInfo, ModelsResponse } from "@prismshadow/penguin-server/api";

/** 渠道视图：由中央模型目录的 providers + models 派生。 */
interface ChannelView {
  id: string;
  displayName: string;
  baseUrl: string;
  clientType: string;
  /** 该渠道下平台侧托管的模型条目（管理端可见全部）。 */
  rows: ModelInfo[];
}

/** 每渠道的会话内连通状态：检测结果不持久化，「尚未检测」就是没测过。 */
interface ConnState {
  ok: boolean;
  at: number;
  detail: string;
}

const CLIENT_TYPES: ReadonlyArray<{ value: string; label: string; desc: string; iconClass: string }> = [
  {
    value: "",
    label: "跟随默认（自动探测）",
    desc: "接入时按接口返回自动探测协议，适合网关类地址；探测失败时该渠道的连接检查会报异常。",
    iconClass: "bg-violet-600",
  },
  {
    value: "openai-chat",
    label: "OpenAI 兼容 (chat)",
    desc: "兼容 OpenAI Chat Completions 接口格式的网关，路径默认 /v1/chat/completions。",
    iconClass: "bg-emerald-600",
  },
  {
    value: "openai-responses",
    label: "OpenAI Responses",
    desc: "OpenAI Responses 接口格式的网关，路径默认 /v1/responses。",
    iconClass: "bg-blue-600",
  },
  {
    value: "ant-messages",
    label: "自定义协议 (messages)",
    desc: "平台自有 messages 协议的模型服务，按协议路径直连。",
    iconClass: "bg-amber-600",
  },
];

const clientTypeMeta = (value: string) => CLIENT_TYPES.find((item) => item.value === value) ?? CLIENT_TYPES[0]!;

const emptyDraft = (): Draft => ({ editId: null, id: "", displayName: "", baseUrl: "", clientType: "" });

interface Draft {
  /** 编辑时的原 id；新建为 null。渠道 id 是存储键，编辑时不可改。 */
  editId: string | null;
  id: string;
  displayName: string;
  baseUrl: string;
  clientType: string;
}

type ProbeState =
  | { kind: "idle" }
  | { kind: "testing" }
  | { kind: "ok"; message: string }
  | { kind: "fail"; message: string };

const timeText = (at: number) => {
  const date = new Date(at);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
};

export function AdminChannelsPage() {
  const [table, setTable] = useState<ModelsResponse | null>(null);
  const [loadError, setLoadError] = useState("");
  const [conn, setConn] = useState<Record<string, ConnState | undefined>>({});
  const [testing, setTesting] = useState<Record<string, boolean>>({});
  const [testingAll, setTestingAll] = useState(false);
  const [dialog, setDialog] = useState<Draft | null>(null);
  const [probe, setProbe] = useState<ProbeState>({ kind: "idle" });
  const [busy, setBusy] = useState(false);
  const [drawerId, setDrawerId] = useState<string | null>(null);
  const [delTarget, setDelTarget] = useState<ChannelView | null>(null);
  const [query, setQuery] = useState("");
  const [protoFilter, setProtoFilter] = useState("");

  const reload = useCallback(async () => {
    try {
      const response = await api.getModels(api.CENTRAL_MODEL_CATALOG_ID, null);
      setTable(response);
      setLoadError("");
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "渠道读取失败，请稍后重试。");
    }
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  const channels = useMemo<ChannelView[]>(() => {
    if (table === null) return [];
    const list = Object.entries(table.providers ?? {}).map(([id, group]) => ({
      id,
      displayName: group.displayName?.trim() || id,
      baseUrl: group.baseUrl ?? "",
      clientType: group.clientType ?? "",
      rows: (table.models ?? []).filter((model) => model.provider === id),
    }));
    list.sort((a, b) => a.displayName.localeCompare(b.displayName, "zh"));
    return list;
  }, [table]);

  const defaultChannelId = table?.defaultModel?.provider ?? null;
  const drawerChannel = channels.find((channel) => channel.id === drawerId) ?? null;

  /* ── 连通性检测（无 key 协议探测）────────────────────────── */

  const probeChannel = useCallback(async (channel: ChannelView): Promise<ConnState> => {
    const response = await api.detectProtocol(api.CENTRAL_MODEL_CATALOG_ID, { baseUrl: channel.baseUrl });
    if (response.detected) {
      const label = CLIENT_TYPES.find((item) => item.value === response.detected)?.label ?? response.detected;
      return { ok: true, at: Date.now(), detail: `探测到协议 ${label}` };
    }
    return { ok: false, at: Date.now(), detail: "未探测到可用协议，请核对接口地址" };
  }, []);

  const testOne = async (channel: ChannelView) => {
    if (testing[channel.id] || !channel.baseUrl) return;
    setTesting((prev) => ({ ...prev, [channel.id]: true }));
    try {
      const state = await probeChannel(channel);
      setConn((prev) => ({ ...prev, [channel.id]: state }));
      if (drawerId === channel.id) setDrawerId(channel.id); // 保持抽屉开合不变，仅刷新内容
      toastSuccess(state.ok ? `渠道 ${channel.id} ${state.detail}` : `渠道 ${channel.id}：${state.detail}`);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "检测请求失败";
      setConn((prev) => ({ ...prev, [channel.id]: { ok: false, at: Date.now(), detail } }));
      toastError(`渠道 ${channel.id} 检测失败：${detail}`);
    } finally {
      setTesting((prev) => ({ ...prev, [channel.id]: false }));
    }
  };

  const testAll = async () => {
    if (testingAll) return;
    const targets = channels.filter((channel) => channel.baseUrl);
    setTestingAll(true);
    try {
      const results = await Promise.allSettled(targets.map((channel) => probeChannel(channel)));
      const next: Record<string, ConnState | undefined> = {};
      targets.forEach((channel, index) => {
        const result = results[index];
        next[channel.id] = result !== undefined && result.status === "fulfilled"
          ? result.value
          : { ok: false, at: Date.now(), detail: result !== undefined && result.status === "rejected" && result.reason instanceof Error ? result.reason.message : "检测请求失败" };
      });
      setConn((prev) => ({ ...prev, ...next }));
      const okCount = Object.values(next).filter((state) => state?.ok).length;
      const skipped = channels.length - targets.length;
      toastSuccess(`检测完成：${okCount} 个连通 · ${targets.length - okCount} 个异常${skipped > 0 ? ` · ${skipped} 个无自定义地址未检测` : ""}`);
    } finally {
      setTestingAll(false);
    }
  };

  /* ── 添加 / 编辑 ────────────────────────────────────────── */

  const openDialog = (channel?: ChannelView) => {
    setProbe({ kind: "idle" });
    setDialog(channel
      ? { editId: channel.id, id: channel.id, displayName: channel.displayName === channel.id ? "" : channel.displayName, baseUrl: channel.baseUrl, clientType: channel.clientType }
      : emptyDraft());
  };

  const slugOk = dialog !== null && /^[a-zA-Z][a-zA-Z0-9_-]{0,99}$/.test(dialog.id.trim());
  const slugDuplicate = dialog !== null && dialog.editId === null && channels.some((channel) => channel.id === dialog.id.trim());
  const canSave = dialog !== null && slugOk && !slugDuplicate && dialog.displayName.trim().length > 0 && !busy;

  const runProbe = async () => {
    if (dialog === null || !dialog.baseUrl.trim() || probe.kind === "testing") return;
    setProbe({ kind: "testing" });
    try {
      const response = await api.detectProtocol(api.CENTRAL_MODEL_CATALOG_ID, { baseUrl: dialog.baseUrl.trim() });
      if (response.detected) {
        const label = CLIENT_TYPES.find((item) => item.value === response.detected)?.label ?? response.detected;
        setProbe({ kind: "ok", message: `连接成功：探测到协议 ${label}` });
      } else {
        setProbe({ kind: "fail", message: "未探测到可用协议：请核对接口地址是否可达" });
      }
    } catch (error) {
      setProbe({ kind: "fail", message: error instanceof Error ? error.message : "检测请求失败" });
    }
  };

  const save = async () => {
    if (dialog === null || busy || !canSave) return;
    const id = dialog.id.trim();
    setBusy(true);
    try {
      await api.putProviderConnection(api.CENTRAL_MODEL_CATALOG_ID, id, {
        displayName: dialog.displayName.trim() || undefined,
        baseUrl: dialog.baseUrl.trim() || null,
        clientType: dialog.clientType === "" ? null : dialog.clientType,
      });
      setDialog(null);
      toastSuccess(dialog.editId === null ? `渠道 ${id} 已创建，建议立即执行连通性检测。` : "渠道已更新。");
      await reload();
    } catch (error) {
      toastError(error instanceof Error ? error.message : "保存失败，请稍后重试。");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (channel: ChannelView) => {
    if (busy) return;
    setBusy(true);
    try {
      await api.deleteChannel(channel.id);
      setDelTarget(null);
      if (drawerId === channel.id) setDrawerId(null);
      toastSuccess("渠道已删除。");
      await reload();
    } catch (error) {
      toastError(error instanceof Error ? error.message : "删除失败，请稍后重试。");
    } finally {
      setBusy(false);
    }
  };

  const copyUrl = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      toastSuccess("已复制接口地址。");
    } catch {
      toastError("复制失败：浏览器未授予剪贴板权限。");
    }
  };

  /* ── 汇总 ──────────────────────────────────────────────── */

  const checked = channels.filter((channel) => conn[channel.id] !== undefined);
  const okCount = checked.filter((channel) => conn[channel.id]?.ok).length;
  const hostedTotal = channels.reduce((sum, channel) => sum + channel.rows.length, 0);
  const lastCheckedAt = checked.reduce<number | null>((latest, channel) => {
    const at = conn[channel.id]?.at ?? 0;
    return latest === null || at > latest ? at : latest;
  }, null);

  const filtered = channels.filter((channel) => {
    if (protoFilter && channel.clientType !== protoFilter) return false;
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return channel.id.toLowerCase().includes(q)
      || channel.displayName.toLowerCase().includes(q)
      || channel.baseUrl.toLowerCase().includes(q);
  });

  /* ── 渲染 ──────────────────────────────────────────────── */

  return (
    <div className="mx-auto w-full max-w-[1180px] px-6 py-6">
      {loadError !== null && <p className="mb-4 text-sm text-red-600" role="alert">{loadError}</p>}

      {/* 页头：说明 + 测试全部连通性 + 添加渠道 */}
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-lg font-semibold">渠道管理</h1>
          <p className="mt-1.5 max-w-[720px] text-xs leading-relaxed text-muted-foreground">
            渠道接入（<b className="font-semibold text-brand-700">接口地址 + 协议</b>）由平台统一维护；用户在{" "}
            <b className="font-semibold text-brand-700">设置 → 模型配置</b> 里选择渠道并填入自己的 API Key 接入模型（BYOK），
            渠道不代管密钥。
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button variant="ghost" disabled={testingAll || channels.length === 0} onClick={() => void testAll()}>
            {testingAll ? "正在检测全部渠道…" : "测试全部连通性"}
          </Button>
          <Button onClick={() => openDialog()}>添加渠道</Button>
        </div>
      </div>

      {/* 汇总 chips */}
      {channels.length > 0 && (
        <div className="mt-4 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-line-muted bg-surface-muted px-3 py-1">
            <i className={`h-1.5 w-1.5 rounded-full ${okCount === checked.length ? "bg-emerald-500" : "bg-red-500"}`} aria-hidden="true" />
            渠道 <b className="tabular-nums font-semibold text-foreground">{channels.length}</b> 个 · 连通{" "}
            <b className="tabular-nums font-semibold text-foreground">{okCount}</b> / 异常{" "}
            <b className="tabular-nums font-semibold text-foreground">{checked.length - okCount}</b>
          </span>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-line-muted bg-surface-muted px-3 py-1">
            托管模型 <b className="tabular-nums font-semibold text-foreground">{hostedTotal}</b> 个
          </span>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-line-muted bg-surface-muted px-3 py-1">
            默认渠道 <b className="font-semibold text-foreground">{defaultChannelId ?? "未设置"}</b>
          </span>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-line-muted bg-surface-muted px-3 py-1">
            最近检测 <b className="tabular-nums font-semibold text-foreground">{lastCheckedAt === null ? "尚未检测" : timeText(lastCheckedAt)}</b>
          </span>
        </div>
      )}

      {/* 工具栏：搜索 + 协议筛选 + 计数 */}
      {channels.length > 0 && (
        <div className="mt-4 flex items-center gap-2">
          <input
            type="search"
            className="w-60 rounded-md border border-line-muted bg-transparent px-3 py-1.5 text-sm"
            placeholder="搜索渠道标识 / 名称 / 地址"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            aria-label="搜索渠道"
          />
          <Select value={protoFilter} onChange={(event) => setProtoFilter(event.target.value)} aria-label="按协议筛选">
            <option value="">全部协议</option>
            {CLIENT_TYPES.map((item) => (<option key={item.value} value={item.value}>{item.label}</option>))}
          </Select>
          <span className="ml-auto text-xs text-muted-foreground">共 {filtered.length} 个渠道</span>
        </div>
      )}

      {/* 渠道卡片网格 */}
      {channels === null || table === null ? (
        <p className="py-8 text-center text-sm text-muted-foreground">正在加载渠道…</p>
      ) : channels.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">还没有渠道。点击「添加渠道」接入第一个供应商。</p>
      ) : filtered.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">没有符合条件的渠道。</p>
      ) : (
        <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {filtered.map((channel) => {
            const state = conn[channel.id];
            const meta = clientTypeMeta(channel.clientType);
            return (
              <div
                key={channel.id}
                className="flex cursor-pointer flex-col rounded-xl border border-line-muted bg-surface-muted px-4 py-3.5 hover:border-brand-200"
                onClick={() => setDrawerId(channel.id)}
              >
                <div className="flex items-center gap-2">
                  <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-sm font-bold text-white ${meta.iconClass}`} aria-hidden="true">
                    {channel.id.charAt(0).toUpperCase()}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold">{channel.displayName}</p>
                    <p className="truncate font-mono text-xs text-muted-foreground" title={channel.id}>{channel.id}</p>
                  </div>
                  <span className="shrink-0 rounded-full bg-surface px-2 py-0.5 text-xs text-muted-foreground">{meta.label}</span>
                  {channel.id === defaultChannelId && (
                    <span className="shrink-0 rounded-full bg-brand-50 px-2 py-0.5 text-xs font-semibold text-brand-700">默认</span>
                  )}
                  <div className="flex shrink-0 items-center" onClick={(event) => event.stopPropagation()}>
                    <IconButton variant="ghost" size="sm" label={`编辑 ${channel.displayName}`} onClick={() => openDialog(channel)}>
                      <GlyphIcon d={ICONS.pencil} size={ICON_SIZE.iconButton} />
                    </IconButton>
                    <IconButton variant="ghost" size="sm" label={`删除 ${channel.displayName}`} onClick={() => setDelTarget(channel)}>
                      <GlyphIcon d={ICONS.trash} size={ICON_SIZE.iconButton} />
                    </IconButton>
                  </div>
                </div>

                <div className="mt-3 flex items-center gap-2 rounded-lg bg-surface px-2.5 py-1.5">
                  <code className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground" title={channel.baseUrl || "（渠道默认地址）"}>
                    {channel.baseUrl || "（渠道默认地址）"}
                  </code>
                  {channel.baseUrl !== "" && (
                    <button
                      type="button"
                      className="shrink-0 rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:text-brand-700"
                      title="复制接口地址"
                      onClick={(event) => { event.stopPropagation(); void copyUrl(channel.baseUrl); }}
                    >复制</button>
                  )}
                </div>

                <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                  {state === undefined ? (
                    <span>尚未检测</span>
                  ) : (
                    <span className="inline-flex items-center gap-1.5">
                      <i className={`h-2 w-2 rounded-full ${state.ok ? "bg-emerald-500" : "bg-red-500"}`} aria-hidden="true" />
                      <b className={state.ok ? "font-semibold text-emerald-700" : "font-semibold text-red-600"}>
                        {state.ok ? "连通" : "异常"}
                      </b>
                      <span>· {timeText(state.at)}检测</span>
                    </span>
                  )}
                  <span>托管模型 <b className="tabular-nums font-semibold text-foreground">{channel.rows.length}</b> 个</span>
                </div>

                <div className="mt-3 flex items-center gap-1.5 border-t border-dashed border-line-muted pt-2.5" onClick={(event) => event.stopPropagation()}>
                  <button type="button" className="rounded px-2 py-1 text-xs font-semibold text-brand-700 hover:bg-brand-50" onClick={() => setDrawerId(channel.id)}>
                    查看托管模型 →
                  </button>
                  <span className="flex-1" />
                  <button
                    type="button"
                    className="rounded px-2 py-1 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
                    disabled={!channel.baseUrl || testing[channel.id] === true || testingAll}
                    title={channel.baseUrl ? "无 key 探测接口路由" : "使用协议内置默认地址，无可探测的自定义地址"}
                    onClick={() => void testOne(channel)}
                  >
                    {testing[channel.id] === true ? "检测中…" : "⇄ 测试连通性"}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* 添加 / 编辑弹窗 */}
      {dialog !== null && (
        <Modal open title={dialog.editId === null ? "添加渠道" : "编辑渠道"} onClose={() => setDialog(null)} widthClass="sm:max-w-lg">
          <p className="text-xs text-muted-foreground">
            {dialog.editId === null ? "渠道由平台统一维护，创建后用户即可选择使用。" : `正在编辑 ${dialog.editId}；渠道标识不可修改。`}
          </p>
          <div className="mt-3 flex flex-col gap-4">
            <label className="flex flex-col gap-1.5 text-sm">
              <span className="font-medium">渠道标识 <RequiredMark /></span>
              <input
                type="text"
                className={`w-full rounded-md border bg-transparent px-3 py-2 text-sm ${dialog.editId === null && dialog.id.trim() !== "" && !slugOk ? "border-red-500" : "border-line-muted"}`}
                placeholder="例如 my-gateway（字母开头，可含数字、-、_）"
                value={dialog.id}
                readOnly={dialog.editId !== null}
                onChange={(event) => setDialog({ ...dialog, id: event.target.value })}
              />
              <span className={`text-xs ${dialog.editId !== null ? "text-muted-foreground" : slugOk ? "text-emerald-700" : dialog.id.trim() === "" ? "text-muted-foreground" : "text-red-600"}`}>
                {dialog.editId !== null ? "标识是存储键，编辑时不可修改。"
                  : dialog.id.trim() === "" ? "创建后不可修改；同一标识全局唯一。"
                    : slugOk ? "✓ 标识格式正确"
                      : "✗ 字母开头，仅可含数字、-、_，100 字以内。"}
              </span>
              {slugDuplicate && <span className="text-xs text-red-600">✗ 标识已存在，请更换。</span>}
            </label>
            <label className="flex flex-col gap-1.5 text-sm">
              <span className="font-medium">显示名称 <RequiredMark /></span>
              <input
                type="text"
                className="w-full rounded-md border border-line-muted bg-transparent px-3 py-2 text-sm"
                placeholder="例如 企业统一网关"
                maxLength={40}
                value={dialog.displayName}
                onChange={(event) => setDialog({ ...dialog, displayName: event.target.value })}
              />
            </label>
            <label className="flex flex-col gap-1.5 text-sm">
              <span className="font-medium">接口地址</span>
              <div className="flex items-center gap-2 rounded-md border border-line-muted px-3 py-1.5 focus-within:border-brand-600">
                <input
                  type="text"
                  className="min-w-0 flex-1 bg-transparent py-1 text-sm"
                  placeholder="https://api.example.com/v1（留空使用该渠道默认地址）"
                  value={dialog.baseUrl}
                  onChange={(event) => { setDialog({ ...dialog, baseUrl: event.target.value }); setProbe({ kind: "idle" }); }}
                />
                <button
                  type="button"
                  className="shrink-0 rounded px-2 py-1 text-xs font-semibold text-brand-700 hover:bg-brand-50 disabled:opacity-50"
                  disabled={!dialog.baseUrl.trim() || probe.kind === "testing"}
                  title={dialog.baseUrl.trim() ? "无 key 探测接口路由" : "先填写接口地址"}
                  onClick={() => void runProbe()}
                >
                  {probe.kind === "testing" ? "检测中…" : "⇄ 测试连接"}
                </button>
              </div>
              <span className={`text-xs ${probe.kind === "ok" ? "text-emerald-700" : probe.kind === "fail" ? "text-red-600" : "text-muted-foreground"}`}>
                {probe.kind === "ok" || probe.kind === "fail" ? probe.message : "留空时使用协议内置默认地址；填写后以自定义地址为准。"}
              </span>
            </label>
            <label className="flex flex-col gap-1.5 text-sm">
              <span className="font-medium">协议</span>
              <Select value={dialog.clientType} onChange={(event) => setDialog({ ...dialog, clientType: event.target.value })} aria-label="协议">
                {CLIENT_TYPES.map((item) => (<option key={item.value} value={item.value}>{item.label}</option>))}
              </Select>
              <span className="rounded-lg bg-surface-muted px-3 py-2 text-xs leading-relaxed text-muted-foreground">
                <b className="font-semibold text-foreground">{clientTypeMeta(dialog.clientType).label}：</b>
                {clientTypeMeta(dialog.clientType).desc}
              </span>
            </label>
            <p className="rounded-lg bg-brand-50 px-3 py-2 text-xs leading-relaxed text-brand-800">
              <b className="font-semibold">渠道不保存 API Key：</b>每个用户在模型配置里填自己的密钥（BYOK）。渠道仅维护接入地址与协议，可用性检测由管理员执行。
            </p>
          </div>
          <div className="mt-5 flex items-center justify-end gap-2">
            <span className="mr-auto text-xs text-muted-foreground">{dialog.editId !== null ? "标识创建后不可修改" : ""}</span>
            <Button variant="ghost" onClick={() => setDialog(null)}>取消</Button>
            <Button disabled={!canSave} onClick={() => void save()}>{busy ? "保存中…" : "保存"}</Button>
          </div>
        </Modal>
      )}

      {/* 删除确认 */}
      {delTarget !== null && (
        <Modal open title="删除渠道" onClose={() => setDelTarget(null)} widthClass="sm:max-w-md">
          <div className="text-sm leading-relaxed text-muted-foreground">
            <p>
              确认删除渠道 <b className="text-foreground">{delTarget.displayName}</b>
              （<code className="font-mono text-xs">{delTarget.id}</code>）？
            </p>
            {delTarget.rows.length > 0 ? (
              <p className="mt-2">
                该渠道下有 <b className="tabular-nums text-red-600">{delTarget.rows.length} 个托管模型条目</b>，删除后会一并移除。
              </p>
            ) : (
              <p className="mt-2">该渠道暂无托管模型条目。</p>
            )}
            {delTarget.id === defaultChannelId && (
              <p className="mt-2"><b className="text-red-600">注意：当前默认模型在该渠道下，删除后需重新设置默认模型。</b></p>
            )}
            <p className="mt-2">用户自己的 API Key 配置不受影响（BYOK，密钥在用户侧）。</p>
          </div>
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setDelTarget(null)}>取消</Button>
            <Button variant="danger" disabled={busy} onClick={() => void remove(delTarget)}>{busy ? "删除中…" : "确认删除"}</Button>
          </div>
        </Modal>
      )}

      {/* 渠道详情抽屉 */}
      {drawerChannel !== null && (
        <ChannelDrawer
          channel={drawerChannel}
          isDefault={drawerChannel.id === defaultChannelId}
          state={conn[drawerChannel.id]}
          testing={testing[drawerChannel.id] === true || testingAll}
          canProbe={drawerChannel.baseUrl !== ""}
          onClose={() => setDrawerId(null)}
          onEdit={() => { setDrawerId(null); openDialog(drawerChannel); }}
          onRetest={() => void testOne(drawerChannel)}
          onDelete={() => setDelTarget(drawerChannel)}
          onCopy={() => void copyUrl(drawerChannel.baseUrl)}
        />
      )}
    </div>
  );
}

/** 渠道详情抽屉（560px 右滑；按原型不做人场动画——开门见山，不做转场）。 */
function ChannelDrawer({
  channel,
  isDefault,
  state,
  testing,
  canProbe,
  onClose,
  onEdit,
  onRetest,
  onDelete,
  onCopy,
}: {
  channel: ChannelView;
  isDefault: boolean;
  state: ConnState | undefined;
  testing: boolean;
  canProbe: boolean;
  onClose: () => void;
  onEdit: () => void;
  onRetest: () => void;
  onDelete: () => void;
  onCopy: () => void;
}) {
  const meta = clientTypeMeta(channel.clientType);
  return createPortal(
    <div className="fixed inset-0 z-50" role="presentation">
      <div className="absolute inset-0 bg-black/35" onClick={onClose} aria-hidden="true" />
      <aside
        className="absolute inset-y-0 right-0 flex w-[560px] max-w-[94vw] flex-col bg-white shadow-xl"
        role="dialog"
        aria-label={`渠道详情：${channel.displayName}`}
      >
        <header className="flex items-center gap-3 border-b border-line-muted px-6 py-4">
          <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-base font-bold text-white ${meta.iconClass}`} aria-hidden="true">
            {channel.id.charAt(0).toUpperCase()}
          </span>
          <div className="min-w-0 flex-1">
            <p className="flex items-center gap-2 text-base font-semibold">
              {channel.displayName}
              {isDefault && <span className="rounded-full bg-brand-50 px-2 py-0.5 text-xs font-semibold text-brand-700">默认</span>}
            </p>
            <p className="truncate font-mono text-xs text-muted-foreground">{channel.id}</p>
          </div>
          <button type="button" className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-surface-muted hover:text-foreground" aria-label="关闭详情" onClick={onClose}>
            <span aria-hidden="true">✕</span>
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-6 py-4">
          <section aria-label="渠道信息">
            <h3 className="mb-2 text-sm font-semibold">渠道信息</h3>
            <div className="grid grid-cols-2 gap-2">
              <div className="rounded-lg bg-surface-muted px-3 py-2">
                <p className="text-xs text-muted-foreground">接口地址</p>
                <p className="flex items-center gap-1.5">
                  <code className="min-w-0 flex-1 truncate font-mono text-xs" title={channel.baseUrl || "（渠道默认地址）"}>
                    {channel.baseUrl || "（渠道默认地址）"}
                  </code>
                  {channel.baseUrl !== "" && (
                    <button type="button" className="shrink-0 text-xs text-muted-foreground hover:text-brand-700" onClick={onCopy}>复制</button>
                  )}
                </p>
              </div>
              <div className="rounded-lg bg-surface-muted px-3 py-2">
                <p className="text-xs text-muted-foreground">协议</p>
                <p className="text-xs font-semibold">{meta.label}</p>
              </div>
              <div className="rounded-lg bg-surface-muted px-3 py-2">
                <p className="text-xs text-muted-foreground">连通状态</p>
                {state === undefined ? (
                  <p className="text-xs font-semibold text-muted-foreground">尚未检测</p>
                ) : (
                  <p className={`text-xs font-semibold ${state.ok ? "text-emerald-700" : "text-red-600"}`}>
                    {state.ok ? "● 连通" : "● 异常"}（{timeText(state.at)}检测）
                  </p>
                )}
                {state !== undefined && !state.ok && <p className="mt-0.5 text-xs text-muted-foreground">{state.detail}</p>}
              </div>
              <div className="rounded-lg bg-surface-muted px-3 py-2">
                <p className="text-xs text-muted-foreground">托管模型</p>
                <p className="text-xs font-semibold tabular-nums">{channel.rows.length} 个</p>
              </div>
            </div>
          </section>

          <section aria-label="托管模型" className="mt-5">
            <h3 className="mb-2 text-sm font-semibold">
              托管模型
              <span className="ml-2 text-xs font-normal text-muted-foreground">用户可用性取决于自己的 API Key</span>
            </h3>
            {channel.rows.length === 0 ? (
              <p className="rounded-lg border border-dashed border-line-muted px-3 py-4 text-center text-xs text-muted-foreground">
                该渠道暂无托管模型条目（纯渠道，仅提供接入地址）。
              </p>
            ) : (
              channel.rows.map((row) => (
                <div key={`${row.provider}:${row.modelId}`} className="mt-2 flex items-center gap-2 rounded-lg border border-line-muted px-3 py-2">
                  <span className={`flex h-7.5 w-7.5 shrink-0 items-center justify-center rounded-md text-xs font-bold text-white ${row.vision ? "bg-purple-600" : meta.iconClass}`} aria-hidden="true">
                    {row.vision ? "视" : "话"}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-2">
                      <code className="truncate font-mono text-xs">{row.modelId}</code>
                      {row.isDefault && <span className="shrink-0 rounded-full bg-brand-50 px-1.5 text-xs font-semibold text-brand-700">默认</span>}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      {row.displayName && row.displayName !== row.modelId ? `${row.displayName} · ` : ""}
                      {row.vision ? "对话 · 视觉" : "对话"}
                      {row.clientType ? ` · ${row.clientType}` : ""}
                    </p>
                  </div>
                </div>
              ))
            )}
          </section>
        </div>

        <footer className="flex items-center gap-2 border-t border-line-muted px-6 py-3">
          <Button variant="ghost" onClick={onEdit}>编辑渠道</Button>
          <Button variant="ghost" disabled={!canProbe || testing} title={canProbe ? "无 key 探测接口路由" : "使用协议内置默认地址，无可探测的自定义地址"} onClick={onRetest}>
            {testing ? "检测中…" : "重新检测"}
          </Button>
          <span className="flex-1" />
          <Button variant="ghost" className="text-red-600" onClick={onDelete}>删除</Button>
        </footer>
      </aside>
    </div>,
    document.body,
  );
}
