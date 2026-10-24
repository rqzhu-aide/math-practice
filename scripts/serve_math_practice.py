"""Serve Math Practice locally with automatic decision-model assessment.

Run with a shared Python installation, then open http://127.0.0.1:8877/.
The backend owns credentials, question context and the assessment rubrics.
Decision and speech connections use the Python standard library. Codex tests use
the shared openai-codex Python package and installed Codex runtime.
"""
import argparse
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import mimetypes
import os
from pathlib import Path
import urllib.parse
from student_assessment import AssessmentError, ModelConfig, StudentAssessment
from connection_settings import ConnectionSettings, SettingsError
from openai_connection import OpenAIConnection
from model_connections import model_status, test_speech, test_inference, transcribe, MAX_AUDIO_BYTES
from practice_tutor import review_submission
from question_banks import BankError, custom_asset_path

ROOT = Path(__file__).resolve().parents[1]
ENGINE_VERSION = 'public-v2'


def engine_instance(root=ROOT):
    return hashlib.sha256(str(root.resolve()).casefold().encode('utf-8')).hexdigest()


class Handler(BaseHTTPRequestHandler):
    def send_bytes(self, status, data, content_type, content_security_policy=None):
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(data)))
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Cache-Control', 'no-store')
        if content_security_policy:
            self.send_header('Content-Security-Policy', content_security_policy)
        self.end_headers()
        try:
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass  # The student may have changed questions and canceled the request.

    def error_json(self, status, message):
        self.send_bytes(status, json.dumps({'error': {'message': message}}).encode(), 'application/json')

    def local_request(self, strict=True):
        # Reject cross-site proxy use, including DNS rebinding to this loopback server.
        host = self.headers.get('Host', '')
        allowed = {f'127.0.0.1:{self.server.server_port}', f'localhost:{self.server.server_port}'}
        origin = self.headers.get('Origin')
        return (host in allowed and (not strict or (
                (origin is None or origin == 'http://' + host)
                and self.headers.get('Sec-Fetch-Site') != 'cross-site')))

    def assessment(self, kind='reasoning'):
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if not 0 < length <= 100_000:
                return self.error_json(413, 'The submission is too large or empty.')
            raw = self.rfile.read(length)
            # Match the other POST routes: unread bytes can reset Windows
            # connections before a rejected request receives its error.
            if not self.local_request():
                return self.error_json(403, 'Use the app from its local HTTP address.')
            attempt = json.loads(raw)
            if kind == 'signals':
                result = self.server.assessor.learning_signals(attempt)
            elif kind == 'tutor':
                result = review_submission(self.server.assessor, self.server.settings, self.server.openai, attempt)
            else:
                result = self.server.assessor.assess(attempt)
            result['decisionConfigured'] = self.server.assessor.config.configured
            result['inferenceConfigured'] = self.server.settings.inference_configured()
            self.send_bytes(200, json.dumps(result).encode(), 'application/json')
        except AssessmentError as exc:
            self.error_json(exc.status, str(exc))
        except (ValueError, TypeError):
            self.error_json(400, 'Submit a valid answer and reasoning.')

    def connection_action(self, route):
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if not 0 < length <= 30_000:
                return self.error_json(413, 'The connection settings are too large or empty.')
            # Consume the bounded body before rejecting headers. Closing with unread
            # POST bytes can reset Windows connections before the error arrives.
            raw = self.rfile.read(length)
            if not self.local_request():
                return self.error_json(403, 'Use the app from its local HTTP address.')
            if self.headers.get('Content-Type', '').split(';')[0].strip() != 'application/json':
                return self.error_json(415, 'Connection actions require application/json.')
            body = json.loads(raw)
            if not isinstance(body, dict):
                raise SettingsError('Send connection settings as an object.')
            if route == '/api/settings':
                result = self.server.settings.save(body)
                self.server.assessor = StudentAssessment(self.server.settings.decision_config())
            elif route == '/api/settings/compare':
                result = self.server.settings.compare_file(body)
            elif route == '/api/settings/reload':
                if not self.server.settings.path.is_file():
                    raise SettingsError('config.json is missing. Start Math Practice again to create it.')
                updated = ConnectionSettings(self.server.settings.path)
                self.server.settings = updated
                self.server.assessor = StudentAssessment(updated.decision_config())
                result = updated.public()
            elif route in ('/api/settings/decision/test', '/api/settings/jev/test'):
                result = self.server.settings.test_decision(body)
            elif route == '/api/settings/speech/test':
                result = test_speech(self.server.settings.speech_config(body))
            elif route == '/api/settings/inference/test':
                selected = self.server.settings.inference_config(body)
                if not self.server.settings.inference_configured(body):
                    result = model_status(ModelConfig())
                elif selected['provider'] == 'codex':
                    result = self.server.openai.test({key: selected[key] for key in ('model', 'effort')})
                else:
                    result = test_inference(ModelConfig(tuple(selected['bases']), selected['model'], selected['apiKey']))
            elif route == '/api/settings/openai/test':
                result = self.server.openai.test(self.server.settings.openai_config(body))
            elif route == '/api/connections/openai/login':
                result = self.server.openai.start_login()
            else:
                result = self.server.openai.cancel_login()
            self.send_bytes(200, json.dumps(result).encode(), 'application/json')
        except SettingsError as exc:
            self.error_json(400, str(exc))
        except AssessmentError as exc:
            self.error_json(exc.status, str(exc))
        except (ValueError, TypeError):
            self.error_json(400, 'Send valid connection settings.')

    def transcription(self):
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if not 0 < length <= MAX_AUDIO_BYTES:
                return self.error_json(413, 'Record up to one minute at a time.')
            audio = self.rfile.read(length)
            if not self.local_request():
                return self.error_json(403, 'Use the app from its local HTTP address.')
            if self.headers.get('Content-Type', '').split(';')[0].strip() != 'audio/wav':
                return self.error_json(415, 'Speech input requires PCM WAV audio.')
            result = transcribe(self.server.settings.speech_config(), audio)
            self.send_bytes(200, json.dumps(result).encode(), 'application/json')
        except AssessmentError as exc:
            self.error_json(exc.status, str(exc))
        except (ValueError, TypeError):
            self.error_json(400, 'Send a valid WAV recording.')

    def do_GET(self):
        parsed = urllib.parse.urlsplit(self.path)
        if parsed.path == '/api/engine':
            if not self.local_request():
                return self.error_json(403, 'Use the local app address.')
            return self.send_bytes(200, json.dumps({'application': 'math-practice', 'pid': os.getpid(),
                                                   'port': self.server.server_port, 'version': ENGINE_VERSION,
                                                   'instance': engine_instance(ROOT)}).encode(), 'application/json')
        if parsed.path in ('/api/status/decision', '/api/status/speech', '/api/status/inference'):
            if not self.local_request():
                return self.error_json(403, 'Use the local app address.')
            role = parsed.path.rsplit('/', 1)[1]
            if role == 'decision':
                result = model_status(self.server.settings.decision_config())
            elif role == 'speech':
                result = model_status(self.server.settings.speech_config())
            else:
                config = self.server.settings.inference_config()
                if not self.server.settings.inference_configured():
                    result = model_status(ModelConfig())
                elif config['provider'] == 'api':
                    result = model_status(ModelConfig(tuple(config['bases']), config['model'], config['apiKey']))
                else:
                    account = self.server.openai.status()
                    result = {'configured': True, 'ready': account['canTest'],
                              'label': 'Ready' if account['canTest'] else 'Sign in' if account['state'] == 'signed_out' else 'Setup needed',
                              'message': account['message'] + ' Readiness checks the account and SDK. Use Test inference in Settings to check a model response.'}
            return self.send_bytes(200, json.dumps(result).encode(), 'application/json')
        if parsed.path == '/api/status':
            if not self.local_request():
                return self.error_json(403, 'Use the local app address.')
            return self.send_bytes(200, json.dumps(self.server.assessor.status()).encode(), 'application/json')
        if parsed.path in ('/api/settings', '/api/connections/openai'):
            if not self.local_request():
                return self.error_json(403, 'Use the local app address.')
            result = (self.server.settings.public() if parsed.path == '/api/settings'
                      else self.server.openai.status())
            return self.send_bytes(200, json.dumps(result).encode(), 'application/json')
        if not self.local_request(strict=False):
            return self.error_json(403, 'Use the local app address.')
        relative = urllib.parse.unquote(parsed.path).lstrip('/')
        if not relative:
            self.send_response(302)
            self.send_header('Location', '/math-practice/')
            self.end_headers()
            return
        if relative in ('', 'math-practice', 'math-practice/'):
            relative = 'math-practice/index.html'
        if relative.startswith('custom-banks/'):
            try:
                asset = custom_asset_path(relative, ROOT)
            except BankError:
                asset = None
            if asset is None:
                return self.error_json(404, 'File not found.')
            if relative == 'custom-banks/banks.js':
                data = asset.read_bytes() if asset.is_file() else b'window.CUSTOM_MATH_BANKS = [];\n'
                return self.send_bytes(200, data, 'text/javascript; charset=utf-8')
            if not asset.is_file():
                return self.error_json(404, 'File not found.')
            return self.send_bytes(200, asset.read_bytes(), mimetypes.guess_type(asset.name)[0] or 'application/octet-stream',
                                   content_security_policy="sandbox; default-src 'none'; style-src 'unsafe-inline'")
        allowed = (relative in ('math-practice/index.html', 'cn-math-bank/bank.js',
                               'math-practice/answer-check.js',
                               'math-practice/settings.html', 'math-practice/settings.css', 'math-practice/settings.js',
                               'math-practice/theme.css', 'math-practice/theme.js',
                               'math-practice/speech-input.js', 'math-practice/speech-worklet.js', 'math-practice/practice-feedback.js')
                   or relative.startswith('math-practice/vendor/')
                   or relative.startswith('cn-math-bank/figures/'))
        path = (ROOT / relative).resolve()
        if not allowed or not path.is_relative_to(ROOT) or not path.is_file() or any(p.startswith('.') for p in Path(relative).parts):
            return self.error_json(404, 'File not found.')
        # Vendor and figure roots cannot escape their allowlisted subtree via '..'.
        if '..' in Path(relative).parts:
            return self.error_json(404, 'File not found.')
        data = path.read_bytes()
        content_type = mimetypes.guess_type(path.name)[0] or 'application/octet-stream'
        if relative.endswith('.html'):
            content_type = 'text/html; charset=utf-8'
        self.send_bytes(200, data, content_type)

    def do_POST(self):
        parsed = urllib.parse.urlsplit(self.path)
        if parsed.path == '/api/assessment':
            return self.assessment()
        if parsed.path == '/api/learning-signals':
            return self.assessment('signals')
        if parsed.path == '/api/tutor':
            return self.assessment('tutor')
        if parsed.path == '/api/transcription':
            return self.transcription()
        if parsed.path in ('/api/settings', '/api/settings/reload', '/api/settings/compare', '/api/settings/jev/test', '/api/settings/openai/test',
                           '/api/settings/decision/test', '/api/settings/speech/test', '/api/settings/inference/test',
                           '/api/connections/openai/login', '/api/connections/openai/cancel'):
            return self.connection_action(parsed.path)
        self.error_json(405, 'Unsupported route.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=8877)
    args = parser.parse_args()
    try:
        settings = ConnectionSettings()
        if not settings.path.exists():
            settings.save({})
    except SettingsError as exc:
        parser.error(str(exc))
    server = ThreadingHTTPServer(('127.0.0.1', args.port), Handler)
    server.settings = settings
    server.assessor = StudentAssessment(server.settings.decision_config())
    server.openai = OpenAIConnection(ROOT / '.local/codex-work')
    print(f'Math Practice: http://127.0.0.1:{server.server_port}/math-practice/', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.openai.close()
        server.server_close()


if __name__ == '__main__':
    main()
