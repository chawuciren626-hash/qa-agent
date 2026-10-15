import importlib.util
import io
from pathlib import Path
import unittest
import zipfile

spec = importlib.util.spec_from_file_location('word_input', Path(__file__).resolve().parents[2] / 'scripts/extract-word-input.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'


def package(body, extra=None):
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, 'w') as archive:
        archive.writestr('word/document.xml', f'<w:document xmlns:w="{NS}"><w:body>{body}</w:body></w:document>')
        for name, data in (extra or {}).items():
            archive.writestr(name, data)
    return buffer.getvalue()


class WordInputTests(unittest.TestCase):
    def test_paragraph_table_order_and_exact_text(self):
        blocks, _ = module.extract(package('<w:p><w:r><w:t>不得保存“空值” &amp; 10</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>字段</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>必填</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:p><w:r><w:t>结束</w:t></w:r></w:p>'))
        self.assertEqual([b['text'] for b in blocks if b['type'] == 'paragraph'], ['不得保存“空值” & 10', '字段', '必填', '结束'])
        self.assertTrue(any('/tr[' in b['locator'] and '/tc[' in b['locator'] for b in blocks))

    def test_unread_parts_and_revisions_reported(self):
        blocks, warnings = module.extract(package('<w:p><w:del><w:r><w:delText>old</w:delText></w:r></w:del><w:ins><w:r><w:t>new</w:t></w:r></w:ins></w:p>', {'word/media/image.png': b'x', 'word/comments.xml': b'x'}))
        self.assertEqual(blocks[0]['text'], 'new')
        self.assertTrue(any('not OCR' in w for w in warnings))
        self.assertTrue(any('Comments' in w for w in warnings))
        self.assertTrue(any('Tracked revisions' in w for w in warnings))

    def test_image_only_and_corrupt_files_fail(self):
        with self.assertRaisesRegex(ValueError, 'No readable'):
            module.extract(package('<w:p/>', {'word/media/image.png': b'x'}))
        with self.assertRaises(zipfile.BadZipFile):
            module.extract(b'not a docx')

    def test_nested_tables_and_merged_cells(self):
        blocks, warnings = module.extract(package('<w:tbl><w:tr><w:tc><w:tcPr><w:gridSpan w:val="2"/><w:vMerge/></w:tcPr><w:tbl><w:tr><w:tc><w:p><w:r><w:t>nested</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:tc></w:tr></w:tbl>'))
        self.assertEqual(sum(b['type'] == 'table_start' for b in blocks), 2)
        self.assertTrue(any('gridSpan=2' in b['text'] for b in blocks))
        self.assertTrue(any('Merged cells' in w for w in warnings))


if __name__ == '__main__':
    unittest.main()
