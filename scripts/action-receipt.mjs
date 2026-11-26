// The host may prepend shell-profile warnings or append archive/exit markers around
// the single JSON receipt a controlled action prints. One parser owns that tolerance:
// every gate reads receipts through it, so a host output-format change is fixed here
// once instead of drifting across scattered JSON.parse call sites.
// Returns null when no receipt object can be read; callers decide what that means
// (a fatal command's unreadable output is a failure, a completed one's is a review problem).
export function parseActionReceipt(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'string') return raw;
  const start = raw.indexOf('{'), end = raw.lastIndexOf('}');
  if (start < 0 || end < start) return null;
  try { return JSON.parse(raw.slice(start, end + 1)); } catch { return null; }
}