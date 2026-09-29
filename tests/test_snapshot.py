"""Submission contracts: safe offline seeding, privacy, purchases and restart."""
import os
import sqlite3
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

from pushka.catalog import demo_rows
from pushka.server import App
from pushka.snapshot import DEFAULT_SNAPSHOT, export_catalog, load_catalog_snapshot, read_snapshot
from pushka.store import Store
from test_pushka import profile


class SnapshotTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.source = Path(self.tmp.name) / 'source.sqlite3'
        self.snapshot = Path(self.tmp.name) / 'catalog.sqlite3'
        self.target = Path(self.tmp.name) / 'application.sqlite3'
        self.now = datetime.now(timezone.utc)
        store = Store(self.source)
        rows = demo_rows(self.now)
        for row in rows:
            row.update(source='culture-public',
                       sourceUrl='https://www.culture.ru/events/7219156/koncert-da-zdravstvuet-meksika',
                       fetchedAt=self.now.isoformat(), exactPriceKnown=False)
        store.replace_catalog(rows, {'kind':'culture-public', 'fetchedAt':self.now.isoformat(),
                                     'sourceUrl':'https://www.culture.ru/afisha/moskva/pushkinskaya-karta'})
        # These must never reach the distributable database, including its free pages.
        store.update_user('private-user', profile='PRIVATE-PROFILE', draft='PRIVATE-DRAFT')
        with store.db() as db:
            db.execute("INSERT INTO purchases VALUES ('private-user','private-session',100,'{}')")
            db.execute("INSERT INTO app_config VALUES ('secret','PRIVATE-SECRET')")
            db.execute("INSERT INTO meta VALUES ('private-extra','\"PRIVATE-METADATA\"')")
        export_catalog(self.source, self.snapshot)
        self.env = {'CULTURE_SOURCE_MODE':'snapshot', 'CATALOG_SNAPSHOT_PATH':str(self.snapshot),
                    'MAX_BOT_TOKEN':'', 'MAX_WEBHOOK_SECRET':'', 'DEMO_COOKIE_KEY':'',
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

    def test_first_start_imports_snapshot_without_source_network(self):
        with patch.dict(os.environ, self.env), patch('pushka.catalog.urlopen', side_effect=AssertionError('offline')) as network:
            app = App(self.target)
            state = app.state_for_app('judge')
            self.assertEqual(state['source']['kind'], 'culture-public-prepared')
            self.assertEqual(state['source']['fetchedAt'], self.now.isoformat())
            self.assertFalse(state['demo'])
            self.assertEqual(len(app.store.catalog()), 10)
            network.assert_not_called()

    def test_snapshot_background_does_not_sync_even_if_api_key_is_present(self):
        with patch.dict(os.environ, self.env), patch('pushka.catalog.urlopen', side_effect=AssertionError('offline')) as network:
            app = App(self.target)
            with patch('pushka.server.time.sleep', side_effect=[None, StopIteration]):
                with self.assertRaises(StopIteration):
                    app.background()
            network.assert_not_called()
            self.assertEqual(app.store.meta()['kind'], 'culture-public-prepared')

    def test_purchase_selected_plan_and_browser_identity_survive_restart(self):
        with patch.dict(os.environ, self.env):
            app = App(self.target)
            uid, cookie = app.identity({})
            headers = {'Cookie':cookie.split(';', 1)[0]}
            p = profile(planningDeadline=(self.now+timedelta(days=60)).date().isoformat())
            state = app.dispatch('PUT', '/api/profile', p, uid)
            first = state['plans']['interest']['items'][0]
            selected = app.dispatch('POST', '/api/selected-plan', {'mode':'interest'}, uid)
            self.assertFalse(selected['selectedPlan']['needsConfirmation'])
            bought = app.dispatch('POST', '/api/purchase', {'sessionId':first['id'], 'actualPrice':first['price']+100}, uid)
            self.assertEqual(bought['remainingBalance'], 3200-first['price']-100)
            self.snapshot.unlink()  # A restart must not depend on re-importing the seed.
            restarted = App(self.target)
            self.assertEqual(restarted.identity(headers), (uid, None))
            state = restarted.dispatch('GET', '/api/state', None, uid)
            self.assertEqual(state['purchased'], bought['purchased'])
            self.assertEqual(state['profile'], bought['profile'])
            self.assertEqual(state['selectedPlan'], bought['selectedPlan'])
            self.assertEqual(state['remainingBalance'], bought['remainingBalance'])
            for mode in state['plans'].values():
                self.assertTrue(any(i['id']==first['id'] and i['purchased'] for i in mode['items']))

    def test_bad_snapshot_fails_explicitly_instead_of_substituting_demo(self):
        self.snapshot.write_bytes(b'not sqlite')
        store = Store(self.target)
        store.update_user('existing-user', draft='keep me')
        with self.assertRaisesRegex(ValueError, 'CATALOG_SNAPSHOT_PATH'):
            load_catalog_snapshot(store, self.snapshot)
        self.assertEqual(store.meta(), {})
        self.assertEqual(store.catalog(), [])
        self.assertEqual(store.user('existing-user')['draft'], 'keep me')

    def test_missing_snapshot_on_new_database_has_actionable_error(self):
        store = Store(self.target)
        with self.assertRaisesRegex(ValueError, 'CATALOG_SNAPSHOT_PATH'):
            load_catalog_snapshot(store, Path(self.tmp.name)/'missing.sqlite3')
        self.assertEqual(store.catalog(), [])
        self.assertEqual(store.meta(), {})

    def test_missing_snapshot_does_not_reset_existing_catalogue(self):
        store = Store(self.target)
        load_catalog_snapshot(store, self.snapshot)
        before = store.catalog()
        self.assertEqual(load_catalog_snapshot(store, Path(self.tmp.name)/'missing.sqlite3'), 0)
        self.assertEqual(store.catalog(), before)

    def test_demo_is_explicit_future_dated_and_not_real_source(self):
        with patch.dict(os.environ, {**self.env, 'CULTURE_SOURCE_MODE':'demo'}):
            app = App(self.target)
            state = app.state_for_app('judge')
            self.assertTrue(state['demo'])
            rows = app.store.catalog()
            self.assertEqual(len(rows), 10)
            self.assertTrue(all(datetime.fromisoformat(r['startsAt'])>self.now for r in rows))
            self.assertTrue(all(r['source']=='fixture' and r['saleLink'] is None for r in rows))

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
