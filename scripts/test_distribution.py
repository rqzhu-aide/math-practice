"""Verify the shipped question snapshot and its public distribution boundary."""
import json
from pathlib import Path
import re
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[1]
BANK = ROOT / 'cn-math-bank'


class DistributionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        source = (BANK / 'bank.js').read_text(encoding='utf-8')
        cls.browser = json.loads(source.split('window.CN_MATH_BANK = ', 1)[1].rstrip().removesuffix(';'))
        cls.records = {p.stem: json.loads(p.read_text(encoding='utf-8'))
                       for p in (BANK / 'questions').glob('*.json')}

    def test_browser_and_backend_use_same_questions_and_answers(self):
        self.assertEqual(len(self.records), 3355)
        self.assertEqual(len(self.browser['questions']), 3355)
        self.assertEqual({q['id'] for q in self.browser['questions']}, set(self.records))
        fields = {'question': 'Question', 'choices': 'Choices', 'answer': 'Correct Answer',
                  'solution': 'Solution', 'responseType': 'ResponseType'}
        for question in self.browser['questions']:
            record = self.records[question['id']]
            self.assertEqual(record['Bank'], 'cn-math')
            for display, stored in fields.items():
                self.assertEqual(question[display], record[stored], question['id'] + ': ' + display)

    def test_originals_and_attribution_are_preserved(self):
        for record in self.records.values():
            meta = record['Meta']
            self.assertTrue(meta['Original'])
            self.assertEqual(meta['License'], 'CC-BY-NC-4.0')
            for key in ('SourceURL', 'SourceRevision', 'Attribution', 'Modifications'):
                self.assertTrue(meta[key], record['ID'] + ': ' + key)
        self.assertTrue((BANK / 'LICENSE').is_file())
        self.assertTrue((BANK / 'NOTICE.md').is_file())

    def test_display_diagrams_exist(self):
        used = set()
        for question in self.browser['questions']:
            for text in [question['question'], question['solution'], *question['choices'].values()]:
                for relative in re.findall(r'\[Figure \d+\]\(([^)]+)\)', text):
                    target = (BANK / relative).resolve()
                    self.assertTrue(target.is_relative_to(BANK), relative)
                    self.assertTrue(target.is_file(), relative)
                    used.add(relative)
        self.assertEqual(len(used), 156)
        self.assertEqual(len(list((BANK / 'figures').glob('*_zh.svg'))), 156)

    @unittest.skipUnless((ROOT / '.git').exists(), 'Git metadata is absent from exported archives')
    def test_local_files_and_amc_cannot_be_added_normally(self):
        private_paths = [
            'math-practice/config.json', 'math-practice/config.tmp', '.local/server.log',
            '.env', 'math-practice/.env.local', 'scripts/__pycache__/cache.pyc',
            'math-practice/amc-bank.js', 'question bank/questions/example.json',
            'cn-math-bank/source/raw.json', 'cn-math-bank/reports/check.json',
            'math-practice/test/screenshots/example.png', 'unrelated-personal-file.txt',
        ]
        result = subprocess.run(['git', 'check-ignore', '-z', '--stdin'], cwd=ROOT,
                                input=('\0'.join(private_paths) + '\0').encode(),
                                capture_output=True, check=True)
        self.assertEqual(set(result.stdout.decode().rstrip('\0').split('\0')), set(private_paths))


if __name__ == '__main__':
    unittest.main()
