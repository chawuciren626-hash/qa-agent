/**
 * 建档抽屉：把「程序在建档」这件事摊开给人看。
 *
 * 三个态共用同一个容器——建档中 / 已建档 / 建档失败。进度条和五个步骤的数字全部
 * 来自服务端 `environment.steps`（Python 的 `@@step` 上报），前端不做任何按时间
 * 推算的补间动画：按时间推的进度会在第 3 步抓 12 个 bundle 时冲到 80% 然后停住，
 * 比不显示更误导。
 *
 * 诚实边界：失败时页面数显示「—」，不显示 0（0 会被读成"扫过了确实没有页面"）；
 * 没跑过的步骤写「等待」，不写「已完成」。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { EnvironmentView, ManagedProject } from "./types";
import { bootstrapEnvironment, getEnvironment } from "./api";
import { fullTimeText } from "./format";
import { StepBar, StepRows, stepProgress } from "./bootstrap-steps";
import { toastError } from "@prismshadow/penguin-ui";

/** 建档期间轮询间隔：单步最慢的是抓 bundle（十几秒），1.2s 足够跟上又不吵。 */
const POLL_MS = 1200;

const CAPTCHA_LABEL: Record<string, string> = {
  none: "无验证码",
  image: "图形验证码",
  slider: "滑块",
  click_select: "点选",
  sms: "短信",
  unknown: "未识别",
};

export function BootstrapDrawer({
  project,
  onClose,
  onChanged,
}: {
  project: ManagedProject;
  onClose: () => void;
  /** 建档状态变化后通知列表刷新（关掉抽屉后列表上的字也得跟着变）。 */
  onChanged: () => void;
}) {
  const [environment, setEnvironment] = useState<EnvironmentView | null>(project.environment ?? null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  /** 上一次看到的状态：从 probing 走出去的那一刻才通知列表，避免每轮都刷。 */
  const wasProbingRef = useRef(environment?.status === "probing");

  const env = environment?.env ?? project.environment?.env ?? "test";

  const pull = useCallback(async () => {
    try {
      const next = await getEnvironment(project.projectId, env);
      setEnvironment(next);
      setLoadError(null);
      if (wasProbingRef.current && next.status !== "probing") {
        wasProbingRef.current = false;
        onChanged();
      }
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "环境状态读取失败");
    }
  }, [env, onChanged, project.projectId]);

  /* 一进来先取一次最新值：列表里的数据可能是几秒前的快照。 */
  useEffect(() => {
    void pull();
  }, [pull]);

  /* 只在 probing 时轮询；结束就不再留定时器（浏览器后台标签页也能自己停）。 */
  useEffect(() => {
    if (environment?.status !== "probing") return;
    const timer = setTimeout(() => void pull(), POLL_MS);
    return () => clearTimeout(timer);
  }, [environment, pull]);

  /* Esc 关闭；打开时焦点进关闭按钮，关闭后回到触发处。 */
  useEffect(() => {
    restoreFocusRef.current = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      restoreFocusRef.current?.focus?.();
    };
  }, [onClose]);

  const restart = async () => {
    setStarting(true);
    try {
      const next = await bootstrapEnvironment(project.projectId, env);
      wasProbingRef.current = true;
      setEnvironment(next);
      setLoadError(null);
      onChanged();
    } catch (e) {
      toastError(e instanceof Error ? e.message : "发起建档失败，请重试");
    } finally {
      setStarting(false);
    }
  };

  const status = environment?.status ?? "unregistered";
  const steps = environment?.steps ?? [];
  const { settled, percent } = stepProgress(steps);
  const title = status === "probing" ? "项目环境 · 建档中"
    : status === "registered" ? "项目环境 · 已建档"
      : status === "failed" ? "项目环境 · 建档失败" : "项目环境 · 未建档";
  const dotClass = status === "probing" ? "is-run" : status === "registered" ? "is-ok" : status === "failed" ? "is-fail" : "";

  return createPortal(
    <div className="qpm-panel-root" role="presentation">
      <aside className="qpm-panel" role="dialog" aria-label={`${title}：${project.name}`}>
        <header className="qpm-panel-head">
          <div className="qpm-panel-title">
            <div>
              <h2><i className={`qpm-env-dot ${dotClass}`} aria-hidden="true" /> {title}</h2>
              <div className="qpm-panel-tags">
                <span>{project.name}</span>
                <span className="qpm-mono qpm-env-url">{environment?.baseUrl ?? project.environment?.baseUrl ?? "—"}</span>
              </div>
            </div>
          </div>
          <button type="button" className="qpm-icon-btn" ref={closeRef} aria-label="关闭建档面板" onClick={onClose}>
            <span aria-hidden="true">✕</span>
          </button>
        </header>

        <div className="qpm-panel-body">
          {loadError && (
            <div className="qpm-error" role="alert">
              <p>{loadError}</p>
              <button type="button" className="qpm-btn-ghost" onClick={() => void pull()}>重试</button>
            </div>
          )}

          {status === "probing" && (
            <p className="qpm-panel-note">
              <b>这是程序在跑，不是模型在点。</b>五步全部由确定性工具执行，零模型调用——所以耗时和数字可以复现、可以写进报告。
              这一步也不开会话：没有需要模型判断的地方。
            </p>
          )}

          {status === "failed" && environment?.lastError && (
            <div className="qpm-env-error" role="alert">
              <b>失败原因（程序原文）</b>
              <p className="qpm-mono">{environment.lastError}</p>
            </div>
          )}

          <section aria-label="建档进度">
            <h3>
              建档进度
              <span className="qpm-count">{steps.length === 0 ? "—" : `${settled}/${steps.length} · ${percent}%`}</span>
            </h3>
            <StepBar steps={steps} failed={status === "failed"} />
            <StepRows steps={steps} />
          </section>

          {status === "registered" && environment && (
            <>
              <section aria-label="建档结果">
                <h3>建档结果<span className="qpm-count">{fullTimeText(environment.probedAt)}</span></h3>
                <div className="qpm-facts">
                  <div className="qpm-fact">
                    <b>{environment.pages === null ? "—" : environment.pages.total}<small> 页</small></b>
                    <span>已登记页面</span>
                  </div>
                  <div className="qpm-fact">
                    <b>{environment.apis === null ? "—" : environment.apis.total}<small> 个</small></b>
                    <span>
                      接口
                      {environment.apis !== null && environment.apis.modules.length > 0
                        ? ` / ${environment.apis.modules.length} 模块` : ""}
                    </span>
                  </div>
                  <div className="qpm-fact">
                    <b>{environment.loginCaptcha ? CAPTCHA_LABEL[environment.loginCaptcha] ?? environment.loginCaptcha : "—"}</b>
                    <span>登录验证</span>
                  </div>
                </div>
                {environment.apis !== null && environment.apis.modules.length > 0 && (
                  <p className="qpm-panel-note">接口模块：{environment.apis.modules.join("、")}</p>
                )}
                <dl className="qpm-kv">
                  <dt>页面地图</dt>
                  <dd className="qpm-mono">{environment.mapsPath ?? "—"}</dd>
                  <dt>建档报告</dt>
                  <dd className="qpm-mono">{environment.reportPath ?? "—"}</dd>
                </dl>
              </section>

              <p className="qpm-panel-note">
                <b>建档只回答「有哪些地址」。</b>模块职责、前置条件、怎么点才走得到，需要探索来补——
                建档完不会自动跑探索，探索以会话发起（批次 3 接通派发）。
              </p>
            </>
          )}

          {status === "failed" && (
            <p className="qpm-panel-note">
              <b>页面数显示「—」，不是 0。</b>0 会被读成"扫过了，确实没有页面"；没跑过就是没跑过，界面不替程序猜。
            </p>
          )}
        </div>

        <footer className="qpm-panel-foot">
          <button type="button" className="qpm-btn-ghost" onClick={onClose}>
            {status === "probing" ? "后台运行" : "关闭"}
          </button>
          <div className="qpm-panel-foot-right">
            {status !== "probing" && (
              <button type="button" className="qpm-btn-main" disabled={starting} onClick={() => void restart()}>
                {starting ? "发起中…" : status === "registered" ? "重新建档" : "建档"}
              </button>
            )}
          </div>
        </footer>
      </aside>
    </div>,
    document.body,
  );
}
