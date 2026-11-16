/**
 * 管理后台 → 渠道管理（原「模型配置」改造）。
 *
 * 职责分层：**平台管渠道，用户管模型**——管理员只维护渠道（供应商接入层：显示名、接口地址、
 * 协议），不再配置具体模型；用户在 设置→模型配置 里选渠道 + 填自己的 API Key（BYOK）接模型。
 *
 * 数据落在中心模型目录的 providers 表（[providers.<id>]），与用户端「添加模型」的下拉
 * （GET /api/control/channels）同一份数据。列表卡片形式（WorkBuddy 式灰底卡）：
 * 卡头固定说明，渠道卡片网格，操作为 编辑 / 删除。
 */
import { useCallback, useEffect, useState } from "react";
import { Button, GlyphIcon, ICONS, ICON_SIZE, IconButton, Modal, Select, toastError, toastSuccess } from "@prismshadow/penguin-ui";
import * as api from "../../api/endpoints";
import type { ChannelInfo } from "../../api/endpoints";

const CLIENT_TYPES: ReadonlyArray<{ value: string; label: string }> = [
  { value: "", label: "跟随默认（自动探测）" },
  { value: "openai-chat", label: "OpenAI 兼容 (chat)" },
  { value: "openai-responses", label: "OpenAI Responses" },
  { value: "ant-messages", label: "自定义协议 (messages)" },
];

interface Draft {
  /** 编辑时的原 id；新建为 null。渠道 id 是存储键，编辑时不可改。 */
  editId: string | null;
  id: string;
  displayName: string;
  baseUrl: string;
  clientType: string;
}

const emptyDraft = (): Draft => ({ editId: null, id: "", displayName: "", baseUrl: "", clientType: "" });

const clientTypeLabel = (value: string) => CLIENT_TYPES.find((item) => item.value === value)?.label ?? (value || "跟随默认");

export function AdminChannelsPage() {
  const [channels, setChannels] = useState<ChannelInfo[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [dialog, setDialog] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    try {
      const models = await api.getModels(api.CENTRAL_MODEL_CATALOG_ID, null);
      const list = Object.entries(models.providers ?? {}).map(([id, group]) => ({
        id,
        displayName: group.displayName?.trim() || id,
        baseUrl: group.baseUrl ?? "",
        clientType: group.clientType ?? "",
        models: (models.models ?? []).filter((m) => m.provider === id).length,
      }));
      list.sort((a, b) => a.displayName.localeCompare(b.displayName, "zh"));
      setChannels(list);
      setLoadError("");
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "渠道读取失败，请稍后重试。");
    }
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  const save = async () => {
    if (dialog === null || busy) return;
    const id = dialog.id.trim();
    if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,99}$/.test(id)) { toastError("渠道标识无效：字母开头，可含数字、-、_，100 字以内。"); return; }
    setBusy(true);
    try {
      await api.putProviderConnection(api.CENTRAL_MODEL_CATALOG_ID, id, {
        displayName: dialog.displayName.trim() || undefined,
        baseUrl: dialog.baseUrl.trim() || null,
        clientType: dialog.clientType === "" ? null : dialog.clientType,
      });
      setDialog(null);
      toastSuccess(dialog.editId === null ? "渠道已添加。" : "渠道已更新。");
      await reload();
    } catch (error) {
      toastError(error instanceof Error ? error.message : "保存失败，请稍后重试。");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (channel: ChannelInfo) => {
    if (busy) return;
    if (!window.confirm(`删除渠道「${channel.displayName}」？该渠道下平台侧托管的 ${channel.models} 个模型条目会一并移除；用户配置不受影响（用户用自带 key）。`)) return;
    setBusy(true);
    try {
      await api.deleteChannel(channel.id);
      toastSuccess("渠道已删除。");
      await reload();
    } catch (error) {
      toastError(error instanceof Error ? error.message : "删除失败，请稍后重试。");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto w-full max-w-[1180px] px-6 py-6">
      {loadError !== null && <p className="mb-4 text-sm text-red-600" role="alert">{loadError}</p>}

      {/* 卡头固定：说明 + 添加渠道 */}
      <div className="mb-4 flex items-start justify-between gap-4 rounded-xl border border-line-muted bg-surface-muted px-4 py-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">渠道管理</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            渠道是模型接入层（接口地址 + 协议），由平台统一维护；用户在 设置→模型配置 里选择渠道并填自己的
            API Key 接入模型（BYOK）。这里不配置具体模型——渠道下平台侧托管条目仅供管理员助手使用。
          </p>
        </div>
        <Button className="shrink-0" onClick={() => setDialog(emptyDraft())}>添加渠道</Button>
      </div>

      {/* 渠道卡片网格 */}
      {channels === null ? (
        <p className="py-8 text-center text-sm text-muted-foreground">正在加载渠道…</p>
      ) : channels.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">还没有渠道。点击「添加渠道」接入第一个供应商。</p>
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {channels.map((channel) => (
            <div key={channel.id} className="flex flex-col rounded-xl border border-line-muted bg-surface-muted px-4 py-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold">{channel.displayName}</p>
                  <p className="mt-0.5 truncate text-xs text-muted-foreground" title={channel.id}>{channel.id}</p>
                </div>
                <div className="flex shrink-0 items-center gap-0.5">
                  <IconButton
                    variant="ghost" size="sm" label={`编辑 ${channel.displayName}`}
                    onClick={() => setDialog({ editId: channel.id, id: channel.id, displayName: channel.displayName === channel.id ? "" : channel.displayName, baseUrl: channel.baseUrl, clientType: channel.clientType })}
                  >
                    <GlyphIcon d={ICONS.pencil} size={ICON_SIZE.iconButton} />
                  </IconButton>
                  <IconButton variant="ghost" size="sm" label={`删除 ${channel.displayName}`} disabled={busy} onClick={() => void remove(channel)}>
                    <GlyphIcon d={ICONS.trash} size={ICON_SIZE.iconButton} />
                  </IconButton>
                </div>
              </div>
              <dl className="mt-2 space-y-1 border-t border-line-muted pt-2 text-xs">
                <div className="flex gap-2"><dt className="shrink-0 text-muted-foreground">接口地址</dt><dd className="min-w-0 truncate">{channel.baseUrl || "（渠道默认地址）"}</dd></div>
                <div className="flex gap-2"><dt className="shrink-0 text-muted-foreground">协议</dt><dd>{clientTypeLabel(channel.clientType)}</dd></div>
                <div className="flex gap-2"><dt className="shrink-0 text-muted-foreground">托管条目</dt><dd>{channel.models} 个{channel.models === 0 ? "（纯渠道）" : ""}</dd></div>
              </dl>
            </div>
          ))}
        </div>
      )}

      {dialog !== null && (
        <Modal open title={dialog.editId === null ? "添加渠道" : "编辑渠道"} onClose={() => setDialog(null)} widthClass="sm:max-w-lg">
          <div className="flex flex-col gap-4">
            <label className="flex flex-col gap-1.5 text-sm">
              <span className="font-medium">渠道标识</span>
              <input
                type="text"
                className="w-full rounded-md border border-line-muted bg-transparent px-3 py-2 text-sm"
                placeholder="例如 my-gateway（字母开头，可含数字、-、_）"
                value={dialog.id}
                readOnly={dialog.editId !== null}
                onChange={(event) => setDialog({ ...dialog, id: event.target.value })}
              />
              {dialog.editId !== null && <span className="text-xs text-muted-foreground">标识是存储键，编辑时不可修改。</span>}
            </label>
            <label className="flex flex-col gap-1.5 text-sm">
              <span className="font-medium">显示名称</span>
              <input
                type="text"
                className="w-full rounded-md border border-line-muted bg-transparent px-3 py-2 text-sm"
                placeholder="例如 企业统一网关"
                value={dialog.displayName}
                onChange={(event) => setDialog({ ...dialog, displayName: event.target.value })}
              />
            </label>
            <label className="flex flex-col gap-1.5 text-sm">
              <span className="font-medium">接口地址</span>
              <input
                type="text"
                className="w-full rounded-md border border-line-muted bg-transparent px-3 py-2 text-sm"
                placeholder="https://api.example.com/v1（留空使用该渠道默认地址）"
                value={dialog.baseUrl}
                onChange={(event) => setDialog({ ...dialog, baseUrl: event.target.value })}
              />
            </label>
            <label className="flex flex-col gap-1.5 text-sm">
              <span className="font-medium">协议</span>
              <Select value={dialog.clientType} onChange={(event) => setDialog({ ...dialog, clientType: event.target.value })} aria-label="协议">
                {CLIENT_TYPES.map((item) => (<option key={item.value} value={item.value}>{item.label}</option>))}
              </Select>
            </label>
            <p className="text-xs text-muted-foreground">渠道不保存 API Key：每个用户在模型配置里填自己的密钥（BYOK）。</p>
          </div>
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setDialog(null)}>取消</Button>
            <Button disabled={busy || !dialog.id.trim()} onClick={() => void save()}>{busy ? "保存中…" : "保存"}</Button>
          </div>
        </Modal>
      )}
    </div>
  );
}
