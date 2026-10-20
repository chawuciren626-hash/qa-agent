// Exact anchors deliberately reject unsupported upstream builds before installation.
export const reliabilityPatches = [
  [
    '      const onAbort = () => session.kill();\n      let registered = false;\n      signal?.addEventListener("abort", onAbort, { once: true });\n      const windowSignal = collectUntil(signal, detachSignal);',
    `      const qaRetained = /QA_COMMAND_POLICY_V[23] [a-f0-9-]{36}:/.test(prompt) && /\\brun_id=run-[A-Za-z0-9-]+/.test(prompt);
      const qaRetainedId = qaRetained ? manager.register(session) : null;
      if (qaRetainedId) yield partialToolCallOutput({eventType:"delta",toolCallId,output:
        \`[subagent retained with subagent_id \${qaRetainedId}; continuation only, not completion. Use input_subagent for new information after interruption; never repeat run_subagent.]\\n\`});
      if (signal?.aborted) { session.abortRun(); return {stopReason:"aborted"}; }
      const onAbort = () => qaRetained ? session.abortRun() : session.kill();
      let registered = qaRetained;
      signal?.addEventListener("abort", onAbort, { once: true });
      const windowSignal = collectUntil(signal, detachSignal);`
  ],
  [
    '        if (session.running) {\n          const id = manager.register(session);\n          registered = true;\n          if (detachSignal?.aborted) {\n            armSubagentDoneReport(session, id, prompt, services);',
    '        if (session.running) {\n          const id = qaRetainedId ?? manager.register(session);\n          registered = true;\n          if (detachSignal?.aborted) {\n            armSubagentDoneReport(session, id, prompt, services);'
  ],
  [
    '    const argv = [shell.command, ...shell.args, prefix + opts.cmd];',
    `    // QA entry commands use the inherited, explicitly prepended runtime PATH.
    // Do not source login profiles on every structured call; ordinary shells are unchanged.
    const qaStructured = !!opts.env?.QA_DIRECTORY_CONTEXT && shell.name === "bash" &&
      /^node(?:\\.exe)?\\s+(?:scripts[\\\\/])?project-action\\.mjs\\s+(?:catalog|summary|execute)(?:\\s|$)/.test(opts.cmd) &&
      !/[\\r\\n;&|\x60$<>]/.test(opts.cmd);
    const argv = [shell.command, ...(qaStructured ? ["--noprofile", "--norc", "-c"] : shell.args), prefix + opts.cmd];`
  ],
  [
    '          workdir: {\n            type: "string",\n            description: "Working directory for the command; defaults to the cwd. Optionally a path relative to the cwd, or an absolute path."',
    '          qa_request: {\n            type: "object",\n            description: "QA controller or dispatched professional child: complete structured action JSON. With project-action.mjs execute --controller-session=<parent> --request=output/action-requests/<unique>.json, the installed QA hook saves this exact body before execution. No separate write_file is needed. Existing different contents are never overwritten. Omit for other commands; dispatch, authorization and stage guards still apply."\n          },\n          workdir: {\n            type: "string",\n            description: "Working directory for the command; omit to use the session workspace. Never use the word CWD as a path. Optionally a path relative to the cwd, or an absolute path."'
  ],
  [
    '      const rawWorkdir = args2["workdir"];\n      const workdir = typeof rawWorkdir === "string" && rawWorkdir.length > 0 ? path19.resolve(ctx.workspaceDir, rawWorkdir) : ctx.workspaceDir;',
    `      let rawWorkdir = args2["workdir"];
      if (rawWorkdir === "CWD" && /^node(?:\\.exe)?\\s+(?:scripts[\\\\/])?project-action\\.mjs\\s+(?:catalog|summary|execute)(?:\\s|$)/.test(cmd)) {
        const fs = await import("node:fs");
        // Only a missing placeholder in an isolated QA workspace; real directories keep their meaning.
        if (fs.existsSync(path19.resolve(ctx.workspaceDir, ".qa-session.json")) && !fs.existsSync(path19.resolve(ctx.workspaceDir, "CWD"))) rawWorkdir = undefined;
      }
      const workdir = typeof rawWorkdir === "string" && rawWorkdir.length > 0 ? path19.resolve(ctx.workspaceDir, rawWorkdir) : ctx.workspaceDir;
      if (args2.qa_request !== undefined) {
        try {
          const fs = await import("node:fs"), util = await import("node:util");
          const request = /--request=(?:"([^"\\r\\n]+)"|'([^'\\r\\n]+)'|([^\\s]+))/.exec(cmd);
          const file = request && path19.resolve(workdir, request[1] ?? request[2] ?? request[3]);
          const base = path19.resolve(ctx.workspaceDir, "output/action-requests");
          if (!/^node(?:\\.exe)?\\s+(?:scripts[\\\\/])?project-action\\.mjs\\s+execute\\s/.test(cmd) || !file || path19.dirname(file) !== base || fs.realpathSync(file) !== file || !util.isDeepStrictEqual(JSON.parse(fs.readFileSync(file, "utf8")), args2.qa_request)) throw new Error("prepared request does not match qa_request");
        } catch {
          yield delta("[QA request was not prepared or differs from qa_request; no command was launched. Check the installed QA controller hook or use write_file with the exact request body first.]");
          return { stopReason: "fatal" };
        }
      }`
  ],
  [
    '  async sessionHooks(runner, child) {\n    if (child) return void 0;\n    const { root: root8, projectId, agentId } = this.state;',
    '  async sessionHooks(runner, child) {\n    const { root: root8, projectId, agentId } = this.state;'
  ],
  [
    '    const installed2 = await listInstalledHooks(root8, projectId, agentId);\n    const pathPrepend = this.pathPrepend;',
    `    const installed2 = await listInstalledHooks(root8, projectId, agentId);
    const pathPrepend = this.pathPrepend;
    if (child) {
      // Only the QA tool boundary runs in children: no stop/prompt hooks or spawner.
      const preToolUse = installed2.filter(hook => hook.name === "qa-stage-boundary").flatMap(
        hook => hook.pre_tool_use.map(cmd => scriptPreToolUseHook(hook.name, hook.dir, cmd.command, cmd.timeout, pathPrepend))
      );
      return preToolUse.length ? { preToolUse } : void 0;
    }`
  ],
  [
    '      let consecutive = 0;\n      let turn;',
    '      let consecutive = 0;\n      let qaLengthRecovery = false;\n      let turn;'
  ],
  [
    '        failedTurns.push(turn);\n        attemptInput = this.withRetriedTurns(nextInput, failedTurns);',
    `        // Thinking-only length failures must not replay the entire failed reasoning.
        if (/no content other than thinking.*finish_reason=["']length["']/i.test(turn.outcome.errorMessage ?? "") && turn.toolOutputs.length === 0 && failedTurns.every(failed => failed.toolOutputs.length === 0)) {
          if (qaLengthRecovery) {
            this.pendingCarryOver = nextInput;
            return { kind: "llm_failure", errorCode: "output_length_no_progress", errorMessage: "Model exhausted output length twice without usable output; partial evidence retained. Reduce the work unit before resuming." };
          }
          qaLengthRecovery = true;
          failedTurns.length = 0;
          attemptInput = [...nextInput, userText("The previous attempt exhausted its output allowance with thinking only. Do not repeat that reasoning. Perform only the smallest next tool action or return a concise partial result and the remaining work. This is an internal recovery instruction, not additional user authorization.", "harness")];
          continue;
        }
        failedTurns.push(turn);
        attemptInput = this.withRetriedTurns(nextInput, failedTurns);`
  ],
  [
    '  abortTask(sessionId) {\n    const entry = this.entries.get(sessionId);\n    if (!entry || !entry.abort) return false;\n    entry.approvals.denyMain();\n    entry.abort.abort();\n    return true;\n  }',
    `  abortTask(sessionId) {
    const entry = this.entries.get(sessionId);
    if (!entry) return false;
    // Stop owned descendants even when the parent has already yielded its turn.
    let stopped = false;
    for (const child of entry.session.listBackgroundSubagents()) {
      stopped = entry.session.abortBackgroundSubagentRun(child.sessionId) || stopped;
    }
    entry.approvals.denyAll();
    if (entry.abort) { entry.abort.abort(); stopped = true; }
    return stopped;
  }`
  ],
  [
    '  abortRun() {\n    if (this.killed || !this.isRunning) return false;\n    this.reportCurrentRun = false;\n    this.runCtrl?.abort();\n    return true;\n  }',
    `  abortRun() {
    this.reportCurrentRun = false;
    const descendants = this.handle.abortChildren?.() ?? false;
    for (const req of [...this.approvals]) this.settle(req, "deny");
    if (this.killed || !this.isRunning) return descendants;
    this.runCtrl?.abort();
    return true;
  }`
  ],
  [
    '  kill() {\n    if (this.killed) return;\n    this.killed = true;\n    this.abortCtrl.abort();',
    '  kill() {\n    if (this.killed) return;\n    this.reportCurrentRun = false;\n    this.handle.abortChildren?.();\n    this.killed = true;\n    this.abortCtrl.abort();'
  ],
  [
    '    if (this.killed) return Promise.resolve("deny");',
    '    if (this.killed || this.runCtrl?.signal.aborted) return Promise.resolve("deny");'
  ],
  [
    '        sessionId: hop,\n        // One-shot upfront meta',
    `        sessionId: hop,
        abortChildren() {
          let stopped = false;
          for (const child of childSession.listBackgroundSubagents()) {
            stopped = childSession.abortBackgroundSubagentRun(child.sessionId) || stopped;
          }
          return stopped;
        },
        // One-shot upfront meta`
  ],
  [
    '      if (background) {\n        const id = manager.register(session);\n        armSubagentDoneReport(session, id, prompt, services);',
    `      if (signal?.aborted) {
        session.kill();
        return { stopReason: "aborted" };
      }
      if (background) {
        const id = manager.register(session);
        armSubagentDoneReport(session, id, prompt, services);`
  ],
  [
    '        if (meta2) yield meta2;\n        session.startRun([userText(prompt, "parent_agent")]);',
    `        if (meta2) yield meta2;
        if (signal?.aborted) {
          session.kill();
          return { stopReason: "aborted" };
        }
        session.startRun([userText(prompt, "parent_agent")]);`
  ]
];

export function patchReliabilityServer(source) {
  let next = source;
  for (const [before, after] of reliabilityPatches) {
    if (next.split(before).length !== 2) throw new Error(`Unsupported PenguinHarness reliability anchor: ${before.slice(0,80)}`);
    next = next.replace(before, after);
  }
  return next;
}
