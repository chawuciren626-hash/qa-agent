/** AITestHarness structured requests are prepared by the installed pre-tool hook. */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

export function qaWorkdir(args: Record<string, unknown>, workspace: string, cmd: string): string {
  let raw = args.workdir;
  if (
    raw === "CWD" &&
    /^node(?:\.exe)?\s+(?:scripts[\\/])?project-action\.mjs\s+(?:catalog|summary|execute)(?:\s|$)/.test(
      cmd,
    ) &&
    existsSync(path.join(workspace, ".qa-session.json")) &&
    !existsSync(path.join(workspace, "CWD"))
  )
    raw = undefined;
  const dir = typeof raw === "string" && raw.length ? path.resolve(workspace, raw) : workspace;
  if (args.qa_request !== undefined) {
    const request = /--request=(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s]+))/.exec(cmd);
    const file = request && path.resolve(dir, request[1] ?? request[2] ?? request[3]!);
    const base = path.resolve(workspace, "output/action-requests");
    if (
      !/^node(?:\.exe)?\s+(?:scripts[\\/])?project-action\.mjs\s+execute\s/.test(cmd) ||
      !file ||
      path.dirname(file) !== base ||
      realpathSync(file) !== file ||
      !isDeepStrictEqual(JSON.parse(readFileSync(file, "utf8")), args.qa_request)
    )
      throw new Error(
        "QA request was not prepared by the hook or differs from qa_request; no command was launched",
      );
  }
  return dir;
}
