import ast
from pathlib import Path
import re
import unittest


source = Path(__file__).resolve().parents[2] / 'scripts/generate-report-documents.py'
tree = ast.parse(source.read_text(encoding='utf-8'))
functions = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == 'clean_text']
namespace = {'re': re}
exec(compile(ast.Module(body=functions, type_ignores=[]), str(source), 'exec'), namespace)
clean_text = namespace['clean_text']


class ReportTextTests(unittest.TestCase):
    def test_preserves_evidence_identifiers(self):
        self.assertEqual(clean_text('`execution/test_results.json`'), 'execution/test_results.json')
        self.assertEqual(clean_text('**review_required**'), 'review_required')

    def test_word_receives_literal_text(self):
        self.assertEqual(clean_text('400 <= status < 600 & error'), '400 <= status < 600 & error')


if __name__ == '__main__':
    unittest.main()
