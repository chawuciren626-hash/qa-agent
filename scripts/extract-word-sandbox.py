"""Parse one snapshotted DOCX inside the managed WSL mount profile."""
import hashlib
import json
from pathlib import Path
import runpy
import sys

source = Path(sys.argv[1])
output = Path(sys.argv[2])
run_id = sys.argv[3]
name = sys.argv[4]
data = source.read_bytes()
extract = runpy.run_path(str(Path(__file__).with_name('extract-word-input.py')))['extract']
blocks, warnings = extract(data)
metadata = {'version': 1, 'run_id': run_id, 'original': name,
            'original_sha256': hashlib.sha256(data).hexdigest(), 'warnings': warnings, 'blocks': blocks}
content = '\n'.join(f'[{block["locator"]} {block["type"]}]\n{block["text"]}' for block in blocks) + '\n'
(output / 'text.txt').write_bytes(content.encode('utf-8'))
(output / 'metadata.json').write_bytes((json.dumps(metadata, ensure_ascii=False, indent=2) + '\n').encode('utf-8'))
print(json.dumps({'status': 'parsed', 'sha256': metadata['original_sha256'], 'blocks': len(blocks)}))
