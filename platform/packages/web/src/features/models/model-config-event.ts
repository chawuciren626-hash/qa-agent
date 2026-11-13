export const MODEL_CONFIG_CHANGED_EVENT = "penguin:model-config-changed";

export function dispatchModelConfigChanged(projectId: string): void {
  window.dispatchEvent(new CustomEvent(MODEL_CONFIG_CHANGED_EVENT, { detail: { projectId } }));
}

export function modelConfigChangedForProject(event: Event, projectId: string): boolean {
  return (event as CustomEvent<{ projectId: string }>).detail?.projectId === projectId;
}
