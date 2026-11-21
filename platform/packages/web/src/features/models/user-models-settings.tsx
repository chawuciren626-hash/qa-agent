/**
 * 设置 → 模型（WorkBuddy 式，账号中心客户端形态）。
 *
 * 两个卡片（对照 WorkBuddy 的模型设置页）：
 * 1. 自定义模型 — 模型列表（添加 / 编辑 / 删除）。保存目标不是某个项目，而是「用户全局」：
 *    服务端在写入用户名下项目模型配置时自动发布一份按用户的全局模型配置文件
 *    （<数据根>/.account-models/<用户hash>.json），并同步到该用户拥有的所有项目的
 *    .project_config.toml；新建项目也会自动继承（project-service / project-config-service
 *    的共享模型机制）。这里选取用户第一个「拥有（owner）」的项目作为写入入口，其余项目
 *    由服务端自动同步；会话页与测试任务即可直接选用。
 * 2. 辅助任务模型 — 单选下拉，写入用户偏好（ui_prefs.aux_model），不影响主对话模型。
 *
 * 「添加模型」弹窗对照 WorkBuddy：供应商（预设清单 + 自定义，仅 OpenAI 兼容协议）、
 * 接口地址、API Key + 测试连接、模型名称、高级配置（图片输入、协议、输入/输出限额）。
 * 连接信息（baseUrl / API Key / 协议）写入供应商组（[providers.<id>]），模型信息写入
 * 模型条目；一条「模型」在目录里 = 供应商组 + 该组下的一个 model_id。
 *
 * 权限：写入走项目模型 API（项目 owner 本来就有权配置），每个登录用户都可用；管理员登录
 * 客户端与普通用户完全一致，models section 对所有用户可见（见 settings-sections.ts）。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ChangeEvent, ReactNode } from "react";
import {
  Button,
  GlyphIcon,
  ICONS,
  ICON_SIZE,
  IconButton,
  Modal,
  PrefRow,
  Select,
  toastError,
  toastSuccess,
} from "@prismshadow/penguin-ui";
import * as api from "../../api/endpoints";
import type { ChannelInfo } from "../../api/endpoints";
import type { ModelInfo, ModelUpdateEntry, ModelsResponse, ProviderConnectionUpdate } from "@prismshadow/penguin-server/api";

/**
 * 供应商下拉数据源 = 平台渠道（管理后台「渠道管理」维护，GET /api/control/channels）+ 内置预设兜底。
 * 平台渠道是权威来源；非中央部署读不到时回退内置预设。自定义渠道入口始终保留（BYOK 自建网关）。
 */
const BUILTIN_PRESETS: ReadonlyArray<{ id: string; name: string; baseUrl: string }> = [
  { id: "deepseek", name: "深度求索", baseUrl: "https://api.deepseek.com/v1" },
  { id: "moonshot", name: "Kimi 中国版", baseUrl: "https://api.moonshot.cn/v1" },
  { id: "minimax", name: "MiniMax 中国版", baseUrl: "https://api.minimaxi.chat/v1" },
  { id: "zhipu", name: "智谱开放平台", baseUrl: "https://open.bigmodel.cn/api/paas/v4" },
  { id: "tokenhub", name: "腾讯云 TokenHub", baseUrl: "https://api.tokenhub.cn/v1" },
];
const CUSTOM_PROVIDER = "__custom__";

interface ProviderOption { id: string; name: string; baseUrl: string; clientType?: string }

const builtinOptions = (): ProviderOption[] => BUILTIN_PRESETS.map((p) => ({ id: p.id, name: p.name, baseUrl: p.baseUrl }));

const channelOptions = (channels: ChannelInfo[]): ProviderOption[] => channels
  .filter(channel => channel.id !== CUSTOM_PROVIDER && channel.id !== "custom")
  .map(channel => ({ id: channel.id, name: channel.displayName, baseUrl: channel.baseUrl, clientType: channel.clientType }));

/** 协议档位：空 = 跟随供应商默认（server 按端点探测）。 */
const CLIENT_TYPES: ReadonlyArray<{ value: string; label: string }> = [
  { value: "", label: "跟随供应商默认" },
  { value: "openai-chat", label: "OpenAI 兼容 (chat)" },
  { value: "openai-responses", label: "OpenAI Responses" },
  { value: "ant-messages", label: "自定义协议 (messages)" },
];

const CONTEXT_CHOICES = ["", "32000", "64000", "128000", "256000", "1000000"];
const OUTPUT_CHOICES = ["", "8000", "16000", "32000", "64000"];

const numberOrNull = (raw: string): number | undefined => {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : undefined;
};

/** 目录条目 → 全表替换请求行（凭据永不回传，省略 = 保留原值）。 */
const toUpdateEntry = (model: ModelInfo): ModelUpdateEntry => ({
  provider: model.provider,
  modelId: model.modelId,
  ...(model.displayName !== undefined ? { displayName: model.displayName } : {}),
  ...(model.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}),
  ...(model.maxTokens !== undefined ? { maxTokens: model.maxTokens } : {}),
  ...(model.vision !== undefined ? { vision: model.vision } : {}),
  ...(model.clientType !== undefined && model.clientType !== "" ? { clientType: model.clientType } : {}),
});

interface DraftState {
  editRef: { provider: string; modelId: string } | null;
  presetId: string;
  providerName: string;
  baseUrl: string;
  apiKey: string;
  modelId: string;
  displayName: string;
  vision: boolean;
  clientType: string;
  /** 编辑时目录里已存的协议（行级或组级生效值）：保存时仅在该字段变化时提交，避免意外清掉组级覆盖。 */
  originalClientType: string;
  contextWindow: string;
  maxTokens: string;
}

const emptyDraft = (options: ProviderOption[]): DraftState => ({
  editRef: null,
  presetId: options[0]?.id ?? CUSTOM_PROVIDER,
  providerName: "",
  baseUrl: options[0]?.baseUrl ?? "",
  apiKey: "",
  modelId: "",
  displayName: "",
  vision: false,
  clientType: options[0]?.clientType ?? "",
  originalClientType: "",
  contextWindow: "",
  maxTokens: "",
});

const rowLabel = (model: ModelInfo) =>
  model.displayName && model.displayName !== model.modelId ? `${model.displayName} · ${model.modelId}` : model.modelId;

export function UserModelsSettings() {
  const [response, setResponse] = useState<ModelsResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [auxModel, setAuxModel] = useState<{ provider: string; modelId: string } | null>(null);
  const [dialog, setDialog] = useState<DraftState | null>(null);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  /** 行级连通性测试进行中的行（provider\0modelId），按钮转圈并禁用。 */
  const [testingRow, setTestingRow] = useState<string | null>(null);
  /** 平台渠道目录（管理后台「渠道管理」维护）；读不到（非中央部署）为 null，回退内置预设。 */
  const [providerOptions, setProviderOptions] = useState(builtinOptions);
  const [addOpened, setAddOpened] = useState(false);
  const [openingAdd, setOpeningAdd] = useState(false);

  useEffect(() => {
    if (addOpened) return;
    let cancelled = false;
    void api.getChannels().then(
      (result) => { if (!cancelled) setProviderOptions(channelOptions(result.channels)); },
      () => {},
    );
    return () => { cancelled = true; };
  }, [addOpened]);

  /** 读取与写入都走用户级端点 /api/user-models：不依赖「有没有项目」，登录即可配置。 */
  const reload = useCallback(async () => {
    try {
      const [models, prefs] = await Promise.all([
        api.userModels.get(),
        api.getPrefs().catch(() => null),
      ]);
      setResponse(models);
      setLoadError(null);
      setAuxModel(prefs?.prefs?.aux_model ?? null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "模型配置读取失败，请稍后重试。");
    }
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  const models = useMemo(() => response?.models ?? [], [response]);
  const providerNames = useMemo(() => {
    const names = new Map<string, string>();
    for (const option of providerOptions) names.set(option.id, option.name);
    for (const [id, group] of Object.entries(response?.providers ?? {})) {
      if (group.displayName?.trim()) names.set(id, group.displayName.trim());
    }
    for (const model of models) if (!names.has(model.provider)) names.set(model.provider, model.provider);
    return names;
  }, [response, models, providerOptions]);

  const openAdd = async () => {
    setTestResult(null);
    setAddOpened(true);
    setOpeningAdd(true);
    try {
      const options = await api.getChannels().then(result => channelOptions(result.channels)).catch(() => providerOptions);
      setProviderOptions(options);
      setDialog(emptyDraft(options));
    } finally {
      setOpeningAdd(false);
    }
  };
  const openEdit = (model: ModelInfo) => {
    setTestResult(null);
    const preset = providerOptions.find((item) => item.id === model.provider);
    setDialog({
      editRef: { provider: model.provider, modelId: model.modelId },
      presetId: preset ? preset.id : CUSTOM_PROVIDER,
      providerName: model.provider,
      baseUrl: model.effective?.baseUrl ?? response?.providers?.[model.provider]?.baseUrl ?? preset?.baseUrl ?? "",
      apiKey: "",
      modelId: model.modelId,
      displayName: model.displayName ?? "",
      vision: model.vision !== false,
      clientType: model.clientType ?? "",
      originalClientType: model.clientType ?? "",
      contextWindow: model.contextWindow !== undefined ? String(model.contextWindow) : "",
      maxTokens: model.maxTokens !== undefined ? String(model.maxTokens) : "",
    });
  };

  const patchDialog = (patch: Partial<DraftState>) => setDialog((current) => current === null ? null : { ...current, ...patch });

  const pickPreset = (presetId: string) => {
    if (presetId === CUSTOM_PROVIDER) {
      patchDialog({ presetId, baseUrl: "", clientType: "", providerName: dialog?.providerName || "" });
      return;
    }
    const preset = providerOptions.find((item) => item.id === presetId);
    patchDialog({ presetId, baseUrl: preset?.baseUrl ?? "", clientType: preset?.clientType ?? "", providerName: "" });
  };

  const draftProvider = dialog === null ? "" : dialog.presetId === CUSTOM_PROVIDER ? (dialog.providerName.trim() || "custom") : dialog.presetId;

  const runTest = async () => {
    if (dialog === null) return;
    if (!dialog.modelId.trim() || (dialog.presetId === CUSTOM_PROVIDER && !dialog.baseUrl.trim())) {
      setTestResult("请先填写模型名称" + (dialog.presetId === CUSTOM_PROVIDER ? "和接口地址。" : "。"));
      return;
    }
    setTesting(true);
    setTestResult(null);
    try {
      const probeProject = (await api.listProjects()).projects.find((item) => item.role === "owner")?.projectId;
      if (probeProject === undefined) {
        setTestResult("保存后即可在会话中验证；连接测试需要至少一个项目。");
        return;
      }
      const result = await api.testModel(probeProject, {
        provider: draftProvider,
        modelId: dialog.modelId.trim(),
        ...(dialog.apiKey ? { apiKey: dialog.apiKey } : {}),
        ...(dialog.baseUrl.trim() ? { baseUrl: dialog.baseUrl.trim() } : {}),
        ...(dialog.clientType ? { clientType: dialog.clientType } : {}),
      });
      setTestResult(result.ok === false ? `连接未通过：${result.message ?? "请检查地址与密钥。"}` : "连接通过。");
    } catch (error) {
      setTestResult(error instanceof Error ? error.message : "连接测试失败。");
    } finally {
      setTesting(false);
    }
  };

  const saveDialog = async () => {
    if (dialog === null || busy) return;
    const modelId = dialog.modelId.trim();
    const baseUrl = dialog.baseUrl.trim();
    if (!modelId) return;
    if (dialog.presetId === CUSTOM_PROVIDER && !baseUrl) return;
    setBusy(true);
    try {
      const provider = draftProvider;
      const connection: ProviderConnectionUpdate = { baseUrl: baseUrl || null };
      if (dialog.apiKey) connection.apiKey = dialog.apiKey;
      // 协议仅在用户改动时提交：空值传 null 表示显式清掉组级覆盖（回到跟随供应商默认）。
      if (dialog.clientType !== dialog.originalClientType) {
        connection.clientType = dialog.clientType === "" ? null : dialog.clientType;
      }
      if (dialog.presetId === CUSTOM_PROVIDER && dialog.providerName.trim()) {
        connection.displayName = dialog.providerName.trim();
      } else if (dialog.editRef === null) {
        const channel = providerOptions.find(option => option.id === provider);
        if (channel) connection.displayName = channel.name;
      }

      const rows = models
        .filter((model) => dialog.editRef === null || !(model.provider === dialog.editRef.provider && model.modelId === dialog.editRef.modelId))
        .map(toUpdateEntry);
      rows.push({
        provider,
        modelId,
        displayName: dialog.displayName.trim() || undefined,
        contextWindow: numberOrNull(dialog.contextWindow),
        maxTokens: numberOrNull(dialog.maxTokens),
        vision: dialog.vision ? undefined : false,
        ...(dialog.editRef !== null && (dialog.editRef.provider !== provider || dialog.editRef.modelId !== modelId)
          ? { renamedFrom: dialog.editRef }
          : {}),
      });
      await api.userModels.put({
        models: rows,
        providers: { ...(response?.providers ?? {}), [provider]: connection },
      });
      setDialog(null);
      toastSuccess(dialog.editRef === null ? "模型已添加。" : "模型已更新。");
      await reload();
    } catch (error) {
      setTestResult(error instanceof Error ? error.message : "保存失败，请稍后重试。");
    } finally {
      setBusy(false);
    }
  };

  /** 行级「测试连通性」：用该行已保存的凭据（owner 项目里存的那份）发起一次真实探测，
      结果用 toast 告知；密钥明文不经过前端。 */
  const testRow = async (model: ModelInfo) => {
    const rowKey = `${model.provider}\u0000${model.modelId}`;
    if (busy || testingRow !== null) return;
    setTestingRow(rowKey);
    try {
      const probeProject = (await api.listProjects()).projects.find((item) => item.role === "owner")?.projectId;
      if (probeProject === undefined) {
        toastError("连接测试需要至少一个项目；请先创建项目后重试。");
        return;
      }
      const result = await api.testModel(probeProject, { provider: model.provider, modelId: model.modelId });
      if (result.ok === false) toastError(`连接未通过：${result.message ?? "请检查接口地址与密钥。"}`);
      else toastSuccess(`「${rowLabel(model)}」连接通过。`);
    } catch (error) {
      toastError(error instanceof Error ? error.message : "连接测试失败。");
    } finally {
      setTestingRow(null);
    }
  };

  const removeModel = async (model: ModelInfo) => {    if (busy) return;
    setBusy(true);
    try {
      const rows = models
        .filter((item) => !(item.provider === model.provider && item.modelId === model.modelId))
        .map(toUpdateEntry);
      await api.userModels.put({ models: rows });
      if (auxModel?.provider === model.provider && auxModel.modelId === model.modelId) {
        await api.putPrefs({ aux_model: null });
        setAuxModel(null);
      }
      toastSuccess("模型已删除。");
      await reload();
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "删除失败，请稍后重试。");
    } finally {
      setBusy(false);
    }
  };

  const pickAux = async (event: ChangeEvent<HTMLSelectElement>) => {
    const raw = event.target.value;
    const [provider = "", modelId = ""] = raw === "" ? ["", ""] : raw.split("\u0000");
    const next = raw === "" ? null : provider && modelId ? { provider, modelId } : null;
    setAuxModel(next);
    try {
      await api.putPrefs({ aux_model: next });
    } catch {
      setAuxModel(auxModel);
    }
  };

  const auxKey = auxModel === null ? "" : `${auxModel.provider}\u0000${auxModel.modelId}`;

  return (
    <div className="flex flex-col gap-6">
      {loadError !== null && (
        <p className="text-sm text-red-600" role="alert">{loadError}</p>
      )}

      {/* Card 1 — 自定义模型：WorkBuddy 同构（灰底圆角卡）。说明区（标题+说明+「添加模型」）与
          模型列表布局切割：卡头固定，列表在固定高度内自行滚动（overflow-y-auto），不撑高卡片、
          不影响下方「辅助任务模型」卡片。 */}
      <section className="flex flex-col rounded-xl border border-line-muted bg-surface-muted px-4 py-3">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold">自定义模型</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              模型添加后会自动写入本地模型配置文件（.account-models），并同步到你名下的所有项目的
              project_config.toml；新建项目与独立会话可直接选用（仅支持 OpenAI 兼容协议 API）。
            </p>
          </div>
          <Button className="shrink-0" disabled={openingAdd} onClick={() => void openAdd()}>添加模型</Button>
        </div>
        <div className="mt-2 min-h-0 max-h-80 overflow-y-auto rounded-lg border border-line-muted [scrollbar-width:thin]">
          <div className="divide-y divide-line-muted">
            {models.length === 0 && (
              <p className="py-6 text-center text-sm text-muted-foreground">还没有模型。点击「添加模型」接入你的第一个模型。</p>
            )}
            {models.map((model) => (
              <div key={`${model.provider}\u0000${model.modelId}`} className="flex items-center justify-between gap-3 px-2.5 py-2.5">
                <div className="flex min-w-0 items-center gap-2">
                  <GlyphIcon d={ICONS.chip} size={ICON_SIZE.iconButton} className="shrink-0 text-muted-foreground" />
                  <span className="truncate text-sm font-medium">{model.displayName?.trim() || model.modelId}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">{providerNames.get(model.provider) ?? model.provider}</span>
                </div>
                <div className="flex shrink-0 items-center gap-0.5">
                <IconButton variant="ghost" size="sm" label={`编辑 ${rowLabel(model)}`} disabled={busy} onClick={() => openEdit(model)}>
                  <GlyphIcon d={ICONS.pencil} size={ICON_SIZE.iconButton} />
                </IconButton>
                <IconButton
                  variant="ghost"
                  size="sm"
                  label={`测试连通性 ${rowLabel(model)}`}
                  disabled={busy || testingRow !== null}
                  onClick={() => void testRow(model)}
                >
                  {testingRow === `${model.provider}\u0000${model.modelId}` ? (
                    <span className="animate-spin" aria-hidden="true">
                      <GlyphIcon d={ICONS.refresh} size={ICON_SIZE.iconButton} />
                    </span>
                  ) : (
                    <GlyphIcon d={ICONS.pulse} size={ICON_SIZE.iconButton} />
                  )}
                </IconButton>
                <IconButton variant="ghost" size="sm" label={`删除 ${rowLabel(model)}`} disabled={busy} onClick={() => void removeModel(model)}>
                  <GlyphIcon d={ICONS.trash} size={ICON_SIZE.iconButton} />
                </IconButton>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Card 2 — 辅助任务模型：标题+说明，下方一行「选择模型」下拉。 */}
      <section className="rounded-xl border border-line-muted bg-surface-muted px-4 py-3">
        <h3 className="text-sm font-semibold">辅助任务模型</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          用于增强提示词、生成标题、会话摘要、记忆筛选等辅助任务，不影响主对话所用的模型。
        </p>
        <div className="mt-2 border-t border-line-muted pt-1">
          <PrefRow
            label="选择模型"
            info="用于增强提示词、生成标题、会话摘要、记忆筛选等辅助任务，不影响主对话所用的模型。"
          >
            <Select value={auxKey} onChange={(event) => void pickAux(event)} aria-label="辅助任务模型">
              <option value="">默认（推荐）</option>
              {models.map((model) => (
                <option key={`${model.provider}\u0000${model.modelId}`} value={`${model.provider}\u0000${model.modelId}`}>
                  {rowLabel(model)}
                </option>
              ))}
            </Select>
          </PrefRow>
        </div>
      </section>

      {dialog !== null && (
        <Modal open title={dialog.editRef === null ? "添加模型" : "编辑模型"} onClose={() => setDialog(null)} widthClass="sm:max-w-xl">
          <div className="flex flex-col gap-4">
            <label className="flex flex-col gap-1.5 text-sm">
              <span className="font-medium">供应商<span className="ml-1 text-xs font-normal text-muted-foreground">（平台渠道 / 自定义，仅 OpenAI 兼容协议 API，密钥自备）</span></span>
              <Select value={dialog.presetId} onChange={(event) => pickPreset(event.target.value)} aria-label="供应商">
                {providerOptions.map((option) => (
                  <option key={option.id} value={option.id}>{option.name}</option>
                ))}
                <option value={CUSTOM_PROVIDER}>自定义</option>
              </Select>
            </label>

            <label className="flex flex-col gap-1.5 text-sm">
              <span className="font-medium">接口地址</span>
              <input
                type="text"
                className="w-full rounded-md border border-line-muted bg-transparent px-3 py-2 text-sm"
                placeholder="https://api.example.com/v1/chat/completions"
                value={dialog.baseUrl}
                onChange={(event) => patchDialog({ baseUrl: event.target.value })}
              />
            </label>

            <label className="flex flex-col gap-1.5 text-sm">
              <span className="font-medium">API Key</span>
              <div className="flex items-center gap-2">
                <input
                  type="password"
                  className="min-w-0 flex-1 rounded-md border border-line-muted bg-transparent px-3 py-2 text-sm"
                  placeholder={dialog.editRef === null ? "输入你的 API Key" : "留空保留已保存的密钥"}
                  value={dialog.apiKey}
                  onChange={(event) => patchDialog({ apiKey: event.target.value })}
                />
                <Button disabled={testing} onClick={() => void runTest()}>{testing ? "测试中…" : "测试连接"}</Button>
              </div>
            </label>

            <label className="flex flex-col gap-1.5 text-sm">
              <span className="font-medium">模型名称</span>
              <input
                type="text"
                className="w-full rounded-md border border-line-muted bg-transparent px-3 py-2 text-sm"
                placeholder="输入模型参数值，例如 deepseek-chat 或 gpt-4o"
                value={dialog.modelId}
                onChange={(event) => patchDialog({ modelId: event.target.value })}
              />
            </label>

            <label className="flex flex-col gap-1.5 text-sm">
              <span className="font-medium">显示名称 <span className="text-xs font-normal text-muted-foreground">（可选）</span></span>
              <input
                type="text"
                className="w-full rounded-md border border-line-muted bg-transparent px-3 py-2 text-sm"
                placeholder="列表里展示的名字，例如 DeepSeek-V4 Pro"
                value={dialog.displayName}
                onChange={(event) => patchDialog({ displayName: event.target.value })}
              />
            </label>

            <fieldset className="rounded-md border border-line-muted p-3">
              <legend className="px-1 text-sm font-medium">高级配置</legend>
              <div className="flex flex-col gap-3 pt-2">
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={dialog.vision} onChange={(event) => patchDialog({ vision: event.target.checked })} />
                  图片输入
                </label>
                <PrefRow label="协议">
                  <Select value={dialog.clientType} onChange={(event) => patchDialog({ clientType: event.target.value })} aria-label="协议">
                    {CLIENT_TYPES.map((item) => (
                      <option key={item.value} value={item.value}>{item.label}</option>
                    ))}
                  </Select>
                </PrefRow>
                <div className="grid grid-cols-2 gap-3">
                  <label className="flex flex-col gap-1.5 text-sm">
                    <span className="font-medium">输入 <span className="text-xs font-normal text-muted-foreground">（上下文窗口）</span></span>
                    <Select value={dialog.contextWindow} onChange={(event) => patchDialog({ contextWindow: event.target.value })} aria-label="输入限额">
                      {CONTEXT_CHOICES.map((value) => (
                        <option key={value || "default"} value={value}>{value === "" ? "使用供应商默认值" : value}</option>
                      ))}
                    </Select>
                  </label>
                  <label className="flex flex-col gap-1.5 text-sm">
                    <span className="font-medium">输出</span>
                    <Select value={dialog.maxTokens} onChange={(event) => patchDialog({ maxTokens: event.target.value })} aria-label="输出限额">
                      {OUTPUT_CHOICES.map((value) => (
                        <option key={value || "default"} value={value}>{value === "" ? "使用供应商默认值" : value}</option>
                      ))}
                    </Select>
                  </label>
                </div>
              </div>
            </fieldset>

            {testResult !== null && (
              <p className={`text-sm ${testResult.startsWith("连接通过") ? "text-emerald-600" : "text-amber-600"}`} role="status">{testResult}</p>
            )}
          </div>
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setDialog(null)}>取消</Button>
            <Button disabled={busy || !dialog.modelId.trim() || (dialog.presetId === CUSTOM_PROVIDER && !dialog.baseUrl.trim())} onClick={() => void saveDialog()}>
              {busy ? "保存中…" : "保存"}
            </Button>
          </div>
        </Modal>
      )}
    </div>
  );
}
