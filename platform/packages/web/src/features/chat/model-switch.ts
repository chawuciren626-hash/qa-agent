/**
 * In-conversation model switch (the active Session's toolbar model picker): the decisions the
 * chat page makes, kept pure so they are testable without a DOM.
 *
 * The switch is not the `/model` handoff. `/model` opens a NEW conversation on another model
 * and leaves this one as it is; this picker keeps the conversation and moves it onto the
 * picked model. It is an **in-place** switch (`POST …/switch-model` with `mode: "in-place"`):
 * the running context, its Trace file and its history stay, nothing is compacted, and only the
 * model subsequent turns run on changes. The stream carries the new `session_meta`, which the
 * stream model turns into a model-change marker and the page uses to move its Session row (see
 * `sessionRowStale`). Context length still triggers compaction later, on the new model's
 * threshold. A Session that never ran switches inside the request (200 with the updated
 * Session) without streaming anything.
 */
import type { ModelRefDto, SessionInfo, SessionStatus } from "@prismshadow/penguin-server/api";
import { sameModelRef } from "../models/model-grouping";

/**
 * Whether the picker is disabled: the server takes no switch while a Task runs or a compaction
 * is under way (an in-place switch itself publishes `running` until it finishes).
 */
export function sessionModelPickerDisabled(status: SessionStatus): boolean {
  return status === "running" || status === "compacting";
}

/**
 * Whether the Session row on hand names another model than the conversation is on: the running
 * context's `session_meta` (the stream model's `contextModel`) is of this Session and says so —
 * a switch completed, on this tab or another one watching the Session, or the row was held from
 * before a switch. The page then moves the row to that model; the server moved its own before
 * it published the record. False while the stream says nothing of this Session's model: before
 * its history has loaded, and for the stream of a conversation the page has just left.
 */
export function sessionRowStale(
  contextModel: (ModelRefDto & { sessionId: string }) | null,
  row: Pick<SessionInfo, "sessionId" | "provider" | "modelId"> | null,
): boolean {
  return (
    contextModel !== null &&
    row !== null &&
    contextModel.sessionId === row.sessionId &&
    !sameModelRef(contextModel, row)
  );
}
