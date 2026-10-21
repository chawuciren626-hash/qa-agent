"""Read-only verification of a completed offline local migration, before startup."""
import importlib.util
import json
from pathlib import Path
import sqlite3
import sys

spec = importlib.util.spec_from_file_location('migration', Path(__file__).with_name('migrate-local-data.py'))
migration = importlib.util.module_from_spec(spec)
spec.loader.exec_module(migration)
plan = json.loads(Path(sys.argv[1]).read_text(encoding='utf-8-sig'))
root, backup = Path(plan['installation']), Path(plan['backup'])
journal = json.loads((backup / 'journal.json').read_text(encoding='utf-8'))
assert journal['status'] == 'data_migrated_pending_startup_validation'
changed = {item['path'] for item in journal['changes'] if 'path' in item}
deliveries = 0
for name, expected in journal['copies']['workspaces']['hashes'].items():
    relative = str(Path('workspaces') / name)
    if relative not in changed:
        assert migration.digest(root / relative) == expected, relative
        deliveries += 1
trace_files = 0
for original in (backup / 'original-host_data').glob('*/agents/*/traces/**/*.jsonl'):
    relocated = root / 'data/penguin' / original.relative_to(backup / 'original-host_data')
    before, after = original.read_bytes().splitlines(), relocated.read_bytes().splitlines()
    assert len(before) == len(after)
    for left, right in zip(before, after):
        if left == right:
            continue
        a, b = json.loads(left), json.loads(right)
        assert a['type'] == b['type'] == 'session_meta'
        for key in ['workspace', 'agent_state']:
            if key in a['payload']:
                b['payload'][key] = a['payload'][key]
        assert a == b
    trace_files += 1
credentials = 0
for original in (backup / 'original-host_data').rglob('*'):
    if original.is_file() and original.name in ['.project_config.toml', '.vault.toml', 'api-token']:
        relocated = root / 'data/penguin' / original.relative_to(backup / 'original-host_data')
        assert migration.digest(original) == migration.digest(relocated)
        credentials += 1
old = sqlite3.connect((backup / 'original-host_data/web.db').as_uri() + '?mode=ro', uri=True)
new = sqlite3.connect((root / 'data/penguin/web.db').as_uri() + '?mode=ro', uri=True)
tables = [row[0] for row in old.execute("select name from sqlite_master where type='table' and name not like 'sqlite_%'")]
for table in tables:
    columns = [row[1] for row in old.execute(f'pragma table_info("{table}")')]
    ignored = {'workspace'} if table in ['sessions', 'trace_sessions'] else {'page_stats'} if table == 'trace_files' else set()
    selected = ','.join('"' + c + '"' for c in columns if c not in ignored)
    def rows(connection):
        return sorted(json.dumps(row, ensure_ascii=False, sort_keys=True) for row in connection.execute(f'select {selected} from "{table}"'))
    assert rows(old) == rows(new), table
old.close()
new.close()
result = {'status': 'passed', 'unchanged_workspace_files': deliveries, 'trace_files_with_unchanged_message_bodies': trace_files, 'credential_files_unchanged': credentials, 'database_tables_preserved_except_explicit_path_cache_fields': len(tables), 'model_calls': 0}
(backup / 'data-verification.json').write_text(json.dumps(result, indent=2) + '\n', encoding='utf-8')
print(json.dumps(result))
