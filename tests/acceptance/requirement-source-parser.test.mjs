import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRequirementSource } from '../../scripts/requirement-source-parser.mjs';

test('oral and linked text snapshots keep exact source line positions', () => {
  const parsed = parseRequirementSource('inputs/link-snapshot.md', '# 登录\n\n- 登录后可新建用户\n3. 删除刚新建的用户');
  assert.equal(parsed.status, 'completed');
  assert.deepEqual(parsed.clauses, [
    { line: 3, quote: '登录后可新建用户' },
    { line: 4, quote: '删除刚新建的用户' },
  ]);
  assert.deepEqual(parsed.sections, [{ title: '登录', line: 1 }]);
  assert.deepEqual(parseRequirementSource('inputs/requirements.docx', 'binary'),
    { status: 'not_applicable', reason: 'source_format_requires_separate_parser' });
});
