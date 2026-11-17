// Structural extraction only. A clause is a source span, never an approved rule.
export function parseRequirementSource(path, content) {
  if (!/^inputs\/(?:[^/]+\/)*[^/]+\.(?:md|markdown|txt)$/i.test(path))
    return { status: 'not_applicable', reason: 'source_format_requires_separate_parser' };
  const lines = content.split(/\r?\n/);
  const clauses = [];
  const sections = [];
  for (const [index, raw] of lines.entries()) {
    const line = raw.trim();
    if (!line) continue;
    const heading = /^#{1,6}\s+(.+)$/.exec(line);
    if (heading) { sections.push({ title: heading[1], line: index + 1 }); continue; }
    const bullet = /^(?:[-*+]\s+|\d+[.)、]\s*)(.+)$/.exec(line);
    const statement = bullet ? bullet[1].trim() : line;
    if (statement) clauses.push({ line: index + 1, quote: statement });
  }
  return clauses.length ? { status: 'completed', sections, clauses }
    : { status: 'not_applicable', reason: 'no_text_clauses' };
}
