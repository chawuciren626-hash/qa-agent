"""Extract run-local DOCX requirements without modifying the original package."""
import hashlib
import io
import json
import os
from pathlib import Path
import re
import sys
import unicodedata
import zipfile
import xml.etree.ElementTree as ET

W = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
LIMIT = 32 * 1024 * 1024


def extract(data):
    if len(data) > LIMIT:
        raise ValueError('DOCX exceeds 32 MiB input limit')
    with zipfile.ZipFile(io.BytesIO(data)) as package:
        infos = package.infolist()
        names = [entry.filename for entry in infos]
        if len(names) != len(set(names)) or sum(e.file_size for e in infos) > LIMIT:
            raise ValueError('Duplicate ZIP members or expanded size exceeds 32 MiB')
        raw = package.read('word/document.xml')
        if b'<!DOCTYPE' in raw.upper() or b'<!ENTITY' in raw.upper():
            raise ValueError('DTD and entity declarations are unsupported')
        doc = ET.fromstring(raw)
        body = doc.find(W + 'body')
        if body is None:
            raise ValueError('Missing supported Word document body')
        warnings = ['Text extraction is not visual layout verification; page numbers and automatic list numbering are not reconstructed.']
        tags = {node.tag for node in doc.iter()}
        checks = [
            (any(n.startswith('word/media/') for n in names), 'Images are retained in the original but not OCR-read.'),
            (any('comments' in n for n in names), 'Comments are not extracted.'),
            (any(n.startswith(('word/header', 'word/footer')) for n in names), 'Headers and footers are not extracted.'),
            (any(n in names for n in ['word/footnotes.xml', 'word/endnotes.xml']), 'Footnotes and endnotes are not extracted.'),
            (W + 'ins' in tags or W + 'del' in tags or W + 'moveFrom' in tags or W + 'moveTo' in tags, 'Tracked revisions exist: inserted/moved-to text is included, deleted/moved-from text omitted; this is not acceptance of revisions.'),
            (W + 'txbxContent' in tags, 'Text boxes are not extracted.'),
            (W + 'altChunk' in tags or W + 'object' in tags, 'Embedded documents/objects are not extracted.'),
            (W + 'fldChar' in tags or W + 'fldSimple' in tags, 'Fields use stored text only; field values are not recalculated.'),
            (W + 'vMerge' in tags or W + 'gridSpan' in tags, 'Merged cells are annotated; visual grid positions require the original document.')
        ]
        warnings.extend(message for present, message in checks if present)

        def text(node):
            if node.tag in {W + 'del', W + 'moveFrom', W + 'txbxContent'}:
                return ''
            if node.tag == W + 't':
                return node.text or ''
            if node.tag == W + 'tab':
                return '\t'
            if node.tag in {W + 'br', W + 'cr'}:
                return '\n'
            return ''.join(text(child) for child in node)

        blocks = []

        def walk(parent, locator):
            for index, node in enumerate(parent, 1):
                here = f'{locator}/{node.tag.split("}")[-1]}[{index}]'
                if node.tag == W + 'p':
                    blocks.append({'locator': here, 'type': 'paragraph', 'text': text(node)})
                elif node.tag == W + 'tbl':
                    blocks.append({'locator': here, 'type': 'table_start', 'text': ''})
                    walk(node, here)
                    blocks.append({'locator': here, 'type': 'table_end', 'text': ''})
                elif node.tag == W + 'tc':
                    span = node.find(f'{W}tcPr/{W}gridSpan')
                    merge = node.find(f'{W}tcPr/{W}vMerge')
                    annotation = []
                    if span is not None:
                        annotation.append('gridSpan=' + span.get(W + 'val', '?'))
                    if merge is not None:
                        annotation.append('vMerge=' + merge.get(W + 'val', 'continue'))
                    blocks.append({'locator': here, 'type': 'cell_start', 'text': ', '.join(annotation)})
                    walk(node, here)
                    blocks.append({'locator': here, 'type': 'cell_end', 'text': ''})
                elif node.tag in {W + 'tr', W + 'sdt', W + 'sdtContent', W + 'customXml', W + 'ins', W + 'moveTo'}:
                    walk(node, here)
                elif node.tag not in {W + 'sectPr', W + 'tblPr', W + 'tblGrid', W + 'trPr', W + 'tcPr', W + 'sdtPr', W + 'sdtEndPr', W + 'del', W + 'moveFrom'}:
                    warnings.append('Unsupported block skipped at ' + here)

        walk(body, 'body')
        if not any(b['type'] == 'paragraph' and b['text'].strip() for b in blocks):
            raise ValueError('No readable body text; image-only or unsupported document. Original retained; OCR not performed.')
        return blocks, list(dict.fromkeys(warnings))


def main():
    run_id, source = sys.argv[1:]
    name = source[7:] if source.startswith('inputs/') else ''
    safe_name = (0 < len(name) <= 180 and name == name.strip() and not name.startswith('.')
                 and not name.endswith(('.', ' '))
                 and not any(ch in '<>:"/\\|?*' or unicodedata.category(ch) in {'Cc', 'Cf'} for ch in name)
                 and not re.match(r'^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])([ .]|$)', name, re.I))
    if not re.fullmatch(r'run-[A-Za-z0-9-]+', run_id) or not safe_name or not name.lower().endswith('.docx'):
        raise ValueError('Expected run_id and archived inputs/<name>.docx; .doc is unsupported')
    root = Path(__file__).resolve().parent.parent
    context = json.loads(os.environ.get('QA_DIRECTORY_CONTEXT', 'null'))
    if context:
        engine, workspace, session = (Path(context[k]) for k in ('engine_root', 'workspace_root', 'session_root'))
        if context.get('version') != 1 or engine.resolve() != root or not all(p.is_absolute() for p in (engine, workspace, session)):
            raise ValueError('Invalid directory context')
        if session == workspace or not session.is_relative_to(workspace) or session.is_relative_to(engine) or session.resolve() != session:
            raise ValueError('Session directory escapes or redirects')
        root = session
    run = root / 'output' / 'runs' / run_id
    if run.resolve() != run or not (run / 'manifest.json').is_file():
        raise ValueError('Existing non-linked run required')
    if context:
        recorded = json.loads((run / 'manifest.json').read_text(encoding='utf-8')).get('directory_context', {})
        if any(recorded.get(k) != context.get(k) for k in ('engine_root', 'session_root', 'session_id')):
            raise ValueError('Run belongs to another directory context')
    path = run / source
    if path.resolve() != path:
        raise ValueError('Linked input paths are not allowed')
    data = path.read_bytes()
    blocks, warnings = extract(data)
    metadata = {'version': 1, 'run_id': run_id, 'original': source, 'original_sha256': hashlib.sha256(data).hexdigest(), 'warnings': warnings, 'blocks': blocks}
    content = '\n'.join(f'[{b["locator"]} {b["type"]}]\n{b["text"]}' for b in blocks) + '\n'
    outputs = {source + '.txt': content.encode('utf-8'), source + '.extraction.json': (json.dumps(metadata, ensure_ascii=False, indent=2) + '\n').encode('utf-8')}
    for name, value in outputs.items():
        target = run / name
        if target.resolve() != target or (target.exists() and target.read_bytes() != value):
            raise ValueError('Existing extraction differs or path is linked; preserve it and use a new input name')
    for name, value in outputs.items():
        target = run / name
        if not target.exists():
            with target.open('xb') as stream:
                stream.write(value)
    print(json.dumps({'status': 'extracted', 'original': source, 'text_path': source + '.txt', 'metadata_path': source + '.extraction.json', 'original_sha256': metadata['original_sha256'], 'block_count': len(blocks), 'warnings': warnings}, ensure_ascii=False))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps({'status': 'failed', 'error': str(error)}, ensure_ascii=False))
        sys.exit(2)
