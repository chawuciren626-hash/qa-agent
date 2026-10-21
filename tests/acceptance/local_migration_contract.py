import importlib.util
import json
import pathlib
import sqlite3
import tempfile
import unittest
import contextlib
import shutil

module_path = pathlib.Path(__file__).parents[2] / 'scripts/migrate-local-data.py'
spec = importlib.util.spec_from_file_location('migration', module_path)
migration = importlib.util.module_from_spec(spec)
spec.loader.exec_module(migration)


@contextlib.contextmanager
def temporary_directory():
    base = pathlib.Path(tempfile.mkdtemp(prefix='migration-contract-')).resolve()
    try:
        yield base
    finally:
        assert base.parent == pathlib.Path(tempfile.gettempdir()).resolve()
        assert base.name.startswith('migration-contract-')
        shutil.rmtree(migration.io_path(base))


class MigrationContracts(unittest.TestCase):
    def test_paths_are_prefix_bounded_and_not_free_text_replacements(self):
        pairs = [(r'E:\old', r'E:\new')]
        self.assertEqual(migration.mapped_path(r'E:\old\output', pairs), r'E:\new\output')
        self.assertEqual(migration.mapped_path(r'E:\older\output', pairs), r'E:\older\output')
        self.assertEqual(migration.mapped_path('E:\\old\noriginal message', pairs), 'E:\\old\noriginal message')

    def test_copy_and_metadata(self):
        with temporary_directory() as folder:
            base = pathlib.Path(folder)
            root = base / 'installed'
            root.mkdir()
            backup = base / 'backups'
            backup.mkdir()
            sources = {}
            for key in ['host_data', 'qa_data', 'profile', 'workspaces']:
                source = base / ('old-' + key)
                source.mkdir()
                sources[key] = source
            engine = base / 'old-engine'
            engine.mkdir()
            roles = root / 'app/engine/penguin'
            roles.mkdir(parents=True)
            (roles / 'agents.json').write_text(json.dumps({'agents': [{'id': 'test_agent'}]}))
            (root / 'installation.migration-pending.json').write_text(json.dumps({'installation_id': 'fixture', 'project_id': 'default_project'}))
            state = sources['host_data'] / 'default_project/agents/test_agent/agent_state'
            state.mkdir(parents=True)
            credential = sources['host_data'] / 'default_project/.project_config.toml'
            credential.write_text('fixture = "not-a-real-credential"\n')
            session_id = 'session-2026-10-21-00-00-00-aabbccdd'
            session = sources['workspaces'] / '2026-10-21-00-00-00-aabbccdd'
            (session / 'scripts').mkdir(parents=True)
            context = {'version': 1, 'mode': 'isolated', 'session_id': session_id, 'engine_root': str(engine), 'workspace_root': str(sources['workspaces']), 'session_root': str(session), 'output_root': str(session / 'output'), 'run_root': str(session / 'output/runs')}
            (session / '.qa-session.json').write_text(json.dumps(context))
            index = sources['qa_data'] / 'session-workspaces'
            index.mkdir()
            (index / (session_id + '.json')).write_text(json.dumps(context))
            for name in ['project-action.mjs', 'project-command.mjs']:
                (session / 'scripts' / name).write_text('import ' + json.dumps((engine / 'scripts' / name).as_uri()) + ';\n')
            run = session / 'output/runs/run-fixture'
            run.mkdir(parents=True)
            (run / 'manifest.json').write_text(json.dumps({'directory_context': context, 'status': 'completed'}))
            long_file = run / ('long-' + 'a' * 70) / ('long-' + 'b' * 70) / 'delivery.bin'
            migration.io_path(long_file.parent).mkdir(parents=True)
            migration.io_path(long_file).write_bytes(b'unchanged delivery bytes')
            trace = sources['host_data'] / 'default_project/agents/test_agent/traces/day/fixture.jsonl'
            trace.parent.mkdir(parents=True)
            body = json.dumps({'type': 'tool_result', 'payload': {'text': str(session)}}) + '\n'
            trace.write_text(json.dumps({'type': 'session_meta', 'payload': {'workspace': str(session), 'agent_state': str(state)}}) + '\n' + body)
            with sqlite3.connect(sources['host_data'] / 'web.db') as db:
                for table in ['sessions', 'trace_sessions']:
                    db.execute(f'create table {table}(session_id text,workspace text)')
                    db.execute(f'insert into {table} values(?,?)', (session_id, str(session)))
                db.execute('create table trace_files(page_stats text)')
                db.execute("insert into trace_files values('old-cache')")
            db.close()
            plan = {'version': 1, 'host_version': '0.2.16', 'installation': str(root), 'backup': str(backup), 'sources': {k: str(v) for k,v in sources.items()}, 'old_engine': str(engine)}
            migration.migrate(plan, process_check=lambda: None)
            new_session = root / 'workspaces' / session.name
            self.assertEqual(json.loads((new_session / '.qa-session.json').read_text())['engine_root'], str(root / 'app/engine'))
            self.assertEqual(migration.digest(root / 'workspaces' / long_file.relative_to(sources['workspaces'])), migration.digest(long_file))
            self.assertEqual(migration.digest(root / 'data/penguin/default_project/.project_config.toml'), migration.digest(credential))
            new_trace = root / 'data/penguin' / trace.relative_to(sources['host_data'])
            self.assertEqual(new_trace.read_text().splitlines()[1], body.strip())
            self.assertEqual(json.loads(trace.read_text().splitlines()[0])['payload']['workspace'], str(session))
            with sqlite3.connect(root / 'data/penguin/web.db') as db:
                self.assertEqual(db.execute('select workspace from sessions').fetchone()[0], str(new_session))
                self.assertIsNone(db.execute('select page_stats from trace_files').fetchone()[0])
            db.close()
            with self.assertRaises(ValueError):
                migration.migrate(plan, process_check=lambda: None)


if __name__ == '__main__':
    unittest.main()
