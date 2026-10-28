export function extractDeliveries(text: string, workspace?: string | null): {path: string; label: string}[];
export function deliveryEvidenceKind(path: string): "directory" | "json" | null;
