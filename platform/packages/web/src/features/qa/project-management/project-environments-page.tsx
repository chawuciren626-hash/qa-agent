/**
 * 项目环境页（项目内左侧导航的一级页，不在「项目视图」那排 tab 之下）。
 *
 * 三件事分工要清楚，别混：
 *   建档   maps/<env>/   有哪些地址      —— 确定性脚本，零模型，三步门禁都过了
 *   探索   kb/<env>/     地址怎么走通    —— 开浏览器跑，有 run 有会话（批次 3 派发）
 *   假设                 探不到的为什么  —— 人提，下一轮由程序验证
 *
 * 所以本页在"没探索过"时只显示建档结果与一句实话（建档不回答流程问题），
 * 不把空地图画成"0 个模块"——0 会被读成"探过了，确实没有模块"。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { useProject, projectDisplayName } from "../../../state/project";
import type {
  EnvironmentKnowledge,
  EnvironmentView,
  Hypothesis,
  HypothesisSummary,
  KnowledgeLayer,
  WhyUnknown,
} from "./types";
import {
  bootstrapEnvironment,
  createHypothesis,
  getEnvironment,
  getEnvironmentKnowledge,
  listEnvironments,
  listHypotheses,
  saveEnvironment,
} from "./api";
import { fullTimeText } from "./format";
import { StepBar, StepRows, stepProgress } from "./bootstrap-steps";
import { toastError, toastSuccess } from "@prismshadow/penguin-ui";
import "./project-management.css";

const POLL_MS = 1200;

const LAYER_LABEL: Record<KnowledgeLayer, string> = {
  module: "模块",
  flow: "链路",
  wall: "墙点",
  interface: "接口",
};

const LAYER_HINT: Record<KnowledgeLayer, string> = {
  module: "有哪些功能区，进来先看哪一屏",
  flow: "一条业务怎么走通，前置条件是什么",
  wall: "走不通的地方：验证码、审批、灰度开关",
  interface: "页面背后调了哪些接口，参数边界在哪",
};

const WHY_LABEL: Record<WhyUnknown, string> = {
  business: "业务规则，页面上看不出来",
  data: "缺前置数据（如已支付订单）",
  role: "缺角色/账号权限",
  async: "异步结果，短时间看不到",
  external: "外部系统，本环境不可达",
};

const STATUS_LABEL: Record<Hypothesis["status"], string> = {
  open: "待验证",
  verified: "已验证",
  refuted: "已推翻",
  unreachable: "无法验证",
};

const CAPTCHA_LABEL: Record<string, string> = {
  none: "无验证码",
  image: "图形验证码",
  slider: "滑块",
  click_select: "点选",
  sms: "短信",
  unknown: "未识别",
};

function envStatusText(env: EnvironmentView): string {
  if (env.status === "probing") return "建档中";
  if (env.status === "registered") return "已建档";
  if (env.status === "failed") return "建档失败";
  return "未建档";
}

function envDotClass(env: EnvironmentView): string {
  if (env.status === "probing") return "is-run";
  if (env.status === "registered") return "is-ok";
  if (env.status === "failed") return "is-fail";
  return "";
}

export function ProjectEnvironmentsPage() {
  const navigate = useNavigate();
  const { currentProject } = useProject();
  const projectId = currentProject?.projectId ?? null;

  const [environments, setEnvironments] = useState<EnvironmentView[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tab, setTab] = useState<"archive" | "hypotheses">("archive");
  const [knowledge, setKnowledge] = useState<EnvironmentKnowledge | null>(null);
  const [hypotheses, setHypotheses] = useState<Hypothesis[]>([]);
  const [summary, setSummary] = useState<HypothesisSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [addingOpen, setAddingOpen] = useState(false);
  const [hypothesisOpen, setHypothesisOpen] = useState(false);

  const current = useMemo(
    () => environments.find((env) => env.env === selected) ?? environments[0] ?? null,
    [environments, selected],
  );

  const loadEnvironments = useCallback(async () => {
    if (!projectId) return;
    try {
      const result = await listEnvironments(projectId);
      setEnvironments(result.environments);
      setLoadError(null);
      setSelected((prev) => prev ?? result.defaultEnv ?? result.environments[0]?.env ?? null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "环境列表加载失败");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    setLoading(true);
    void loadEnvironments();
  }, [loadEnvironments]);

  /* 建档期间轮询：环境行自己往前走，用户不用手动刷新。 */
  useEffect(() => {
    if (!current || current.status !== "probing" || !projectId) return;
    const timer = setTimeout(() => {
      void getEnvironment(projectId, current.env)
        .then((next) => {
          setEnvironments((prev) => prev.map((env) => (env.env === next.env ? next : env)));
        })
        .catch(() => undefined);
    }, POLL_MS);
    return () => clearTimeout(timer);
  }, [current, projectId]);

  /* 探索资产 + 假设：切环境或切 tab 时按需取（一次请求拿全，避免首屏错帧）。 */
  useEffect(() => {
    if (!projectId || !current) return;
    let alive = true;
    void getEnvironmentKnowledge(projectId, current.env)
      .then((result) => {
        if (!alive) return;
        setKnowledge(result.knowledge);
        setSummary(result.hypotheses);
      })
      .catch(() => { if (alive) { setKnowledge(null); setSummary(null); } });
    void listHypotheses(projectId, current.env)
      .then((result) => {
        if (!alive) return;
        setHypotheses(result.hypotheses);
        setSummary(result.summary);
      })
      .catch(() => { if (alive) setHypotheses([]); });
    return () => { alive = false; };
  }, [projectId, current]);

  const startBootstrap = async () => {
    if (!projectId || !current) return;
    setBusy(true);
    try {
      const next = await bootstrapEnvironment(projectId, current.env);
      setEnvironments((prev) => prev.map((env) => (env.env === next.env ? next : env)));
    } catch (e) {
      toastError(e instanceof Error ? e.message : "发起建档失败，请重试");
    } finally {
      setBusy(false);
    }
  };

  if (!projectId) {
    return (
      <main className="qpm-page">
        <div className="qpm-scroll">
          <div className="qpm-empty-card">
            <p className="qpm-empty-title">还没有进入项目</p>
            <p className="qpm-empty-sub">项目环境按项目隔离，先进一个项目再看这里。</p>
            <button type="button" className="qpm-btn-main" onClick={() => navigate("/qa/projects")}>去项目管理</button>
          </div>
        </div>
      </main>
    );
  }

  const steps = current?.steps ?? [];
  const { settled, percent } = stepProgress(steps);

  return (
    <main className="qpm-page qpm-env-page" aria-label="项目环境">
      <div className="qpm-scroll">
        <header className="qpm-head">
          <div>
            <h1>项目环境</h1>
            <p>{currentProject ? projectDisplayName(currentProject) : "—"} · 地址归环境，一个项目可以有多个环境</p>
          </div>
          <div className="qpm-head-actions">
            <button type="button" className="qpm-btn-ghost" onClick={() => setAddingOpen(true)}>＋ 添加环境</button>
          </div>
        </header>

        {loadError && (
          <div className="qpm-error" role="alert">
            <p>{loadError}</p>
            <button type="button" className="qpm-btn-ghost" onClick={() => void loadEnvironments()}>重试</button>
          </div>
        )}

        {!loading && environments.length === 0 && (
          <div className="qpm-empty-card">
            <p className="qpm-empty-title">这个项目还没连环境</p>
            <p className="qpm-empty-sub">填一个地址就能建档：抓页面与接口，产出 maps/&lt;env&gt;/。建档零模型调用，不消耗额度。</p>
            <button type="button" className="qpm-btn-main" onClick={() => setAddingOpen(true)}>＋ 添加环境</button>
          </div>
        )}

        {environments.length > 0 && (
          <div className="qpm-env-layout">
            <ul className="qpm-env-list" aria-label="环境列表">
              {environments.map((env) => (
                <li key={env.env}>
                  <button
                    type="button"
                    className={`qpm-env-item${env.env === current?.env ? " is-active" : ""}`}
                    onClick={() => setSelected(env.env)}
                    aria-pressed={env.env === current?.env}
                  >
                    <span className="qpm-env-item-top">
                      <i className={`qpm-env-dot ${envDotClass(env)}`} aria-hidden="true" />
                      <b>{env.env}</b>
                      {env.isDefault && <span className="qpm-tag qpm-tag-manual">默认</span>}
                      <span className="qpm-env-item-status">{envStatusText(env)}</span>
                    </span>
                    <span className="qpm-env-item-url qpm-mono">{env.baseUrl}</span>
                    <span className="qpm-env-item-meta">
                      {env.pages === null ? "页面 —" : `页面 ${env.pages.total}/${env.pages.registered} 已登记`}
                      {" · "}
                      {env.apis === null ? "接口 —" : `接口 ${env.apis.total}`}
                    </span>
                  </button>
                </li>
              ))}
            </ul>

            <section className="qpm-env-detail" aria-label="环境档案">
              {current && (
                <>
                  <div className="qpm-env-detail-head">
                    <div className="qpm-env-detail-title">
                      <h2>
                        <i className={`qpm-env-dot ${envDotClass(current)}`} aria-hidden="true" />
                        {current.env} · {envStatusText(current)}
                      </h2>
                      <span className="qpm-env-url qpm-mono">{current.baseUrl}</span>
                      {current.probedAt && (
                        <span className="qpm-count">最近建档 {fullTimeText(current.probedAt)}</span>
                      )}
                    </div>
                    <div className="qpm-env-detail-acts">
                      <button
                        type="button"
                        className={current.status === "registered" ? "qpm-btn-ghost" : "qpm-btn-main"}
                        disabled={busy || current.status === "probing"}
                        onClick={() => void startBootstrap()}
                      >
                        {current.status === "probing" ? "建档中…" : current.status === "registered" ? "重新建档" : "开始建档"}
                      </button>
                    </div>
                  </div>

                  {current.status === "failed" && current.lastError && (
                    <div className="qpm-env-error" role="alert">
                      <b>失败原因（程序原文）</b>
                      <p className="qpm-mono">{current.lastError}</p>
                    </div>
                  )}

                  {(current.status === "probing" || steps.some((step) => step.status !== "idle")) && (
                    <div className="qpm-env-steps-box">
                      <h3>
                        建档进度
                        <span className="qpm-count">{steps.length === 0 ? "—" : `${settled}/${steps.length} · ${percent}%`}</span>
                      </h3>
                      <StepBar steps={steps} failed={current.status === "failed"} />
                      <StepRows steps={steps} />
                    </div>
                  )}

                  {current.status === "registered" && (
                    <div className="qpm-facts">
                      <div className="qpm-fact">
                        <b>{current.pages === null ? "—" : current.pages.total}<small> 页</small></b>
                        <span>已登记页面</span>
                      </div>
                      <div className="qpm-fact">
                        <b>{current.apis === null ? "—" : current.apis.total}<small> 个</small></b>
                        <span>
                          接口
                          {current.apis !== null && current.apis.modules.length > 0 ? ` / ${current.apis.modules.length} 模块` : ""}
                        </span>
                      </div>
                      <div className="qpm-fact">
                        <b>{current.loginCaptcha ? CAPTCHA_LABEL[current.loginCaptcha] ?? current.loginCaptcha : "—"}</b>
                        <span>登录验证</span>
                      </div>
                    </div>
                  )}

                  <div className="qpm-tabs" role="tablist" aria-label="环境档案分区">
                    <button
                      type="button"
                      role="tab"
                      aria-selected={tab === "archive"}
                      className={`qpm-tab${tab === "archive" ? " is-active" : ""}`}
                      onClick={() => setTab("archive")}
                    >
                      探索资产
                    </button>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={tab === "hypotheses"}
                      className={`qpm-tab${tab === "hypotheses" ? " is-active" : ""}`}
                      onClick={() => setTab("hypotheses")}
                    >
                      未知与假设{summary && summary.open > 0 ? ` · ${summary.open}` : ""}
                    </button>
                  </div>

                  {tab === "archive" && (
                    <div className="qpm-tab-body">
                      {!knowledge || knowledge.lastRound === 0 ? (
                        <div className="qpm-empty-card qpm-empty-inline">
                          <p className="qpm-empty-title">这个环境还没探索过</p>
                          <p className="qpm-empty-sub">
                            建档只回答「有哪些地址」。模块职责、前置条件、怎么点才走得到，只有探索能给——
                            探索以会话发起，派发入口在批次 3 接通。探不到的业务常识（例如"退款要先有已支付订单"）
                            请到「未知与假设」里写下来，下一轮探索会带着它去验。
                          </p>
                        </div>
                      ) : (
                        <div className="qpm-layers">
                          {(Object.keys(LAYER_LABEL) as KnowledgeLayer[]).map((layer) => (
                            <section key={layer} className="qpm-layer" aria-label={LAYER_LABEL[layer]}>
                              <h4>
                                {LAYER_LABEL[layer]}
                                <span className="qpm-count">{knowledge.counts[layer] ?? 0}</span>
                              </h4>
                              <p className="qpm-panel-note">{LAYER_HINT[layer]}</p>
                              {(knowledge.layers[layer] ?? []).length === 0 ? (
                                <p className="qpm-muted">这一层暂时没有条目（第 {knowledge.lastRound} 轮探索没探到）。</p>
                              ) : (
                                <ul className="qpm-layer-list">
                                  {(knowledge.layers[layer] ?? []).map((entry) => (
                                    <li key={entry.key}>
                                      <div className="qpm-layer-key qpm-mono">{entry.key}</div>
                                      <div className="qpm-layer-summary">{entry.summary ?? "—"}</div>
                                      <div className="qpm-layer-meta">第 {entry.round} 轮 · {fullTimeText(entry.updatedAt)}</div>
                                    </li>
                                  ))}
                                </ul>
                              )}
                            </section>
                          ))}
                        </div>
                      )}
                    </div>
                  )}

                  {tab === "hypotheses" && (
                    <div className="qpm-tab-body">
                      <div className="qpm-hyp-head">
                        <div className="qpm-hyp-summary">
                          {summary === null ? (
                            <span className="qpm-muted">—</span>
                          ) : (
                            <>
                              <span>待验证 <b>{summary.open}</b></span>
                              <span>已验证 <b>{summary.verified}</b></span>
                              <span>已推翻 <b>{summary.refuted}</b>
                              </span>
                              <span>无法验证 <b>{summary.unreachable}</b></span>
                            </>
                          )}
                        </div>
                        <button type="button" className="qpm-btn-main" onClick={() => setHypothesisOpen(true)}>
                          ＋ 补充场景
                        </button>
                      </div>

                      <p className="qpm-panel-note">
                        假设是「探不到的为什么」。它不进探索资产——那里只放程序验证过的结论，
                        混在一起就分不清「看到过」和「猜的」。判定是追加的，被推翻的旧结论仍然可读。
                      </p>

                      {hypotheses.length === 0 ? (
                        <div className="qpm-empty-card qpm-empty-inline">
                          <p className="qpm-empty-title">还没有待验证的假设</p>
                          <p className="qpm-empty-sub">
                            典型例子：探索走到「退款申请」会被拦住，因为它要求先有一笔已支付订单——
                            这是业务常识，页面上看不出来。把它写成一条假设，下一轮探索就会带着前置数据去验。
                          </p>
                        </div>
                      ) : (
                        <ul className="qpm-hyp-list">
                          {hypotheses.map((item) => (
                            <li key={item.hypothesisId} className={`qpm-hyp is-${item.status}`}>
                              <div className="qpm-hyp-top">
                                <span className={`qpm-tag qpm-hyp-status is-${item.status}`}>{STATUS_LABEL[item.status]}</span>
                                {item.moduleKey && <span className="qpm-mono qpm-muted">{item.moduleKey}</span>}
                                <span className="qpm-hyp-why">{WHY_LABEL[item.whyUnknown]}</span>
                                {item.allowSeed && <span className="qpm-tag qpm-tag-sync">已授权造数</span>}
                              </div>
                              <p className="qpm-hyp-statement">{item.statement}</p>
                              {item.expectation && <p className="qpm-hyp-sub">期望：{item.expectation}</p>}
                              {item.dataSetup && <p className="qpm-hyp-sub">前置数据：{item.dataSetup}</p>}
                              {item.verdicts.length > 0 && (
                                <ul className="qpm-verdicts">
                                  {item.verdicts.map((verdict) => (
                                    <li key={verdict.verdictId}>
                                      第 {verdict.round} 轮 · {STATUS_LABEL[verdict.verdict]}
                                      {verdict.evidence ? ` · ${verdict.evidence}` : ""}
                                    </li>
                                  ))}
                                </ul>
                              )}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}
                </>
              )}
            </section>
          </div>
        )}
      </div>

      {addingOpen && projectId && (
        <EnvironmentDialog
          projectId={projectId}
          onClose={() => setAddingOpen(false)}
          onSaved={(env) => {
            setAddingOpen(false);
            setSelected(env.env);
            void loadEnvironments();
          }}
        />
      )}

      {hypothesisOpen && projectId && current && (
        <HypothesisDialog
          projectId={projectId}
          env={current.env}
          onClose={() => setHypothesisOpen(false)}
          onSaved={(created) => {
            setHypothesisOpen(false);
            setHypotheses((prev) => [created, ...prev]);
            setSummary((prev) => prev === null ? prev : { ...prev, open: prev.open + 1, total: prev.total + 1 });
            toastSuccess("假设已记录，下一轮探索会带着它去验");
          }}
        />
      )}
    </main>
  );
}

/** 添加/修正环境地址：地址校验在服务端（只放行 http/https，拦云元数据端点）。 */
function EnvironmentDialog({
  projectId,
  onClose,
  onSaved,
}: {
  projectId: string;
  onClose: () => void;
  onSaved: (environment: EnvironmentView) => void;
}) {
  const [env, setEnv] = useState("test");
  const [baseUrl, setBaseUrl] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!baseUrl.trim()) {
      setError("请填环境地址，例如 http://10.20.31.14:8080");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const saved = await saveEnvironment(projectId, { env: env.trim() || "test", baseUrl: baseUrl.trim() });
      onSaved(saved);
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存失败，请重试");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="qpm-modal-mask" role="presentation" onClick={(e) => { if (e.target === e.currentTarget && !saving) onClose(); }}>
      <div className="qpm-modal" role="dialog" aria-modal="true" aria-label="添加环境">
        <div className="qpm-modal-head">
          <h2>添加环境</h2>
          <button type="button" className="qpm-icon-btn" aria-label="关闭" onClick={onClose} disabled={saving}>✕</button>
        </div>
        <div className="qpm-modal-body">
          <label className="qpm-form-row">
            <span>环境标识</span>
            <input value={env} maxLength={32} onChange={(e) => setEnv(e.target.value)} placeholder="test" />
            <span className="qpm-field-hint">小写字母开头，只含小写字母、数字、下划线或连字符，例如 test / staging。</span>
          </label>
          <label className="qpm-form-row">
            <span>环境地址 <em aria-hidden="true">*</em></span>
            <input
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="http://10.20.31.14:8080"
              className="font-mono"
              spellCheck={false}
            />
            <span className="qpm-field-hint">只支持 http / https；地址里不要带账号口令。改地址会清空旧建档摘要。</span>
          </label>
          {error && <p className="qpm-field-error" role="alert">{error}</p>}
        </div>
        <div className="qpm-modal-foot">
          <button type="button" className="qpm-btn-ghost" onClick={onClose} disabled={saving}>取消</button>
          <button type="button" className="qpm-btn-main" onClick={() => void submit()} disabled={saving}>
            {saving ? "保存中…" : "保存"}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * 补充场景（人提假设）：只收「可判定的一句话」。
 *
 * 造数开关默认关：这是会真写被测系统的动作，必须逐条显式放开，且在探索白名单内。
 */
function HypothesisDialog({
  projectId,
  env,
  onClose,
  onSaved,
}: {
  projectId: string;
  env: string;
  onClose: () => void;
  onSaved: (hypothesis: Hypothesis) => void;
}) {
  const [statement, setStatement] = useState("");
  const [whyUnknown, setWhyUnknown] = useState<WhyUnknown>("business");
  const [moduleKey, setModuleKey] = useState("");
  const [expectation, setExpectation] = useState("");
  const [dataSetup, setDataSetup] = useState("");
  const [allowSeed, setAllowSeed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (statement.trim().length < 4) {
      setError("写成一句能被判定真假的话，例如「退款申请要求存在已支付订单」");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const created = await createHypothesis(projectId, env, {
        statement: statement.trim(),
        whyUnknown,
        moduleKey: moduleKey.trim() || undefined,
        expectation: expectation.trim() || undefined,
        dataSetup: dataSetup.trim() || undefined,
        allowSeed,
      });
      onSaved(created);
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存失败，请重试");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="qpm-modal-mask" role="presentation" onClick={(e) => { if (e.target === e.currentTarget && !saving) onClose(); }}>
      <div className="qpm-modal" role="dialog" aria-modal="true" aria-label="补充场景假设">
        <div className="qpm-modal-head">
          <h2>补充场景</h2>
          <button type="button" className="qpm-icon-btn" aria-label="关闭" onClick={onClose} disabled={saving}>✕</button>
        </div>
        <div className="qpm-modal-body">
          <label className="qpm-form-row">
            <span>假设内容 <em aria-hidden="true">*</em></span>
            <textarea
              value={statement}
              rows={3}
              maxLength={500}
              onChange={(e) => setStatement(e.target.value)}
              placeholder="退款申请要求存在已支付订单"
            />
            <span className="qpm-field-hint">要能被判定真假。「流程比较复杂」不能判定，「提交时会二次校验库存」可以。</span>
          </label>
          <label className="qpm-form-row">
            <span>为什么探索探不到</span>
            <select value={whyUnknown} onChange={(e) => setWhyUnknown(e.target.value as WhyUnknown)}>
              {(Object.keys(WHY_LABEL) as WhyUnknown[]).map((key) => (
                <option key={key} value={key}>{WHY_LABEL[key]}</option>
              ))}
            </select>
          </label>
          <label className="qpm-form-row">
            <span>关联模块（选填）</span>
            <input value={moduleKey} maxLength={64} onChange={(e) => setModuleKey(e.target.value)} placeholder="refund" className="font-mono" />
          </label>
          <label className="qpm-form-row">
            <span>期望看到什么（选填）</span>
            <input value={expectation} maxLength={1000} onChange={(e) => setExpectation(e.target.value)} placeholder="无已支付订单时，申请按钮禁用并提示" />
          </label>
          <label className="qpm-form-row">
            <span>前置数据（选填）</span>
            <input value={dataSetup} maxLength={500} onChange={(e) => setDataSetup(e.target.value)} placeholder="一个已支付订单，金额 100 元" />
          </label>
          <label className="qpm-form-row qpm-check-row">
            <span>
              <input type="checkbox" checked={allowSeed} onChange={(e) => setAllowSeed(e.target.checked)} />
              {" "}允许探索时自动造前置数据
            </span>
            <span className="qpm-field-hint">
              默认关闭。打开后探索会真写被测系统的数据（下单/支付），只能在这个环境、这条假设、且在动作白名单内执行。
            </span>
          </label>
          {error && <p className="qpm-field-error" role="alert">{error}</p>}
        </div>
        <div className="qpm-modal-foot">
          <button type="button" className="qpm-btn-ghost" onClick={onClose} disabled={saving}>取消</button>
          <button type="button" className="qpm-btn-main" onClick={() => void submit()} disabled={saving}>
            {saving ? "保存中…" : "记录假设"}
          </button>
        </div>
      </div>
    </div>
  );
}
