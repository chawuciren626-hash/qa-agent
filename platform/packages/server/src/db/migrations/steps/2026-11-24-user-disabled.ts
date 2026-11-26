import type { Migration } from "../migration.js";

export const userDisabled: Migration = {
  name: "2026-11-24-user-disabled",
  swapSafe: true,
  up(db) {
    const columns = db.prepare("PRAGMA table_info(users)").all() as { name: string }[];
    if (!columns.some(column => column.name === "disabled")) {
      db.exec("ALTER TABLE users ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0");
    }
  },
  down(db) {
    const columns = db.prepare("PRAGMA table_info(users)").all() as { name: string }[];
    if (columns.some(column => column.name === "disabled")) db.exec("ALTER TABLE users DROP COLUMN disabled");
  },
};
