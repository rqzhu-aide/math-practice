"""Portable runtime checks with temporary records and synthetic model responses."""
import io
import json
import os
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import MagicMock, patch
import urllib.error
import urllib.request

from connection_settings import ConnectionSettings, SettingsError
import launch_math_practice as launcher
from model_connections import model_status, test_inference, test_speech
from practice_tutor import review_submission
from serve_math_practice import ENGINE_VERSION, Handler, ThreadingHTTPServer, engine_instance
from student_assessment import AssessmentError, ModelConfig, StudentAssessment


QUESTION = {'ID': 'cnm_p001_q1', 'Bank': 'cn-math', 'ResponseType': 'numeric',
            'Question': 'What is 2 + 2?', 'Choices': {}, 'Correct Answer': '4',
            'Solution': 'Add two and two to get four.'}
ATTEMPT = {'questionId': QUESTION['ID'], 'answer': '4', 'thoughts': 'I added two and two.'}


class RuntimeFixture:
    def setUp(self):
        self.environment = patch.dict(os.environ, {}, clear=True)
        self.environment.start()
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.settings = ConnectionSettings(self.root / 'config.json')
        self.questions = self.root / 'questions'
        self.questions.mkdir()
        (self.questions / (QUESTION['ID'] + '.json')).write_text(json.dumps(QUESTION), encoding='utf-8')
        self.assessor = StudentAssessment(ModelConfig(), cn_bank_root=self.questions)

    def tearDown(self):
        self.temporary.cleanup()
        self.environment.stop()


class RuntimeTests(RuntimeFixture, unittest.TestCase):
    def test_defaults_and_partial_configuration_are_independent(self):
        public = self.settings.public()
        for role in ('decision', 'speech', 'inference'):
            self.assertFalse(public[role]['configured'])
            self.assertEqual(public[role]['bases'], [])
            self.assertEqual(public[role]['model'], '')
        self.assertEqual(public['inference']['provider'], 'api')
        self.settings.save({'decision': {'bases': ['https://decision.example/v1'], 'model': 'my-decision', 'apiKey': 'test-secret'}})
        restarted = ConnectionSettings(self.settings.path)
        self.assertTrue(restarted.decision_config().configured)
        self.assertFalse(restarted.speech_config().configured)
        self.assertFalse(restarted.inference_configured())
        self.assertNotIn('test-secret', json.dumps(restarted.public()))
        restarted.save({'speech': {'bases': ['https://speech.example'], 'model': ''}})
        self.assertFalse(restarted.speech_config().configured)
        restarted.save({'decision': {'bases': [], 'model': ''}})
        self.assertFalse(restarted.decision_config().configured)
        restarted.save({'inference': {'provider': 'codex', 'model': 'gpt-6.1-sol', 'effort': 'xhigh'}})
        self.assertTrue(restarted.inference_configured())

    def test_role_keys_never_inherit_from_other_roles_or_legacy_files(self):
        with patch.dict(os.environ, {'DECISION_API_KEY': 'decision-only'}):
            settings = ConnectionSettings(self.root / 'other.json')
        self.assertEqual(settings.decision_config().api_key, 'decision-only')
        self.assertEqual(settings.speech_config().api_key, '')
        with patch.dict(os.environ, {'JEV_BASE_URL': 'https://legacy.example', 'JEV_API_KEY': 'legacy-key'}):
            self.assertEqual(ModelConfig.from_environment(), ModelConfig())

    def test_no_model_paths_do_not_contact_services_or_accounts(self):
        with patch('student_assessment.OPENER.open', side_effect=AssertionError('No network request expected')):
            for status in (self.assessor.status(), model_status(ModelConfig()),
                           test_speech(ModelConfig()), test_inference(ModelConfig()),
                           self.settings.test_decision({})):
                self.assertFalse(status['configured'])
                self.assertFalse(status['ready'])
                self.assertEqual(status['label'], 'Not configured')
            result = self.assessor.assess(ATTEMPT)
            self.assertEqual(result['answerCategory'], 'correct')
            self.assertTrue(result['answerCorrect'])
            self.assertEqual(result['category'], 'cannot_judge')
            self.assertFalse(result['decisionConfigured'])
            self.assertFalse(result['modelUsed'])
            self.assertEqual(result['decisionRequests'], 0)
            signals = self.assessor.learning_signals({'questionId': QUESTION['ID'], 'transcript': 'I will try adding.'})
            self.assertEqual(signals['signals'], [])
        account = MagicMock()
        with patch('practice_tutor.question_images', side_effect=AssertionError('No image conversion expected')):
            result = review_submission(self.assessor, self.settings, account, ATTEMPT)
        self.assertFalse(result['configured'])
        self.assertEqual(result['answerCategory'], 'correct')
        account.infer.assert_not_called()

    def test_configured_decision_and_inference_still_use_selected_models(self):
        assessor = StudentAssessment(ModelConfig(('https://decision.example',), 'my-model'), cn_bank_root=self.questions)
        judgment = lambda rubric: [{'id': rubric, 'code': 'correct'}]
        with patch.object(assessor, '_decide', side_effect=[judgment('correctness'), judgment('answer_correctness')]) as decide:
            result = assessor.assess(ATTEMPT)
        self.assertEqual(result['category'], 'correct')
        self.assertTrue(result['decisionConfigured'])
        self.assertTrue(result['modelUsed'])
        self.assertEqual(decide.call_count, 2)
        self.settings.save({'inference': {'provider': 'api', 'bases': ['https://inference.example/v1'], 'model': 'my-inference'}})
        reply = {'choices': [{'message': {'content': json.dumps({'category': 'correct', 'answerCategory': 'correct', 'clarification': '', 'hint': ''})}}]}
        with patch('practice_tutor.request', return_value=reply) as request:
            result = review_submission(assessor, self.settings, MagicMock(), {**ATTEMPT, 'category': 'cannot_judge', 'answerCategory': 'correct'})
        self.assertTrue(result['inferenceConfigured'])
        self.assertEqual(request.call_args.args[0].model, 'my-inference')
        self.assertEqual(request.call_args.args[1], '/v1/chat/completions')

    def test_invalid_nonempty_configuration_is_rejected(self):
        for section in ({'bases': ['file:///secret']}, {'model': '../invalid'}, {'bases': ['https://user:pass@example.test']}):
            with self.subTest(section=section), self.assertRaises(SettingsError):
                self.settings.save({'decision': section})

    def test_engine_reuse_requires_same_distribution_and_checkout(self):
        response = {'application': 'math-practice', 'pid': 123, 'version': ENGINE_VERSION,
                    'instance': engine_instance(launcher.ROOT)}
        def probe(value):
            handle = MagicMock()
            handle.__enter__.return_value = io.BytesIO(json.dumps(value).encode())
            with patch.object(launcher.OPENER, 'open', return_value=handle):
                return launcher.engine('http://127.0.0.1:8877')
        self.assertEqual(probe(response), response)
        for modified in ({'version': 'legacy'}, {'instance': 'other-checkout'}):
            self.assertIsNone(probe({**response, **modified}))
        self.assertIsNone(probe({'application': 'math-practice', 'pid': 123}))

    def test_launcher_opens_practice_without_automatic_model_tests(self):
        self.settings.save({})
        response = MagicMock()
        response.__enter__.return_value = io.BytesIO(b'{}')
        with patch('connection_settings.ConnectionSettings', return_value=self.settings), \
             patch.object(launcher, 'engine', return_value={'pid': 123}), \
             patch.object(launcher.OPENER, 'open', return_value=response) as request, \
             patch.object(launcher.webbrowser, 'open') as browser:
            result = launcher.launch(open_browser=True)
        self.assertEqual(result['url'], 'http://127.0.0.1:8877/math-practice/')
        browser.assert_called_once_with(result['url'])
        self.assertEqual(request.call_count, 1)
        self.assertTrue(request.call_args.args[0].full_url.endswith('/api/settings/reload'))


class QuietHandler(Handler):
    def log_message(self, *args):
        pass


class HttpRuntimeTests(RuntimeFixture, unittest.TestCase):
    def setUp(self):
        super().setUp()
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), QuietHandler)
        self.server.settings = self.settings
        self.server.assessor = self.assessor
        self.server.openai = MagicMock()
        self.worker = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.worker.start()
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        self.base = f'http://127.0.0.1:{self.server.server_port}'

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.worker.join()
        super().tearDown()

    def request(self, path, body=None):
        data = None if body is None else json.dumps(body).encode()
        request = urllib.request.Request(self.base + path, data=data, headers={'Content-Type': 'application/json'})
        try:
            with self.opener.open(request, timeout=5) as response:
                return response.status, json.load(response)
        except urllib.error.HTTPError as exc:
            with exc:
                return exc.code, json.load(exc)

    def test_http_no_model_assessment_status_and_tutor(self):
        for role in ('decision', 'speech', 'inference'):
            code, value = self.request('/api/status/' + role)
            self.assertEqual(code, 200)
            self.assertFalse(value['configured'])
        code, value = self.request('/api/assessment', ATTEMPT)
        self.assertEqual(code, 200)
        self.assertTrue(value['answerCorrect'])
        self.assertFalse(value['decisionConfigured'])
        self.assertFalse(value['inferenceConfigured'])
        code, value = self.request('/api/settings/inference/test', {})
        self.assertEqual(code, 200)
        self.assertFalse(value['configured'])
        code, value = self.request('/api/tutor', ATTEMPT)
        self.assertEqual(code, 200)
        self.assertFalse(value['configured'])
        self.server.openai.status.assert_not_called()
        self.server.openai.infer.assert_not_called()

    def test_http_engine_identity_and_independent_settings(self):
        code, value = self.request('/api/engine')
        self.assertEqual(code, 200)
        self.assertEqual(value['version'], ENGINE_VERSION)
        self.assertEqual(value['instance'], engine_instance())
        code, value = self.request('/api/settings', {'speech': {'bases': ['https://speech.example'], 'model': 'my-asr', 'apiKey': 'speech-secret'}})
        self.assertEqual(code, 200)
        self.assertTrue(value['speech']['configured'])
        self.assertFalse(value['decision']['configured'])
        self.assertFalse(value['inference']['configured'])
        self.assertNotIn('speech-secret', json.dumps(value))

    def test_private_and_legacy_paths_are_not_served(self):
        for path in ('/math-practice/config.json', '/scripts/student_assessment.py',
                     '/math-practice/amc-bank.js', '/question%20bank/figures/example.png'):
            self.assertEqual(self.request(path)[0], 404)
        self.assertEqual(self.request('/api/assessment', {**ATTEMPT, 'questionId': '9999_AMC_8_Q01'})[0], 404)


if __name__ == '__main__':
    unittest.main()
