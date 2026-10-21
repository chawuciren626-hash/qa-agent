"""Offline, same-host migration into a new product installation.

Copies and verifies originals into a separate backup before changing destination
metadata. Never edits input data, trace bodies, delivery files or model secrets.
Usage: python migrate-local-data.py <private-migration-plan.json>
"""
import hashlib
import json
import ntpath
import os
from pathlib import Path
import re
import shutil
import sqlite3
import subprocess
import sys


def io_path(path):
    value = str(Path(path).absolute())
    return Path('\\\\?\\' + value) if os.name == 'nt' and not value.startswith('\\\\?\\') else Path(value)


def digest(path):
    h = hashlib.sha256()
    with io_path(path).open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def mapped_path(value, mappings):
    if not isinstance(value, str) or '\n' in value or not ntpath.isabs(value):
        return value
    normalized = ntpath.normpath(value)
    for old, new in mappings:
        old = ntpath.normpath(old)
        if ntpath.normcase(normalized) == ntpath.normcase(old):
            return ntpath.normpath(new)
        if ntpath.normcase(normalized).startswith(ntpath.normcase(old) + '\\'):
            return ntpath.join(new, normalized[len(old) + 1:])
    return value


def ensure_host_stopped():
    subprocess.run(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command',
                    'if(Get-Process PenguinHarness -ErrorAction SilentlyContinue){exit 1}'],
                   check=True, capture_output=True)


def migrate(plan, resume_copy=False, process_check=ensure_host_stopped):
    if os.name != 'nt' or plan.get('version') != 1 or plan.get('host_version') != '0.2.16':
        raise ValueError('Only the inspected Windows host 0.2.16 migration is supported')
    process_check()
    root = Path(plan['installation']).resolve(strict=True)
    backup = Path(plan['backup']).resolve(strict=True)
    if (backup / 'journal.json').exists() and not resume_copy:
        raise ValueError('Existing migration journal: inspect before retrying')
    if (root / 'installation.json').exists():
        raise ValueError('Disable the destination launcher by retaining installation.json separately first')
    sources = {key: Path(value).resolve(strict=True) for key, value in plan['sources'].items()}
    target = {'host_data': root / 'data/penguin', 'qa_data': root / 'data/qa',
              'profile': root / 'data/desktop-profile', 'workspaces': root / 'workspaces'}
    if set(sources) != set(target):
        raise ValueError('Unexpected source set')
    for key, source in sources.items():
        if target[key].exists() and not resume_copy:
            raise ValueError('Destination must not already exist')
        for destination in [root, backup]:
            if source == destination or source in destination.parents or destination in source.parents:
                raise ValueError('Migration source and destination overlap')
    mappings = [(str(sources[k]), str(v)) for k, v in target.items()]
    mappings.extend((plan['sources'][k], str(v)) for k, v in target.items())
    mappings.append((plan['old_engine'], str(root / 'app/engine')))
    journal = {'version': 1, 'status': 'copying', 'copies': {}, 'changes': [], 'unmapped_workspaces': []}
    if resume_copy:
        journal = json.loads((backup / 'journal.json').read_text(encoding='utf-8'))
        if journal['status'] != 'interrupted_keep_destination_disabled' or journal['changes'] or 'database' in journal:
            raise ValueError('Only an interrupted copy before metadata edits may resume')
        journal['status'] = 'copying'

    def save():
        (backup / 'journal.json').write_text(json.dumps(journal, ensure_ascii=False, indent=2), encoding='utf-8')

    def verified_copy(source, destination):
        entries = {}
        io_path(destination).mkdir(parents=True, exist_ok=resume_copy)
        def walk_error(error):
            raise error
        for directory, dirs, files in os.walk(io_path(source), followlinks=False, onerror=walk_error):
            directory = Path(str(directory).removeprefix('\\\\?\\'))
            for name in dirs + files:
                entry = directory / name
                if io_path(entry).is_symlink() or io_path(entry).is_junction():
                    raise ValueError('Linked migration input refused')
            relative = directory.relative_to(source)
            for name in dirs:
                io_path(destination / relative / name).mkdir(exist_ok=resume_copy)
            for name in files:
                src, dst = directory / name, destination / relative / name
                before = digest(src)
                if io_path(dst).exists():
                    if not resume_copy or digest(dst) != before:
                        raise ValueError('Existing copy differs from original: ' + str(dst))
                else:
                    # CopyFile2 requires extended Windows paths for long archived run names.
                    shutil.copy2(io_path(src), io_path(dst))
                if digest(dst) != before or digest(src) != before:
                    raise ValueError('Source changed or copied file checksum differs')
                entries[str(relative / name)] = before
        return entries

    def write_changed(path, content, kind):
        before = path.read_bytes()
        after = content if isinstance(content, bytes) else content.encode('utf-8')
        if before != after:
            path.write_bytes(after)
            journal['changes'].append({'path': str(path.relative_to(root)), 'kind': kind,
                                       'before': hashlib.sha256(before).hexdigest(), 'after': digest(path)})

    def remap_context(value):
        result = dict(value)
        for key in ['engine_root', 'workspace_root', 'session_root', 'output_root', 'run_root']:
            if key in result:
                result[key] = mapped_path(result[key], mappings)
        return result

    save()
    try:
        for key, source in sources.items():
            original = backup / ('original-' + key)
            entries = verified_copy(source, original)
            if verified_copy(original, target[key]) != entries:
                raise ValueError('Destination differs from backup')
            journal['copies'][key] = {'files': len(entries), 'hashes': entries}
            save()
            print(json.dumps({'copied_and_verified': key, 'files': len(entries)}), flush=True)
        journal['status'] = 'updating_destination_metadata'
        save()

        # Workspace ownership and generated command shims are program metadata.
        markers = list(target['workspaces'].rglob('.qa-session.json'))
        for marker in markers:
            old = json.loads(marker.read_text(encoding='utf-8-sig'))
            new = remap_context(old)
            if Path(new['session_root']) != marker.parent:
                raise ValueError('Workspace marker does not match copied location')
            write_changed(marker, json.dumps(new, ensure_ascii=False, indent=2) + '\n', 'workspace_marker')
            for name in ['project-action.mjs', 'project-command.mjs']:
                shim = marker.parent / 'scripts' / name
                expected = 'import ' + json.dumps((Path(old['engine_root']) / 'scripts' / name).as_uri()) + ';\n'
                if shim.read_text(encoding='utf-8') != expected:
                    raise ValueError('Modified workspace command shim: ' + str(shim))
                content = 'import ' + json.dumps((root / 'app/engine/scripts' / name).as_uri()) + ';\n'
                write_changed(shim, content, 'workspace_shim')
        for index in (target['qa_data'] / 'session-workspaces').glob('*.json'):
            value = json.loads(index.read_text(encoding='utf-8-sig'))
            write_changed(index, json.dumps(remap_context(value), ensure_ascii=False, indent=2) + '\n', 'workspace_index')
        for manifest in target['workspaces'].glob('**/output/runs/*/manifest.json'):
            value = json.loads(manifest.read_text(encoding='utf-8-sig'))
            if isinstance(value.get('directory_context'), dict):
                value['directory_context'] = remap_context(value['directory_context'])
                write_changed(manifest, json.dumps(value, ensure_ascii=False, indent=2) + '\n', 'run_directory_context')

        # Keep all message/tool content byte-for-byte; only edit session_meta paths.
        traces_changed = 0
        for trace in target['host_data'].glob('*/agents/*/traces/**/*.jsonl'):
            original = trace.read_bytes().splitlines(keepends=True)
            updated = []
            for line in original:
                row = json.loads(line)
                if row.get('type') == 'session_meta' and isinstance(row.get('payload'), dict):
                    before = dict(row['payload'])
                    for key in ['workspace', 'agent_state']:
                        if key in row['payload']:
                            row['payload'][key] = mapped_path(row['payload'][key], mappings)
                    if row['payload'] != before:
                        line = (json.dumps(row, ensure_ascii=False, separators=(',', ':')) + '\n').encode('utf-8')
                updated.append(line)
            data = b''.join(updated)
            if data != b''.join(original):
                traces_changed += 1
                write_changed(trace, data, 'trace_metadata_only')

        # Workspace memories are keyed by the resolved path hash in upstream 0.2.16.
        for marker in list(target['host_data'].glob('*/agents/*/agent_state/memory/*/.workspace')):
            old = marker.read_text(encoding='utf-8').strip()
            new = mapped_path(old, mappings)
            if new != old:
                write_changed(marker, new + '\n', 'memory_workspace_marker')
                base = re.sub('[^A-Za-z0-9_-]+', '-', ntpath.basename(new)).strip('-')[:40].lower() or 'workspace'
                key = base + '-' + hashlib.sha256(new.encode('utf-8')).hexdigest()[:8]
                destination = marker.parent.with_name(key)
                if destination != marker.parent:
                    if destination.exists():
                        raise ValueError('Workspace memory key collision')
                    marker.parent.rename(destination)
                    journal['changes'].append({'kind': 'memory_directory', 'before_path': str(marker.parent.relative_to(root)), 'after_path': str(destination.relative_to(root))})

        db_path = target['host_data'] / 'web.db'
        with sqlite3.connect(db_path) as db:
            if db.execute('pragma integrity_check').fetchone()[0] != 'ok':
                raise ValueError('Copied host database is not valid')
            counts = {}
            for table in ['sessions', 'trace_sessions']:
                changed = 0
                for sid, old in db.execute(f'select session_id,workspace from {table}').fetchall():
                    new = mapped_path(old, mappings)
                    if new != old:
                        db.execute(f'update {table} set workspace=? where session_id=?', (new, sid))
                        changed += 1
                    elif table == 'sessions' and old and not Path(old).exists():
                        journal['unmapped_workspaces'].append({'session_id': sid, 'workspace': old, 'reason': 'missing_before_migration'})
                counts[table] = changed
            # Changed trace byte offsets must not reuse the old message-window cache.
            db.execute('update trace_files set page_stats=NULL')
            journal['database'] = {'integrity': 'ok', 'sessions': db.execute('select count(*) from sessions').fetchone()[0], 'rebound': counts}
        db.close()
        python_cache = target['qa_data'] / 'runtime/python.json'
        if python_cache.exists():
            value = json.loads(python_cache.read_text(encoding='utf-8'))
            value['executable'] = str(root / 'runtime/tools/python/python.exe')
            write_changed(python_cache, json.dumps(value, indent=2) + '\n', 'bundled_python_cache')

        # Explicitly adopt the seven existing managed roles, preserving all model settings.
        ids = [a['id'] for a in json.loads((root / 'app/engine/penguin/agents.json').read_text(encoding='utf-8'))['agents']]
        for agent in ids:
            if not (target['host_data'] / 'default_project/agents' / agent / 'agent_state').is_dir():
                raise ValueError('Existing QA role missing')
        installation = json.loads((root / 'installation.migration-pending.json').read_text(encoding='utf-8'))
        adoption = {'version': 1, 'installation_id': installation['installation_id'], 'project_id': installation['project_id'], 'status': 'initializing', 'owned': ids, 'migration': 'offline_explicit_adoption'}
        (target['qa_data'] / 'agent-initialization.json').write_text(json.dumps(adoption, indent=2) + '\n', encoding='utf-8')
        journal['status'] = 'data_migrated_pending_startup_validation'
        journal['trace_metadata_files'] = traces_changed
        save()
        print(json.dumps({'status': journal['status'], 'sessions': journal['database']['sessions'], 'rebound': journal['database']['rebound'], 'markers': len(markers), 'trace_metadata_files': traces_changed, 'preexisting_missing_workspace_sessions': len(journal['unmapped_workspaces'])}), flush=True)
    except Exception:
        journal['status'] = 'interrupted_keep_destination_disabled'
        save()
        raise


if __name__ == '__main__':
    if len(sys.argv) not in (2, 3) or len(sys.argv) == 3 and sys.argv[2] != '--resume-copy':
        raise SystemExit('Usage: migrate-local-data.py <private-migration-plan.json> [--resume-copy]')
    migrate(json.loads(Path(sys.argv[1]).read_text(encoding='utf-8-sig')), resume_copy=len(sys.argv) == 3)
