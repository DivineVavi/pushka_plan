"""Synthetic public HTML only; no live portal content or network in tests."""
import json
import multiprocessing
import os
import tempfile
import threading
import time
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo
from unittest.mock import patch

from pushka.culture_public import (LISTING, RateLimited, SourceError, _SocksHTTPS, collect,
                                   event_rows, fetch_public, listing_page, sync)
from pushka.catalog import demo_rows
from pushka.server import App
from pushka.service import Service
from pushka.store import Store

NOW = datetime(2026, 9, 28, 10, tzinfo=timezone.utc)
URL1 = 'https://www.culture.ru/events/101/koncert-odin'
URL2 = 'https://www.culture.ru/events/102/spektakl-dva'


def page(props, links=()):
    return ('<html><script id="__NEXT_DATA__" type="application/json">' +
            json.dumps({'props':{'pageProps':props}}, ensure_ascii=False) +
            '</script>' + ''.join(f'<a href="{x}">Карточка</a>' for x in links) + '</html>').encode()


def listing(number=1, total=1, links=(URL1,), city='moskva', programme=True):
    items = [{'urlEventId':int(u.split('/')[4]), 'isPushkinsCard':True,
              'selectedLocalePlace':{'locale':{'name':'moskva'}}} for u in links]
    return page({'urlParams':{'locale':city, 'isPushkinsCard':programme},
                 'events':{'pagination':{'total':total, 'current':number},
                           'total':total, 'items':items}}, [u.split('www.culture.ru')[1] for u in links])


def event(eid=101, genre='Концерты', start=None, duration=2, age=12, price=500, city='moskva', session_id='s1'):
    start = start or NOW + timedelta(days=3)
    place = {'_id':'p1', 'title':'Зал', 'address':'Москва, Театральная 1',
             'locale':{'name':city, 'timezone':'Europe/Moscow'},
             'location':{'coordinates':[37.6, 55.7]}}
    session = {'_id':session_id, 'placeId':'p1', 'startDate':start.isoformat(),
               'endDate':(start + timedelta(hours=duration)).isoformat(),
               'startTime':(start.astimezone(ZoneInfo('Europe/Moscow')).hour * 3600000)}
    e = {'_id':eid, 'title':'Название', 'status':'published', 'ageRestriction':age,
         'priceMin':price, 'priceMax':price+300 if price is not None else None,
         'genres':[{'title':genre}], 'places':[place], 'seances':[session]}
    return e, session


def event_html(e):
    return page({'event':e})


class MappingFetcher:
    def __init__(self, pages):
        self.pages = pages
    def __call__(self, path):
        return self.pages[path]


class ParsingTests(unittest.TestCase):
    def test_moscow_listing_requires_programme_and_anchor(self):
        urls, pages, total, count = listing_page(listing(), 1)
        self.assertEqual((urls, pages, total, count), ([URL1], 1, 1, 1))
        with self.assertRaises(SourceError):
            listing_page(listing(city='moscow'), 1)
        with self.assertRaises(SourceError):
            listing_page(listing(programme=False), 1)
        with self.assertRaises(SourceError):
            listing_page(listing(number=2, total=2), 1)
        with self.assertRaises(SourceError):
            listing_page(page({'urlParams':{'locale':'moskva', 'isPushkinsCard':True},
                               'events':{'pagination':{'total':1, 'current':1}, 'total':1,
                                         'items':[{'urlEventId':101, 'isPushkinsCard':True,
                                                   'selectedLocalePlace':{'locale':{'name':'moskva'}}}]}}), 1)

    def test_session_is_future_city_scoped_and_price_is_from_event(self):
        e, _ = event()
        rows = event_rows(event_html(e), URL1, NOW, NOW.isoformat())
        self.assertEqual(len(rows), 1)
        row = rows[0]
        self.assertEqual(row['source'], 'culture-public')
        self.assertEqual(row['sourceUrl'], URL1)
        self.assertEqual(row['minPrice'], 500)
        self.assertFalse(row['exactPriceKnown'])
        self.assertEqual(row['saleLink'], None)
        self.assertEqual(row['localeId'], 'Москва')
        self.assertEqual(row['timezone'], 'Europe/Moscow')
        self.assertEqual(row['latitude'], 55.7)
        self.assertEqual(row['longitude'], 37.6)
        self.assertFalse(row['endEstimated'])
        e['places'][0]['locale']['name'] = 'novosibirsk'
        self.assertEqual(event_rows(event_html(e), URL1, NOW, NOW.isoformat()), [])

    def test_no_all_day_cinema_opening_hours_past_or_missing_price(self):
        for genre, duration in [('Кино', 23.98), ('Выставки', 8), ('Выставки', 4)]:
            e, seance = event(genre=genre, duration=duration)
            if genre == 'Кино':
                seance['startTime'] = 0
            self.assertEqual(event_rows(event_html(e), URL1, NOW, NOW.isoformat()), [])
        e, _ = event(start=NOW-timedelta(days=2))
        self.assertEqual(event_rows(event_html(e), URL1, NOW, NOW.isoformat()), [])
        e, _ = event(price=None)
        self.assertEqual(event_rows(event_html(e), URL1, NOW, NOW.isoformat()), [])
        e, _ = event()
        e['status'] = 'cancelled'
        self.assertEqual(event_rows(event_html(e), URL1, NOW, NOW.isoformat()), [])

    def test_missing_end_is_explicit_estimate_and_idempotent(self):
        e, seance = event()
        del seance['endDate']
        e['seances'].append(dict(seance))
        rows = event_rows(event_html(e), URL1, NOW, NOW.isoformat())
        self.assertEqual(len(rows), 1)
        self.assertTrue(rows[0]['endEstimated'])
        self.assertEqual(rows[0]['endsAt'], (NOW+timedelta(days=3,minutes=150)).isoformat())

    def test_invalid_identity_or_structure_fails_closed(self):
        with self.assertRaises(SourceError):
            event_rows(event_html(event(eid=102)[0]), URL1, NOW, NOW.isoformat())
        with self.assertRaises(SourceError):
            event_rows(b'<html>broken</html>', URL1, NOW, NOW.isoformat())
        e, seance = event()
        del seance['_id']
        with self.assertRaises(SourceError):
            event_rows(event_html(e), URL1, NOW, NOW.isoformat())


class SyncTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = Store(Path(self.tmp.name)/'catalog.sqlite3')
        self.store.replace_catalog(demo_rows(NOW), {'kind':'simulated','label':'Demo','fetchedAt':NOW.isoformat()})
        self.store.update_user('u', profile=json.dumps({'maxBalance':2000}))

    def tearDown(self):
        self.tmp.cleanup()

    def pages(self):
        e1, _ = event()
        e2, _ = event(eid=102, genre='Спектакли', age=16, session_id='s2')
        return {LISTING+'?page=1':listing(1, 2, (URL1,)),
                LISTING+'?page=2':listing(2, 2, (URL2,)),
                '/events/101/koncert-odin':event_html(e1),
                '/events/102/spektakl-dva':event_html(e2)}

    def test_complete_snapshot_is_atomic_and_idempotent(self):
        demo = self.store.catalog()[0]
        self.store.purchase('u', demo['id'], 900,
            {'id':demo['id'], 'source':'fixture', 'eventId':demo['eventId'],
             'startsAt':demo['startsAt'], 'endsAt':demo['endsAt'], 'price':900}, 3000)
        pages = self.pages()
        rows, meta = collect(NOW, fetch=pages.__getitem__)
        self.assertEqual(len(rows), 2)
        self.assertEqual(meta['coverage']['listedEvents'], 2)
        self.assertEqual(sync(self.store, now=NOW, fetch=pages.__getitem__), 2)
        self.assertEqual(len(self.store.catalog(locale='Москва', after=NOW.isoformat())), 2)
        self.assertEqual(self.store.facets(), (['Концерты','Спектакли'],['Москва']))
        self.assertTrue(all(r['endEstimated'] is False for r in self.store.catalog()))
        profile = {'maxBalance':3000, 'localeId':'москва', 'planningDeadline':'2026-11-01',
                   'availability':[{'weekday':n, 'start':'08:00', 'end':'23:00'} for n in range(7)],
                   'categoryWeights':{'Концерты':5}, 'excludedCategories':[], 'age':18,
                   'maxEvents':2, 'travelBufferMinutes':30}
        self.store.update_user('u', profile=json.dumps(profile))
        # Service.state uses wall-clock time; fix it at the synthetic snapshot.
        with patch('pushka.service.datetime') as clock:
            clock.now.return_value = NOW
            state = Service(self.store).state('u')
        self.assertEqual(state['diagnostics']['sourceSessions'], 2)
        self.assertEqual(state['remainingBalance'], 3000)
        self.assertFalse(state['purchased'])
        self.assertEqual(len(self.store.purchases('u')), 1)  # history preserved, not charged as real
        first = state['plans']['interest']['items'][0]
        self.store.purchase('u', first['id'], 500, first, 3000)
        self.assertEqual(len(self.store.purchases('u')), 2)
        self.assertEqual(sync(self.store, now=NOW, fetch=pages.__getitem__), 2)
        self.assertEqual(len(self.store.catalog()), 2)
        self.assertEqual(self.store.meta()['kind'], 'culture-public')
        self.assertIsNotNone(self.store.user('u')['profile'])

    def test_incomplete_or_changed_source_preserves_previous_snapshot_and_profile(self):
        pages = self.pages()
        original = self.store.catalog()
        del pages['/events/102/spektakl-dva']
        with self.assertRaises(KeyError):
            sync(self.store, now=NOW, fetch=pages.__getitem__)
        self.assertEqual(self.store.catalog(), original)
        self.assertEqual(self.store.meta()['kind'], 'simulated')
        self.assertIsNotNone(self.store.meta()['lastError'])
        self.assertIsNotNone(self.store.user('u')['profile'])
        pages = self.pages()
        pages[LISTING+'?page=2'] = listing(2, 3, (URL2,))
        with self.assertRaises(SourceError):
            sync(self.store, now=NOW, fetch=pages.__getitem__)
        self.assertEqual(self.store.catalog(), original)

    def test_durable_parser_queue_survives_restart_for_resume(self):
        e1, _ = event()
        rows = event_rows(event_html(e1), URL1, NOW, NOW.isoformat())
        sync_started = datetime.now(timezone.utc).isoformat()
        run_id, skipped, existing, started = self.store.begin_culture_sync(
            'same-listing-signature', [URL1], 1, sync_started)
        self.assertNotIn(URL1, skipped)
        self.store.queue_culture_page(run_id, URL1, rows)
        reopened = Store(Path(self.tmp.name)/'catalog.sqlite3')
        resumed_id, skipped, existing, resumed_started = reopened.begin_culture_sync(
            'same-listing-signature', [URL1], 1, sync_started)
        self.assertEqual(resumed_id, run_id)
        self.assertEqual(resumed_started, started)
        self.assertIn(URL1, skipped)
        self.assertEqual(existing, 1)
        self.assertEqual(reopened.latest_culture_sync()['queued_event_pages'], 1)
        self.assertEqual(reopened.catalog(), self.store.catalog())  # queued data is not user-visible

    def test_parser_queue_and_writer_process_publish_complete_snapshot(self):
        e1, _ = event()
        source_pages = {LISTING+'?page=1':listing(),
                        '/events/101/koncert-odin':event_html(e1)}
        count = sync(self.store, fetch=MappingFetcher(source_pages), use_processes=True)
        self.assertEqual(count, 1)
        self.assertEqual(self.store.meta()['kind'], 'culture-public')
        self.assertEqual(len(self.store.catalog()), 1)
        progress = self.store.latest_culture_sync()
        self.assertEqual(progress['status'], 'completed')
        self.assertEqual(progress['completed_event_pages'], 1)
        self.assertEqual(progress['queued_event_pages'], 0)
        self.assertEqual(progress['staged_sessions'], 1)

    def test_non_programme_listing_items_do_not_invalidate_complete_snapshot(self):
        e1, _ = event()
        excluded = {'urlEventId':999, 'isPushkinsCard':False,
                    'selectedLocalePlace':{'locale':{'name':'moskva'}}}
        html = page({'urlParams':{'locale':'moskva','isPushkinsCard':True},
                     'events':{'pagination':{'total':1,'current':1},'total':2,
                               'items':[{'urlEventId':101,'isPushkinsCard':True,
                                         'selectedLocalePlace':{'locale':{'name':'moskva'}}}, excluded]}},
                    ['/events/101/koncert-odin'])
        pages = {LISTING+'?page=1':html, '/events/101/koncert-odin':event_html(e1)}
        rows, meta = collect(NOW, fetch=pages.__getitem__)
        self.assertEqual(len(rows), 1)
        self.assertEqual(meta['coverage']['listedEvents'], 1)
        self.assertEqual(meta['coverage']['listingItems'], 2)

    def test_requests_are_parallel_within_ten_slots_and_five_per_second(self):
        pages = self.pages()
        lock = threading.Lock()
        active = peak = 0
        starts = []
        def fetch(path):
            nonlocal active, peak
            with lock:
                active += 1
                peak = max(peak, active)
                starts.append(time.monotonic())
            try:
                time.sleep(0.3)
                return pages[path]
            finally:
                with lock:
                    active -= 1
        rows, _ = collect(NOW, fetch=fetch, max_concurrency=10)
        self.assertEqual(len(rows), 2)
        self.assertGreater(peak, 1)
        self.assertLessEqual(peak, 10)
        self.assertTrue(all(b-a >= 0.18 for a,b in zip(starts, starts[1:])))

    def test_rate_limit_respects_retry_after_without_partial_publish(self):
        pages = self.pages()
        attempts = [0]
        def temporary_limit(path):
            if path == LISTING+'?page=1' and attempts[0] == 0:
                attempts[0] += 1
                raise RateLimited(3)
            return pages[path]
        with patch('pushka.culture_public.time.sleep') as sleep:
            rows, _ = collect(NOW, fetch=temporary_limit)
        self.assertEqual(attempts, [1])
        sleep.assert_any_call(3)
        self.assertEqual(len(rows), 2)

    def test_culture_mode_trusts_public_afisha_but_never_seeds_demo(self):
        db = Path(self.tmp.name)/'empty.sqlite3'
        with patch.dict(os.environ, {'CULTURE_SOURCE_MODE':'culture-public'}, clear=False):
            app = App(db)
            self.assertEqual(app.store.meta()['kind'], 'unavailable')
            self.assertFalse(app.store.catalog())
            self.assertFalse(app.service.state('anonymous')['demo'])

    def test_budget_guard_and_duplicates_never_publish_partial_data(self):
        pages = self.pages()
        with self.assertRaises(SourceError):
            collect(NOW, fetch=pages.__getitem__, max_pages=1)
        pages[LISTING+'?page=2'] = listing(2, 2, (URL1,))
        with self.assertRaises(SourceError):
            collect(NOW, fetch=pages.__getitem__)


class ProxyTests(unittest.TestCase):
    def test_no_creds_or_unlisted_path_never_opens_socket(self):
        with patch('pushka.culture_public.socket.create_connection') as connect:
            with self.assertRaises(SourceError):
                fetch_public(LISTING, credentials=(None, None))
            with self.assertRaises(SourceError):
                fetch_public('/api/private', credentials=('u', 'p'))
            connect.assert_not_called()

    def test_http_failure_or_timeout_never_switches_transport(self):
        class Response:
            status = 403
            def getheader(self, name): return None
        class Connection:
            def __init__(self, *args): self.closed = False
            def request(self, *args, **kwargs): pass
            def getresponse(self): return Response()
            def close(self): self.closed = True
        conn = Connection()
        with patch('pushka.culture_public._SocksHTTPS', return_value=conn) as proxy:
            with self.assertRaisesRegex(SourceError, 'HTTP 403'):
                fetch_public(LISTING, credentials=('user','pass'))
            proxy.assert_called_once_with('user', 'pass')
            self.assertTrue(conn.closed)
        with patch('pushka.culture_public._SocksHTTPS', return_value=conn):
            with patch.object(conn, 'getresponse', side_effect=TimeoutError('timeout')):
                with self.assertRaises(TimeoutError):
                    fetch_public(LISTING, credentials=('user','pass'))

    def test_socks5_handshake_uses_remote_dns_and_auth_only(self):
        class FakeSocket:
            def __init__(self):
                self.data = bytearray(b'\x05\x02\x01\x00\x05\x00\x00\x01\x7f\x00\x00\x01\x01\xbb')
                self.sent = []
            def sendall(self, value):
                self.sent.append(value)
            def recv(self, count):
                result, self.data = self.data[:count], self.data[count:]
                return bytes(result)
            def close(self): pass
        sock = FakeSocket()
        class FakeContext:
            def wrap_socket(self, conn, server_hostname):
                if server_hostname != 'www.culture.ru':
                    raise AssertionError('Wrong TLS host')
                return conn
        with patch('pushka.culture_public.ssl.create_default_context', return_value=FakeContext()), \
             patch('pushka.culture_public.socket.create_connection', return_value=sock):
            conn = _SocksHTTPS('username', 'password')
            conn.connect()
        self.assertEqual(sock.sent[0], b'\x05\x01\x02')
        self.assertEqual(sock.sent[1], b'\x01\x08username\x08password')
        self.assertIn(b'\x03\x0ewww.culture.ru\x01\xbb', sock.sent[2])
        self.assertEqual(conn.sock, sock)


if __name__ == '__main__':
    unittest.main()
