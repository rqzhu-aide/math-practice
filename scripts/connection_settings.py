"""Local model connections. Secret values never appear in public settings."""
import json
import math
import os
from pathlib import Path
import re
import threading
import time
import urllib.parse

from student_assessment import AssessmentError, ModelConfig, StudentAssessment

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_PATH = ROOT / 'math-practice/config.json'
DEFAULT_OPENAI = {'model': '', 'effort': 'medium'}
EFFORTS = ('low', 'medium', 'high', 'xhigh', 'max')


class SettingsError(ValueError):
    pass


def model_id(value):
    if value == '':
        return value
    if not isinstance(value, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}', value):
        raise SettingsError('Enter a valid model ID.')
    return value


def server_bases(value):
    if not isinstance(value, list) or not 0 <= len(value) <= 5:
        raise SettingsError('Enter up to five server addresses, one per line. Leave empty to disable this connection.')
    result = []
    for address in value:
        if not isinstance(address, str) or len(address) > 800:
            raise SettingsError('Enter a valid HTTP or HTTPS server address.')
        address = address.strip().rstrip('/')
        try:
            parts = urllib.parse.urlsplit(address)
            parts.port
        except ValueError:
            raise SettingsError('Check the server address and port.') from None
        if (parts.scheme not in ('http', 'https') or not parts.hostname or parts.username
                or parts.password or parts.query or parts.fragment or any(c.isspace() for c in address)):
            raise SettingsError('Use an HTTP or HTTPS server address without credentials, a query, or a fragment.')
        if address not in result:
            result.append(address)
    return tuple(result)


def api_key(value, previous):
    if not isinstance(value, str) or len(value) > 4096 or '\n' in value or '\r' in value:
        raise SettingsError('Enter a valid API key.')
    return value.strip() or previous


def http_config(patch, previous):
    return ModelConfig(server_bases(patch.get('bases', list(previous.bases))),
                       model_id(patch.get('model', previous.model)),
                       api_key(patch.get('apiKey', ''), previous.api_key))


def public_http(config):
    return {'bases': list(config.bases), 'model': config.model, 'keyConfigured': bool(config.api_key),
            'configured': config.configured}


def saved_http(config):
    return {'bases': list(config.bases), 'model': config.model, 'apiKey': config.api_key}


class ConnectionSettings:
    def __init__(self, path=None, defaults=None):
        self.path = Path(path) if path is not None else DEFAULT_PATH
        self._lock = threading.RLock()
        self._decision = defaults or ModelConfig.from_environment()
        self._speech = ModelConfig(
            server_bases([os.environ['SPEECH_BASE_URL']]) if os.environ.get('SPEECH_BASE_URL') else (),
            os.environ.get('SPEECH_MODEL', '').strip(), os.environ.get('SPEECH_API_KEY', '').strip())
        self._inference = {'provider': 'api', **DEFAULT_OPENAI, 'bases': [], 'apiKey': ''}
        self.notice = ''
        if self.path.is_file():
            try:
                saved = json.loads(self.path.read_text(encoding='utf-8-sig'))
                self._decision, self._speech, self._inference = self._merge(saved)
            except (OSError, ValueError, TypeError, AttributeError):
                raise SettingsError(f'Connection settings could not be read. Check {self.path.name} for valid JSON and model settings.') from None

    def _merge(self, patch):
        if not isinstance(patch, dict):
            raise SettingsError('Send settings as an object.')
        decision = patch.get('decision', patch.get('jev', {}))
        speech = patch.get('speech', {})
        inference = patch.get('inference', patch.get('openai', {}))
        if not all(isinstance(section, dict) for section in (decision, speech, inference)):
            raise SettingsError('Send connection settings as objects.')
        selection = {key: inference.get(key, value) for key, value in self._inference.items()}
        if selection['provider'] not in ('codex', 'api'):
            raise SettingsError('Choose Codex account or a compatible API connection.')
        selection['model'] = model_id(selection['model'])
        if selection['effort'] not in EFFORTS:
            raise SettingsError('Choose a supported reasoning effort.')
        selection['apiKey'] = api_key(inference.get('apiKey', ''), self._inference['apiKey'])
        bases = selection['bases']
        selection['bases'] = list(server_bases(bases))
        return http_config(decision, self._decision), http_config(speech, self._speech), selection

    def public(self):
        with self._lock:
            inference = {key: value for key, value in self._inference.items() if key != 'apiKey'}
            inference['bases'] = list(inference['bases'])
            inference['keyConfigured'] = bool(self._inference['apiKey'])
            inference['configured'] = self.inference_configured()
            return {'decision': public_http(self._decision), 'speech': public_http(self._speech),
                    'inference': inference, 'notice': self.notice,
                    # Compatibility with an already-open older settings page.
                    'jev': public_http(self._decision), 'openai': self.openai_config()}

    def decision_config(self, patch=None):
        with self._lock:
            return self._merge(patch or {})[0]

    jev_config = decision_config

    def speech_config(self, patch=None):
        with self._lock:
            return self._merge(patch or {})[1]

    def inference_config(self, patch=None):
        with self._lock:
            return dict(self._merge(patch or {})[2])

    def inference_configured(self, patch=None):
        selection = self.inference_config(patch)
        return bool(selection['model'] and (selection['provider'] == 'codex' or selection['bases']))

    def openai_config(self, patch=None):
        selection = self.inference_config(patch)
        return {key: selection[key] for key in ('model', 'effort')}

    def compare_file(self, patch):
        """Compare entered settings with disk without exposing keys or applying changes."""
        if not isinstance(patch, dict):
            raise SettingsError('Send settings as an object.')
        with self._lock:
            exists = self.path.is_file()
            saved = ConnectionSettings(self.path) if exists else self
            previous = saved._merge({})
            changed = []
            for index, section in enumerate(('decision', 'speech', 'inference')):
                if section not in patch:
                    continue
                try:
                    candidate = saved._merge({section: patch[section]})[index]
                    different = not exists or candidate != previous[index]
                except SettingsError:
                    different = True  # Incomplete edits still need saving or correction.
                if different:
                    changed.append(section)
            return {'different': bool(changed), 'changedSections': changed}

    def save(self, patch):
        with self._lock:
            # Preserve file edits and credentials in sections omitted by this save.
            saved = ConnectionSettings(self.path) if self.path.is_file() else self
            decision, speech, inference = saved._merge(patch)
            document = {'decision': saved_http(decision), 'speech': saved_http(speech), 'inference': inference}
            self.path.parent.mkdir(parents=True, exist_ok=True)
            temporary = self.path.with_suffix('.tmp')
            try:
                fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
                with os.fdopen(fd, 'w', encoding='utf-8') as handle:
                    json.dump(document, handle, indent=2)
                    handle.write('\n')
                os.replace(temporary, self.path)
            except OSError:
                raise SettingsError('Connection settings could not be saved. Check write access to the local settings folder.') from None
            self._decision, self._speech, self._inference = decision, speech, inference
            self.notice = ''
            return self.public()

    def test_decision(self, patch):
        assessor = StudentAssessment(self.decision_config(patch))
        if not assessor.config.configured:
            return {'configured': False, 'ready': False, 'label': 'Not configured',
                    'message': 'Enter a decision server address and model ID to test this connection.'}
        started = time.monotonic()
        try:
            base = assessor._select_host()
            reply = assessor._request(base, '/v1/systemone', {
                'model': assessor.config.model,
                'state': 'Connection test only. The student wrote: "I am unsure how to begin."',
                'questions': {'connection': {'type': 'choice', 'instructions': 'Which statement matches the student text?',
                              'criteria': {'a': 'The student expresses uncertainty.', 'b': 'The student expresses certainty.'}}},
            }, timeout=45)
            choice = reply['answers']['connection']
            scores = choice['probabilities']
            if (choice.get('choice') not in ('a', 'b') or set(scores) != {'a', 'b'}
                    or not all(isinstance(v, (int, float)) and not isinstance(v, bool)
                               and math.isfinite(v) and 0 <= v <= 1 for v in scores.values())
                    or abs(sum(scores.values()) - 1) > .02):
                raise ValueError('Unexpected test response')
        except AssessmentError:
            raise
        except Exception:
            raise AssessmentError('The decision model did not complete the test. Check the address, key, model ID, and decision API support.', 502) from None
        return {'configured': True, 'ready': True, 'message': 'Decision model completed the test.',
                'model': assessor.config.model, 'elapsedMs': round((time.monotonic() - started) * 1000)}

    test_jev = test_decision
