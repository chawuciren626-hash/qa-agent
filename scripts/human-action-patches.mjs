export const humanActionAnchors = [
  '  app.post("/:sessionId/tasks", async (c7) => {',
  '    const parsed2 = parseTaskInput(body, limits);\n    const queueIfBusy = body.queueIfBusy === true;',
  '  async sendToSubagent(sessionId, childSessionId, messages) {',
  '      ...resume ? { resume } : {}\n    }) ?? "gone";',
  '    this.attachHostTap(session);\n    if (session.steer(messages)) return "steered";',
];
export function patchHumanActions(source, moduleUrl, version='0.2.13') {
  const replace = (before, after) => {
    if(version==='0.2.16') { before=before.replaceAll('c7','c22'); after=after.replaceAll('c7','c22'); }
    if(source.split(before).length!==2) throw Error(`Unsupported human-action anchor: ${before.slice(0,70)}`);
    source=source.replace(before,after);
  };
  const answer = `async (row, body) => qaAnswerHumanAction({workspace:row.workspace,parent:row.sessionId,runId:body.run_id,actionId:body.action_id,decision:body.decision,
    send: (child,text,decision,channel) => deps.manager.sendToSubagent(row.sessionId,child,[userText(text),userText(channel === "api" ? (decision === "cancel" ? "用户取消接口认证等待。调用api_task cancel并收集部分结果，不再发业务请求。" : "用户确认接口认证已准备。继续原子会话和派发，使用本任务新提供的qa-secret引用调用api_task resume，credentials以status返回的credential_key为键。没有凭据引用时只询问真正缺少的认证信息，不猜测登录成功。不启动浏览器、不重复start、不重放已执行请求。") : decision === "cancel" ? "用户取消人工等待。保留证据，调用finish结束原浏览器并如实交付partial；不再执行产品操作。" : "用户确认已完成当前人工操作。继续原任务、原派发和原浏览器。第一步使用新的request_id调用snapshot检查当前页面；确认登录确已生效后才继续未执行步骤。若仍需人工操作，重新pause。禁止start、重复登录/提交或重跑已完成断言。", "harness")],{qaHumanContinuation:true})})`;
  replace(humanActionAnchors[0], `  const qaAnswerCurrentHumanAction = ${answer};
  app.get("/:sessionId/human-actions", (c7) => {
    const row=resolveSession(c7);c7.header("Cache-Control","no-store");
    return c7.json({actions:qaListHumanActions(row.workspace,row.sessionId)});
  });
  app.post("/:sessionId/human-actions", async (c7) => {
    const row=resolveSession(c7), body=await readJson(c7);
    try { return c7.json(await qaAnswerCurrentHumanAction(row,body)); }
    catch { throw new HttpError(409,"human_action_unavailable","原任务暂不能续接，请刷新查看；未新建任务或重放操作。"); }
  });
`+humanActionAnchors[0]);
  replace(humanActionAnchors[1], `    const parsed2 = parseTaskInput(body, limits);
    if(parsed2.attachments.length===0 && parsed2.images.length===0 && qaIsLoginConfirmation(parsed2.texts.join("\\n"))) {
      const actions=qaListHumanActions(row.workspace,row.sessionId).filter(a=>["access","captcha","mfa"].includes(a.kind));
      if(actions.length===1) {
        try { const result=await qaAnswerCurrentHumanAction(row,{run_id:actions[0].run_id,action_id:actions[0].action_id,decision:"continue"});return c7.json({sessionId:row.sessionId,queued:false,humanAction:result},202); }
        catch { throw new HttpError(409,"human_action_unavailable","原登录任务暂不能续接；未重新派发，请查看人工操作卡片。"); }
      }
    }
    const queueIfBusy = body.queueIfBusy === true;`);
  replace(humanActionAnchors[2], '  async sendToSubagent(sessionId, childSessionId, messages, qaOptions = {}) {');
  replace(humanActionAnchors[3], '      ...resume ? { resume } : {}, qaHumanContinuation: qaOptions.qaHumanContinuation === true\n    }) ?? "gone";');
  const arm = `if (opts?.qaHumanContinuation) {
      const id=[...this.subagentSessions.registered].find(([,row])=>row.sessionId===session.sessionId)?.[0] ?? this.subagentSessions.register(session);
      armSubagentDoneReport(session,id,"人工操作完成后的原任务续接",{backgroundDone:event=>this.emitBackgroundDone(event)});
    }`;
  replace(humanActionAnchors[4], `    this.attachHostTap(session);\n    ${arm}\n    if (session.steer(messages)) return "steered";`);
  const start='session.startRun(messages, { suppressDoneReport: true });';
  if(source.split(start).length!==3) throw Error('Unsupported child continuation anchors');
  source=source.replaceAll(start,`${arm}\n      session.startRun(messages, { suppressDoneReport: opts?.qaHumanContinuation !== true });`);
  return `import { listHumanActions as qaListHumanActions, answerHumanAction as qaAnswerHumanAction, isLoginConfirmation as qaIsLoginConfirmation } from ${JSON.stringify(moduleUrl)};\n`+source;
}
