// The shared presentation factory accepts host React components through a single adapter.
export function createWorkspaceUI(deps: Record<string, unknown>): Record<string, any>;
export function qaBindProject(projectId: string, userId: string | null, groupId: string | null | undefined, sessionId: string, storage?: Storage): void;
export function qaCompleteFirstRun(projectId: string, userId: string | null, storage?: Storage): void;
export function qaScope(projectId?: string, userId?: string, storage?: Storage): string;
export function qaRead(scope: string, storage?: Storage): {projects: {id: string; name: string; folders: string[]}[]; bindings: Record<string,string>};
export function qaProjectForSession(projects: {id: string; name: string; folders: string[]}[], bindings: Record<string,string>, session: {sessionId: string; workspace?: string}): {id: string; name: string; folders: string[]} | null;
export function qaTaskStatus(session: unknown, live?: unknown): {label: string; kind: string};
export function qaWorkspaceGroups(value: {projects: {id: string; name: string; folders: string[]}[]; bindings: Record<string,string>}, sessions?: {sessionId: string; workspace?: string}[]): {projects: {id: string; name: string; folders: string[]}[]; bindings: Record<string,string>};
