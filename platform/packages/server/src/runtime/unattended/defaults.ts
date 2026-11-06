/**
 * Honest no-op stand-ins for the two executor-side interfaces the unattended coordinator
 * consumes (RunOutcomeSource, RunCanceller), so the platform tree always RESOLVES them —
 * the kernel rejects any @Use nothing provides, and the coordinator's logic treats
 * "no answer" as the honest state, never as success:
 *
 * - NoOutcomeSource.observe → null: without a wired outcome poller a dispatched run stays
 *   `running` until a real integrator reports (Codex integration note), and the sweep's
 *   unknown-outcome marking is what eventually records it. Nothing is ever guessed.
 * - NoRunCanceller.cancel → false: a cancel still settles server-side (the authoritative
 *   status flips to cancelled), and the run records cancel_signal_failed — the executor
 *   signal was NOT delivered, rather than claiming it was.
 *
 * Tests replace these fields by hand (wire({...})); a future integration replaces the
 * bindings in platform.ts with real adapters (integration-notes.md).
 */
import { Component } from "@prismshadow/penguin-core/kernel";
import type { RunCanceller, RunOutcomeSource } from "./types.js";

@Component()
export class NoOutcomeSource implements RunOutcomeSource {
  async observe(): Promise<"succeeded" | "failed" | null> {
    return null;
  }
}

@Component()
export class NoRunCanceller implements RunCanceller {
  async cancel(): Promise<boolean> {
    return false;
  }
}
