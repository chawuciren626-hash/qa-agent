/**
 * 确定性知识工具的进程内调用桥。
 *
 * 为什么走子进程而不是在 Node 里重写一遍：条款切分、语义 diff、预算裁剪的判定规则
 * （哪些算重复、哪些只算表述变更、超预算先裁谁）都在 Python 侧，并且已经有回归覆盖。
 * 在 TS 里再写一份，两份实现迟早给出不同答案，而这类差异不会报错，只会静默地把
 * "表述变更"算成"语义变更"，触发一次没必要的全量重算。
 *
 * 失败一律抛出可读错误，不做"降级到全量灌"的兜底：上下文超预算的代价是钱和精度，
 * 假装修好了比承认没装上更糟。
 */
import { execFile } from "node:child_process";
import path from "node:path";

export type ToolRunner = (toolId: string, payload: Record<string, unknown>) => Promise<unknown>;

export interface EngineToolOptions {
  /** 仓库根（含 aitestharness-tools 与 scripts）。 */
  engineRoot: string;
  /** 注入执行器：测试用，生产走 python 子进程。 */
  run?: ToolRunner;
  timeoutMs?: number;
  /** 覆盖 python 可执行文件（AITEST_PYTHON）。 */
  python?: string;
}

const DEFAULT_TIMEOUT_MS = 20_000;

/** runtime_cli 的 JSON 信封：退出码只表达"工具层失败"，错误码在这里面。 */
interface ToolEnvelope {
  ok?: boolean;
  result?: unknown;
  error_code?: string;
  message?: string;
}

function pythonExecutable(explicit?: string): string {
  return explicit ?? process.env.AITEST_PYTHON ?? (process.platform === "win32" ? "python" : "python3");
}

export function pythonEngineToolRunner(engineRoot: string, timeoutMs = DEFAULT_TIMEOUT_MS, python?: string): ToolRunner {
  const packageRoot = path.join(engineRoot, "aitestharness-tools");
  return (toolId, payload) => new Promise((resolve, reject) => {
    const child = execFile(
      pythonExecutable(python),
      // The bundled Windows Python is isolated and ignores PYTHONPATH. Inject
      // the package root explicitly before running the module.
      ["-c", "import runpy,sys; sys.path.insert(0,sys.argv[1]); sys.argv=sys.argv[2:]; runpy.run_module('aitestharness_tools.runtime_cli',run_name='__main__')", packageRoot, "runtime_cli.py", toolId],
      {
        cwd: engineRoot,
        env: {
          ...process.env,
          PYTHONPATH: [packageRoot, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
          PYTHONUTF8: "1",
          PYTHONIOENCODING: "utf-8",
        },
        timeout: timeoutMs,
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true,
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        // 退出码非 0 不等于没结果：runtime_cli 用退出码表达"工具层失败"，
        // 真正的错误码在 stdout 的 JSON 信封里，先解析再判。
        let parsed: ToolEnvelope | null = null;
        try {
          parsed = JSON.parse(String(stdout)) as ToolEnvelope;
        } catch {
          parsed = null;
        }
        if (!parsed) {
          const why = String(stderr ?? "").trim().slice(-800);
          reject(new Error(`${toolId} 返回非 JSON：${String(stdout ?? "").slice(0, 200) || "(stdout 为空)"}${why ? `\n${why}` : ""}`));
          return;
        }
        if (parsed.ok !== true) {
          reject(new Error(`${toolId} 执行失败（${parsed.error_code ?? "UNKNOWN"}）：${parsed.message ?? "未给出原因"}`));
          return;
        }
        if (error) {
          // 进程超时被杀但结果已拿到：结果仍然可信，只是要让人知道它跑到了上限。
          resolve(parsed.result);
          return;
        }
        resolve(parsed.result);
      },
    );
    child.stdin?.end(JSON.stringify(payload));
  });
}

/** 按需创建（每次调用一份新 runner，避免把 engineRoot 绑死在模块级）。 */
export function knowledgeToolRunner(options: EngineToolOptions): ToolRunner {
  return options.run ?? pythonEngineToolRunner(options.engineRoot, options.timeoutMs ?? DEFAULT_TIMEOUT_MS, options.python);
}
