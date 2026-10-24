"""Start or reuse this checkout's local engine, then open practice."""
import argparse
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
import webbrowser
from serve_math_practice import ENGINE_VERSION, engine_instance

ROOT = Path(__file__).resolve().parents[1]
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def engine(base):
    try:
        with OPENER.open(base + '/api/engine', timeout=2) as response:
            value = json.load(response)
        if (value.get('application') == 'math-practice' and isinstance(value.get('pid'), int)
                and value.get('version') == ENGINE_VERSION
                and value.get('instance') == engine_instance(ROOT)):
            return value
    except (OSError, ValueError, AttributeError):
        pass
    return None


def port_available(port):
    try:
        with socket.socket() as listener:
            listener.bind(('127.0.0.1', port))
        return True
    except OSError:
        return False


def launch(port=8877, open_browser=True):
    if not 1 <= port <= 65535:
        raise RuntimeError('Choose a port between 1 and 65535.')
    # Validate the local configuration before starting or reusing this engine.
    from connection_settings import ConnectionSettings, SettingsError
    try:
        settings = ConnectionSettings()
        if not settings.path.exists():
            settings.save({})
    except SettingsError as exc:
        raise RuntimeError(str(exc)) from None
    base = f'http://127.0.0.1:{port}'
    running = engine(base)
    if running is None:
        if not port_available(port):
            raise RuntimeError(f'Port {port} is already in use by another application or an older Math Practice engine. Close that engine and try again.')
        logs = ROOT / '.local'
        logs.mkdir(parents=True, exist_ok=True)
        with (logs / 'launcher-output.log').open('ab') as output, (logs / 'launcher-errors.log').open('ab') as errors:
            process = subprocess.Popen([sys.executable, str(ROOT / 'scripts/serve_math_practice.py'), '--port', str(port)],
                                       cwd=ROOT, stdin=subprocess.DEVNULL, stdout=output, stderr=errors,
                                       creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0,
                                       start_new_session=os.name != 'nt')
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            running = engine(base)
            if running is not None:
                break
            if process.poll() is not None:
                raise RuntimeError('The local engine could not start. See .local/launcher-errors.log.')
            time.sleep(.2)
        else:
            raise RuntimeError('The local engine did not become ready. See .local/launcher-errors.log.')
    # Repeated clicks use the same engine and pick up file edits without a restart.
    request = urllib.request.Request(base + '/api/settings/reload', data=b'{}',
                                     headers={'Content-Type': 'application/json'})
    try:
        with OPENER.open(request, timeout=5) as response:
            response.read()
    except (OSError, ValueError):
        raise RuntimeError('The engine could not reload config.json. Check the file, then try again.') from None
    url = base + '/math-practice/'
    if open_browser:
        webbrowser.open(url)
    return {'url': url, 'pid': running['pid']}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=8877)
    parser.add_argument('--no-open', action='store_true', help='Start the engine without opening a browser.')
    args = parser.parse_args()
    try:
        result = launch(args.port, not args.no_open)
    except RuntimeError as exc:
        print(str(exc), file=sys.stderr)
        return 1
    print(json.dumps(result))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
