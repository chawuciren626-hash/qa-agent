import { useEffect, useSyncExternalStore } from "react";
import { controlRequest } from "../api/control";
import { useAuth } from "../state/auth";
import { useProject } from "../state/project";
import type { AppliedResource, ManagedResource } from "./managed-resources";

interface Snapshot {
  resources: ManagedResource[];
  applied: AppliedResource[];
  error: string;
}
const empty: Snapshot = { resources: [], applied: [], error: "" };
interface Entry { value: Snapshot; listeners: Set<() => void>; pending?: Promise<void>; checked: number }
const entries = new Map<string, Entry>();
function entryFor(key: string) {
  let entry = entries.get(key);
  if (!entry) { entry = { value: empty, listeners: new Set(), checked: 0 }; entries.set(key, entry); }
  return entry;
}

export function useManagedResources(eager = true) {
  const { user, accountClient } = useAuth();
  const { currentProject } = useProject();
  const projectId = currentProject?.projectId;
  const enabled = !!(accountClient && !window.location.pathname.startsWith("/admin") && user && projectId && currentProject?.role === "owner");
  const key = enabled ? `${user!.userId}:${projectId}` : "";
  const entry = entryFor(key);
  const snapshot = useSyncExternalStore(
    listener => { entry.listeners.add(listener); return () => { entry.listeners.delete(listener); }; },
    () => entry.value,
  );
  async function refresh() {
    if (!enabled) return;
    if (entry.pending) return entry.pending;
    entry.pending = (async () => {
      try {
        const [catalog, local] = await Promise.all([
          controlRequest("/api/control/catalog"),
          controlRequest("/api/control/applied?projectId=" + encodeURIComponent(projectId!)),
        ]);
        entry.value = { resources: catalog.resources, applied: local.applied, error: "" };
      } catch (error) {
        // No stale availability or update indication when online authorization cannot be checked.
        entry.value = { ...empty, error: error instanceof Error ? error.message : "无法读取管理员配置" };
      } finally {
        entry.checked = Date.now();
        entry.pending = undefined;
        entry.listeners.forEach(listener => listener());
      }
    })();
    return entry.pending;
  }
  useEffect(() => {
    if (!enabled || !eager) return;
    const check = () => { if (Date.now() - entry.checked > 60_000) void refresh(); };
    check();
    window.addEventListener("focus", check);
    const timer = window.setInterval(check, 60_000);
    return () => { window.removeEventListener("focus", check); window.clearInterval(timer); };
  }, [key, eager]);
  return { ...(enabled ? snapshot : empty), enabled, refresh };
}
