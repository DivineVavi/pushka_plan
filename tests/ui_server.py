"""Isolated offline HTTP server for browser regressions; never read a real .env."""
import os
import signal
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from http.server import ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from pushka.server import App, handler
from pushka.catalog import demo_rows


def main():
    artifacts = ROOT / '.pi'
    artifacts.mkdir(exist_ok=True)
    os.environ['CULTURE_SOURCE_MODE'] = 'snapshot'
    os.environ['DEMO_COOKIE_KEY'] = 'ui-test-only-key-not-for-deployment'
    os.environ.pop('CATALOG_SNAPSHOT_PATH', None)
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    with tempfile.TemporaryDirectory(prefix='ui-tests-', dir=artifacts) as directory:
        app = App(Path(directory) / 'test.sqlite3')  # No token, no background tasks.
        # Modeled, future-dated sessions keep UI regressions independent of the
        # shipped snapshot's dates. These rows never leave the disposable DB.
        now = datetime.now(timezone.utc)
        stamp = (now - timedelta(hours=13)).isoformat()
        rows = [{**row, 'source': 'culture-public',
                 'sourceUrl': 'https://www.culture.ru/events/7219156/koncert-da-zdravstvuet-meksika',
                 'exactPriceKnown': False, 'endEstimated': True, 'fetchedAt': stamp} for row in demo_rows(now)]
        app.store.replace_catalog(rows, {'kind': 'culture-public-prepared',
            'label': 'Подготовленный тестовый снимок Культура.РФ', 'fetchedAt': stamp})
        server = ThreadingHTTPServer(('127.0.0.1', int(os.getenv('PUSHKA_UI_PORT', '8016'))), handler(app))
        try:
            server.serve_forever()
        finally:
            server.server_close()


if __name__ == '__main__':
    main()
