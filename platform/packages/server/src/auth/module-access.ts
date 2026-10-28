/** Bootstrap reads stay available. Match route positions, never names inside resource IDs. */
export function requestModule(path: string, method: string): string | undefined {
  const parts = path.split("/").filter(Boolean);
  if (parts[0] !== "api") return undefined;
  const write = !["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase());
  let tail = parts.slice(1);
  if (tail[0] === "projects") {
    if (tail.length <= 2) return write ? "projects" : undefined;
    tail = tail.slice(2);
  }
  if (tail[0] === "agents") {
    if (tail.length <= 2) return write ? "agents" : undefined;
    if (tail[1] === "qa") {
      if (tail[2] === "personal-resources") return "skills";
      if (tail[2] === "overview") return "projects";
      if (tail[2] === "initialize") return write ? "agents" : undefined;
    }
    tail = tail.slice(2);
    if (["config", "prompt", "import", "export", "api", "vault", "workbenches"].includes(tail[0]!)) return "agents";
    if (tail[0] === "memory") return tail[1] === "library" ? "library" : "agents";
  }
  const modules: Record<string, string> = {
    "qa-library": "library", library: "library", schedules: "schedules",
    skills: "skills", "dir-skills": "skills", "qa-personal-resources": "skills",
    plugins: "plugins", mcp: "plugins", "mcp-servers": "plugins", hooks: "plugins",
    models: "models", providers: "models", machines: "machines",
    usage: "usage", cost: "usage", benchmark: "benchmark", benchmarks: "benchmark",
  };
  const module = modules[tail[0]!];
  if (module) return module;
  if (["sessions", "chat", "terminals"].includes(tail[0]!) && write) return "chat";
  return undefined;
}
