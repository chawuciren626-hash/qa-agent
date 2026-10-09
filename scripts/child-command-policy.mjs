export function childCommandPolicy(dispatchId) {
  return `QA_COMMAND_POLICY_V1 ${dispatchId}: On any command failure, input rejection, timeout, interruption or unknown result, stop and report the original evidence. Automatic retries=0. No downstream dispatch, installation, manifest edits or silent artifact repair. Resume only after controller review and a new authorized dispatch.`;
}

// Only inspect structured tool calls/results, never model reasoning or prose claims.
export function assertChildCommands(rows) {
  for (const [index, row] of rows.entries()) {
    if (row.payload?.type !== 'tool_call' || row.payload.name !== 'exec_command') continue;
    let args;
    try { args = typeof row.payload.arguments === 'string' ? JSON.parse(row.payload.arguments) : row.payload.arguments; }
    catch { throw new Error('Child command arguments unreadable'); }
    const outputs = rows.slice(index + 1).filter(item => item.payload?.type === 'tool_call_output' && item.payload.tool_call_id === row.payload.tool_call_id);
    if (outputs.length !== 1 || outputs[0].payload.stop_reason === 'fatal') throw new Error('Child command has unknown or failed terminal response; review required');
    if (!['project-command.mjs','project-action.mjs'].some(name => String(args?.cmd).includes(name))) continue;
    const raw = outputs[0].payload.output;
    let result;
    try {
      // PenguinHarness may prepend shell-profile warnings to the single JSON response.
      result = typeof raw === 'string' ? JSON.parse(raw.slice(raw.indexOf('{'))) : raw;
    } catch { throw new Error('Child runner response unreadable; review required'); }
    if (!result || !['completed', 'ready', 'help'].includes(result.status) || (result.exit_code !== undefined && result.exit_code !== 0)) throw new Error('Child command failed or was rejected; cannot complete this dispatch after retry');
    const inProcess = result.execution_mode === 'in_process' && result.launches_child === false && typeof result.action_receipt === 'string';
    if (result.status === 'completed' && (result.exit_code !== 0 || (!inProcess && result.result?.termination_confirmed !== true))) throw new Error('Child process completion is unconfirmed');
  }
}
