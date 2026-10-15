// Exact anchors deliberately reject unsupported upstream builds before installation.
export const reliabilityPatches = [
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
