import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_POOL_CAPACITY, type ResourcePool } from "./qa-task-run-registry.js";

/**
 * 池容量装配（B5）：config/pool-capacity.json（{ "web": 2, "api": 20, ... }）覆盖默认值。
 * 文件缺失、字段缺失或非法（非 1-50 整数）一律回退默认——配错容量不应该让服务起不来。
 */
export function loadPoolCapacity(engineRoot: string | undefined): Record<ResourcePool, number> {
  const capacity = { ...DEFAULT_POOL_CAPACITY };
  if (!engineRoot) return capacity;
  try {
    const overrides = JSON.parse(readFileSync(join(engineRoot, "config", "pool-capacity.json"), "utf8")) as Record<string, unknown>;
    for (const pool of Object.keys(DEFAULT_POOL_CAPACITY) as ResourcePool[]) {
      const value = overrides[pool];
      if (typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 50) capacity[pool] = value;
    }
  } catch { /* 缺文件或坏 JSON：用默认值。 */ }
  return capacity;
}
