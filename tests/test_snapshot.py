"""Submission contracts: safe offline seeding, privacy, purchases and restart."""
import os
import sqlite3
import tempfile
import unittest
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

from catalog_fixture import demo_rows
from pushka.server import App
from pushka.snapshot import DEFAULT_SNAPSHOT, export_catalog, load_catalog_snapshot, read_snapshot
from pushka.store import Store
from test_pushka import profile


@contextmanager
def block_network():
    blocked = AssertionError('unexpected network access during snapshot startup')
    with patch('urllib.request.urlopen', side_effect=blocked) as urlopen, \
         patch('socket.create_connection', side_effect=blocked) as create_connection, \
         patch('socket.socket.connect', side_effect=blocked) as socket_connect:
        yield urlopen, create_connection, socket_connect


def prepared_public_rows(now):
    fetched_at = now.isoformat()
    return [{**row, 'source':'culture-public',
             'sourceUrl':'https://www.culture.ru/events/7219156/koncert-da-zdravstvuet-meksika',
             'fetchedAt':fetched_at, 'exactPriceKnown':False}
            for row in demo_rows(now)]


class SnapshotTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.source = Path(self.tmp.name) / 'source.sqlite3'
        self.snapshot = Path(self.tmp.name) / 'catalog.sqlite3'
        self.target = Path(self.tmp.name) / 'application.sqlite3'
        self.now = datetime.now(timezone.utc)
        store = Store(self.source)
        self.rows = prepared_public_rows(self.now)
        store.replace_catalog(self.rows, {'kind':'culture-public-prepared', 'fetchedAt':self.now.isoformat(),
                                          'sourceUrl':'https://www.culture.ru/afisha/moskva/pushkinskaya-karta'})
        # These must never reach the distributable database, including its free pages.
        store.update_user('private-user', profile='PRIVATE-PROFILE', draft='PRIVATE-DRAFT')
        with store.db() as db:
            db.execute("INSERT INTO purchases VALUES ('private-user','private-session',100,'{}')")
            db.execute("INSERT INTO app_config VALUES ('secret','PRIVATE-SECRET')")
            db.execute("INSERT INTO meta VALUES ('private-extra','\"PRIVATE-METADATA\"')")
        export_catalog(self.source, self.snapshot)
        self.env = {'MAX_BOT_TOKEN':'', 'MAX_WEBHOOK_SECRET':'', 'DEMO_COOKIE_KEY':'',
                    'PRO_API_KEY':'unused-secret', 'PRO_SNAPSHOT_PATH':'must-not-be-opened'}

    def test_export_contains_only_catalogue_and_no_private_bytes(self):
        with sqlite3.connect(self.snapshot) as db:
            tables = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            self.assertEqual(tables, {'events','venues','sessions','meta'})
            self.assertEqual(db.execute('PRAGMA integrity_check').fetchone()[0], 'ok')
            self.assertEqual(db.execute('PRAGMA foreign_key_check').fetchall(), [])
            self.assertEqual(db.execute('SELECT count(*) FROM sessions').fetchone()[0], 10)
        for private in (b'PRIVATE-PROFILE', b'PRIVATE-DRAFT', b'PRIVATE-SECRET', b'PRIVATE-METADATA', b'private-user'):
            self.assertNotIn(private, self.snapshot.read_bytes())
        # Export did not mutate the source or remove its users.
        self.assertEqual(Store(self.source).user('private-user')['profile'], 'PRIVATE-PROFILE')

    def test_first_start_imports_snapshot_and_ignores_legacy_source_mode_offline(self):
        with patch.dict(os.environ, {**self.env, 'CULTURE_SOURCE_MODE':'demo'}), block_network() as network:
            app = App(self.target)
            self.assertFalse(app.token)
            state = app.state_for_app('judge')
            self.assertEqual(state['source']['kind'], 'culture-public-prepared')
            self.assertEqual(state['source']['fetchedAt'], '2026-09-28T20:54:34.601079+00:00')
            self.assertNotEqual(state['source']['kind'], 'simulated')
            self.assertEqual(len(app.store.catalog()), 6786)
            for mock in network:
                mock.assert_not_called()

    def test_snapshot_background_does_not_sync_even_if_api_key_is_present(self):
        with patch.dict(os.environ, {**self.env, 'CULTURE_SOURCE_MODE':'pro-culture'}), block_network() as network:
            app = App(self.target)
            self.assertFalse(app.token)
            with patch('pushka.server.time.sleep', side_effect=[None, StopIteration]):
                with self.assertRaises(StopIteration):
                    app.background()
            for mock in network:
                mock.assert_not_called()
            self.assertEqual(app.store.meta()['kind'], 'culture-public-prepared')

    def test_purchase_selected_plan_and_browser_identity_survive_restart(self):
        with patch.dict(os.environ, self.env), block_network():
            app = App(self.target)
        app.store.replace_catalog(self.rows, {'kind':'culture-public-prepared',
            'label':'Подготовленный тестовый снимок Культура.РФ',
            'sourceUrl':'https://www.culture.ru/afisha/moskva/pushkinskaya-karta',
            'fetchedAt':self.now.isoformat()})
        uid, cookie = app.identity({})
        headers = {'Cookie':cookie.split(';', 1)[0]}
        p = profile(planningDeadline=(self.now+timedelta(days=60)).date().isoformat())
        state = app.dispatch('PUT', '/api/profile', p, uid)
        first = state['plans']['interest']['items'][0]
        selected = app.dispatch('POST', '/api/selected-plan', {'mode':'interest'}, uid)
        self.assertFalse(selected['selectedPlan']['needsConfirmation'])
        bought = app.dispatch('POST', '/api/purchase', {'sessionId':first['id'], 'actualPrice':first['price']+100}, uid)
        self.assertEqual(bought['remainingBalance'], 3200-first['price']-100)
        # A restart with existing catalogue/user data must not need the bundled seed.
        with patch('pushka.server.DEFAULT_SNAPSHOT', Path(self.tmp.name)/'removed-snapshot.sqlite3'), block_network():
            restarted = App(self.target)
        self.assertEqual(restarted.identity(headers), (uid, None))
        state = restarted.dispatch('GET', '/api/state', None, uid)
        self.assertEqual(state['purchased'], bought['purchased'])
        self.assertEqual(state['profile'], bought['profile'])
        self.assertEqual(state['selectedPlan'], bought['selectedPlan'])
        self.assertEqual(state['remainingBalance'], bought['remainingBalance'])
        for mode in state['plans'].values():
            self.assertTrue(any(i['id']==first['id'] and i['purchased'] for i in mode['items']))

    def test_bad_snapshot_fails_explicitly_without_resetting_user_data(self):
        self.snapshot.write_bytes(b'not sqlite')
        store = Store(self.target)
        store.update_user('existing-user', draft='keep me')
        with self.assertRaisesRegex(ValueError, 'snapshot'):
            load_catalog_snapshot(store, self.snapshot)
        self.assertEqual(store.meta(), {})
        self.assertEqual(store.catalog(), [])
        self.assertEqual(store.user('existing-user')['draft'], 'keep me')

    def test_missing_snapshot_on_new_database_has_actionable_error(self):
        store = Store(self.target)
        with self.assertRaisesRegex(ValueError, 'snapshot'):
            load_catalog_snapshot(store, Path(self.tmp.name)/'missing.sqlite3')
        self.assertEqual(store.catalog(), [])
        self.assertEqual(store.meta(), {})

    def test_missing_snapshot_does_not_reset_existing_catalogue(self):
        store = Store(self.target)
        load_catalog_snapshot(store, self.snapshot)
        before = store.catalog()
        self.assertEqual(load_catalog_snapshot(store, Path(self.tmp.name)/'missing.sqlite3'), 0)
        self.assertEqual(store.catalog(), before)

    def test_simulated_catalogue_snapshot_is_rejected_as_runtime_data(self):
        simulated = Path(self.tmp.name) / 'simulated.sqlite3'
        Store(simulated).replace_catalog(demo_rows(self.now), {
            'kind':'simulated', 'label':'Только тестовые вымышленные события',
            'fetchedAt':self.now.isoformat()})
        with self.assertRaisesRegex(ValueError, 'Unsupported catalogue snapshot source'):
            read_snapshot(simulated)

    def test_shipped_snapshot_is_only_public_catalogue_and_has_expected_provenance(self):
        rows, source = read_snapshot(DEFAULT_SNAPSHOT)
        self.assertEqual(len(rows), 6786)
        self.assertEqual(source['fetchedAt'], '2026-09-28T20:54:34.601079+00:00')
        self.assertEqual({r['localeId'] for r in rows}, {'Москва'})
        self.assertEqual({r['source'] for r in rows}, {'culture-public'})
        with sqlite3.connect(DEFAULT_SNAPSHOT) as db:
            self.assertEqual({r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")},
                             {'events','venues','sessions','meta'})
            self.assertEqual(db.execute('SELECT count(*) FROM events').fetchone()[0], 1753)
            self.assertEqual(db.execute('SELECT count(*) FROM venues').fetchone()[0], 1786)
        for private_field in (b'CREATE TABLE users', b'CREATE TABLE purchases', b'CREATE TABLE app_config',
                              b'"maxBalance":', b'"planningDeadline":', b'"actualPrice":', b'demo_cookie_key'):
            self.assertNotIn(private_field, DEFAULT_SNAPSHOT.read_bytes())

    def test_export_refuses_to_overwrite_the_source(self):
        with self.assertRaises(ValueError):
            export_catalog(self.source, self.source)
        self.assertEqual(Store(self.source).user('private-user')['profile'], 'PRIVATE-PROFILE')


if __name__ == '__main__':
    unittest.main()
