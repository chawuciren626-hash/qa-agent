// Generated Playwright specs are untrusted Node code. Keep host secrets out.
const KEYS = [
  'PATH', 'PATHEXT', 'SystemRoot', 'WINDIR', 'ComSpec', 'TEMP', 'TMP',
  'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMFILES',
  'PROGRAMFILES(X86)', 'PROGRAMW6432', 'XDG_CACHE_HOME',
  'QA_DIRECTORY_CONTEXT', 'QA_APP_DATA_ROOT', 'QA_PYTHON',
];

export function executionChildEnv(parent = process.env, overrides = {}) {
  const env = {};
  for (const key of KEYS) {
    const found = Object.keys(parent).find(candidate => candidate.toUpperCase() === key.toUpperCase());
    if (found && typeof parent[found] === 'string') env[found] = parent[found];
  }
  return { ...env, ...overrides };
}
