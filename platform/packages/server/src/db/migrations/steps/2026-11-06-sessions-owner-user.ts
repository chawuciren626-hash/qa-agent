import { ensureColumn } from "../../database.js";
import type { Migration } from "../migration.js";

/**
 * The authenticated person a Session's local user preferences belong to. Additive: existing
 * rows stay NULL (a legacy Session keeps whatever prompt it already recorded) and the next
 * creation writes the owner. Swap-safe because an older build ignores the column.
 */
export const sessionsOwnerUser: Migration = {
  name: "2026-11-06-sessions-owner-user",
  swapSafe: true,
  up(db) {
    ensureColumn(db, "sessions", "owner_user_id", "TEXT");
  },
  // Not a DROP: schema.ts declares the column; an older build simply never reads it.
  down() {},
};
