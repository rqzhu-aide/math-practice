"""Small real connection probes for transcription and compatible inference APIs."""
import io
import json
import re
import time
import urllib.error
import urllib.request
import uuid
import wave

from student_assessment import AssessmentError, OPENER


def request(config, route, data, content_type, timeout=60):
    if not config.configured:
        raise AssessmentError('This model is not configured. Enter its server address and model ID in Settings.', 503)
    headers = {'Content-Type': content_type, 'Accept': 'application/json'}
    if config.api_key:
        headers['Authorization'] = 'Bearer ' + config.api_key
    unauthorized = False
    deadline = time.monotonic() + timeout
    for base in config.bases:
        path = route[3:] if base.endswith('/v1') and route.startswith('/v1/') else route
        try:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            with OPENER.open(urllib.request.Request(base + path, data=data, headers=headers), timeout=remaining) as response:
                return json.load(response)
        except urllib.error.HTTPError as exc:
            unauthorized |= exc.code in (401, 403)
            exc.close()
        except (OSError, ValueError):
            pass
    if unauthorized:
        raise AssessmentError('The service rejected the credentials. Check its API key.', 503)
    raise AssessmentError('The service could not complete the request. Check the address, model ID, API support, and connection in Settings.', 503)


def model_status(config):
    """Check the saved model and credentials without generating a response."""
    if not config.configured:
        return {'configured': False, 'ready': False, 'label': 'Not configured',
                'message': 'Enter a server address and model ID to enable this optional connection.'}
    try:
        reply = request(config, '/v1/models', None, 'application/json', timeout=8)
        models = reply.get('data') if isinstance(reply, dict) else None
        if not isinstance(models, list) or not any(isinstance(item, dict) and item.get('id') == config.model for item in models):
            return {'configured': True, 'ready': False, 'label': 'Model unavailable',
                    'message': 'The service did not list the configured model. Check its model ID in Settings.'}
        return {'configured': True, 'ready': True, 'label': 'Ready',
                'message': 'The service lists the configured model and accepted the connection. Use its test in Settings to check a real response.'}
    except AssessmentError as exc:
        return {'configured': True, 'ready': False, 'label': 'Offline', 'message': str(exc)}


def test_speech(config):
    if not config.configured:
        return model_status(config)
    started = time.monotonic()
    audio = io.BytesIO()
    with wave.open(audio, 'wb') as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(16000)
        wav.writeframes(b'\0\0' * 16000)
    transcript = speech_reply(config, audio.getvalue())
    return {'ready': True, 'message': 'Speech service accepted a one-second silent WAV. This checks the connection, not speech accuracy.',
            'model': config.model, 'elapsedMs': round((time.monotonic() - started) * 1000), 'transcript': transcript}


def speech_reply(config, audio, timeout=60):
    boundary = 'math-practice-' + uuid.uuid4().hex
    parts = []
    for name, value in (('model', config.model), ('temperature', '0')):
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode())
    parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="thinking.wav"\r\nContent-Type: audio/wav\r\n\r\n'.encode()
                 + audio + f'\r\n--{boundary}--\r\n'.encode())
    reply = request(config, '/v1/audio/transcriptions', b''.join(parts), 'multipart/form-data; boundary=' + boundary, timeout)
    if not isinstance(reply, dict) or not isinstance(reply.get('text'), str):
        raise AssessmentError('The speech service did not return a text transcript. Check transcription API support.', 502)
    return re.sub(r'^\s*language\s+\S+\s*<asr_text>', '', reply['text'], flags=re.I).strip()


MAX_AUDIO_BYTES = 2_000_000
MAX_RECORDING_SECONDS = 60


def transcribe(config, audio):
    """Accept browser PCM WAV, split near pauses to respect the service's 26s limit."""
    started = time.monotonic()
    try:
        with wave.open(io.BytesIO(audio), 'rb') as wav:
            if (wav.getnchannels(), wav.getsampwidth(), wav.getframerate(), wav.getcomptype()) != (1, 2, 16000, 'NONE'):
                raise ValueError()
            frames = wav.getnframes()
            if not 1600 <= frames <= 16000 * MAX_RECORDING_SECONDS:
                raise ValueError()
            pcm = wav.readframes(frames)
            if len(pcm) != frames * 2:
                raise ValueError()
    except (wave.Error, EOFError, ValueError, OSError):
        raise AssessmentError('Record between a moment and one minute of 16 kHz mono PCM WAV audio.', 400) from None
    # A short energy window chooses the quietest boundary in the last six seconds.
    # Every request remains <=26s even when the speaker never pauses.
    import struct
    words, start, chunks = [], 0, 0
    while start < frames:
        end = min(frames, start + 26 * 16000)
        if end < frames:
            candidates = range(end - 6 * 16000, end + 1, 4000)
            end = min(candidates, key=lambda boundary: sum(
                sample[0] ** 2 for sample in struct.iter_unpack('<h', pcm[(boundary - 4000) * 2:boundary * 2])))
        segment = io.BytesIO()
        with wave.open(segment, 'wb') as wav:
            wav.setnchannels(1); wav.setsampwidth(2); wav.setframerate(16000)
            wav.writeframes(pcm[start * 2:end * 2])
        remaining = 120 - (time.monotonic() - started)
        if remaining <= 0:
            raise AssessmentError('Transcription took too long. Your recording is available to retry.', 504)
        words.append(speech_reply(config, segment.getvalue(), timeout=remaining))
        start = end
        chunks += 1
    text = ' '.join(word for word in words if word).strip()
    if len(text) > 12000:
        raise AssessmentError('This transcript is too long. Try a shorter explanation.', 502)
    return {'text': text, 'model': config.model, 'chunks': chunks,
            'elapsedMs': round((time.monotonic() - started) * 1000)}


def test_inference(config):
    if not config.configured:
        return model_status(config)
    started = time.monotonic()
    body = {'model': config.model, 'messages': [{'role': 'user', 'content': 'Reply with MATH_PRACTICE_OK.'}], 'max_tokens': 32}
    reply = request(config, '/v1/chat/completions', json.dumps(body).encode(), 'application/json')
    try:
        text = reply['choices'][0]['message']['content']
        if not isinstance(text, str) or not text.strip():
            raise ValueError('Empty response')
    except (KeyError, IndexError, TypeError, ValueError):
        raise AssessmentError('The inference API returned no text. Check the selected model and chat-completions support.', 502) from None
    return {'ready': True, 'message': 'Inference model returned a text response.',
            'model': config.model, 'elapsedMs': round((time.monotonic() - started) * 1000)}
