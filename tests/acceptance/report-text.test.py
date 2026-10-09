import ast
from pathlib import Path
import re
import unittest
import hashlib


source = Path(__file__).resolve().parents[2] / 'scripts/generate-report-documents.py'
tree = ast.parse(source.read_text(encoding='utf-8'))
functions = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name in ('clean_text', 'validate_report_results', 'validate_report_lifecycle')]
namespace = {'re': re, 'hashlib': hashlib}
exec(compile(ast.Module(body=functions, type_ignores=[]), str(source), 'exec'), namespace)
clean_text = namespace['clean_text']


class ReportTextTests(unittest.TestCase):
    def test_rejects_changed_lifecycle_before_export(self):
        with self.assertRaises(SystemExit):
            namespace['validate_report_lifecycle']({'governance': {'ledger_sha256': 'old'}}, b'changed')

    def test_accepts_current_lifecycle_and_rejects_missing_governance(self):
        namespace['validate_report_lifecycle']({'governance': {'ledger_sha256': None}}, None)
        with self.assertRaises(SystemExit):
            namespace['validate_report_lifecycle']({}, None)

    def test_rejects_historical_success_for_latest_block(self):
        with self.assertRaises(SystemExit):
            namespace['validate_report_results']({'execution': {'status': 'blocked', 'total': 0}}, {'status': 'completed', 'summary': {'total': 1}})

    def test_rejects_wrong_invocation(self):
        with self.assertRaises(SystemExit):
            namespace['validate_report_results']({'trust': {'execution_state': {'invocation_id': 'new'}}}, {'invocation_id': 'old'})

    def test_accepts_current_reportable_blocked_results(self):
        namespace['validate_report_results']({'execution': {'status': 'blocked', 'total': 0}, 'trust': {'execution_state': {'invocation_id': 'new'}}}, {'status': 'blocked', 'summary': {'total': 0}, 'invocation_id': 'new'})

    def test_preserves_evidence_identifiers(self):
        self.assertEqual(clean_text('`execution/test_results.json`'), 'execution/test_results.json')
        self.assertEqual(clean_text('**review_required**'), 'review_required')

    def test_word_receives_literal_text(self):
        self.assertEqual(clean_text('400 <= status < 600 & error'), '400 <= status < 600 & error')


if __name__ == '__main__':
    unittest.main()
