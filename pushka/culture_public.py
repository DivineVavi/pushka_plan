"""Conservative Moscow public-page adapter. No private APIs or seller verification.

This module does not start a crawler during HTTP requests. An operator may run a
bounded probe or explicitly request a complete sync. The public afisha is the
accepted source of record; only a technically complete, consistent crawl can
replace the existing SQLite snapshot.
"""
import argparse
import concurrent.futures
import hashlib
import http.client
import zlib
import json
import multiprocessing
import os
import re
import socket
import ssl
import threading
import time
from datetime import datetime, timedelta, timezone
from html.parser import HTMLParser
from urllib.parse import urlsplit
from zoneinfo import ZoneInfo

from .planner import instant, public_event_page
from .store import Store

HOST = 'www.culture.ru'
PROXY_HOST = os.getenv('CULTURE_PROXY_HOST', 'pool.proxy.market')
PROXY_PORT = int(os.getenv('CULTURE_PROXY_PORT', '10000'))
if PROXY_HOST != 'pool.proxy.market' or not 10000 <= PROXY_PORT <= 10999:
    raise RuntimeError('Culture proxy must use the configured pool.proxy.market endpoint and provider port range')
LISTING = '/afisha/moskva/pushkinskaya-karta'
MAX_COMPRESSED = 3_000_000
MAX_HTML = 8_000_000
DURATION_MINUTES = {'Концерты': 150, 'Спектакли': 180, 'Встречи': 120,
                    'Обучение': 120, 'Экскурсии': 180, 'Кино': 150}


class SourceError(ValueError):
    """Public source incomplete, unavailable or changed; do not replace snapshot."""


class RateLimited(SourceError):
    def __init__(self, retry_after):
        super().__init__('Public source returned HTTP 429')
        self.retry_after = retry_after


class _RequestGate:
    """Bound in-flight requests and honor the reported five-requests/second cap."""
    def __init__(self, max_concurrency=10, requests_per_second=5):
        if type(max_concurrency) is not int or not 1 <= max_concurrency <= 10:
            raise ValueError('max_concurrency must be between 1 and 10')
        self.semaphore = threading.BoundedSemaphore(max_concurrency)
        self.requests_per_second = requests_per_second
        self.lock = threading.Lock()
        self.next_request_at = 0.0

    def __enter__(self):
        self.semaphore.acquire()
        while True:
            with self.lock:
                current = time.monotonic()
                wait = self.next_request_at - current
                if wait <= 0:
                    self.next_request_at = current + 1 / self.requests_per_second
                    return self
            time.sleep(wait)

    def __exit__(self, exc_type, exc, traceback):
        self.semaphore.release()


def _parallel_map(values, worker, max_workers=10):
    with concurrent.futures.ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = [executor.submit(worker, value) for value in values]
        results = []
        try:
            for future in concurrent.futures.as_completed(futures):
                results.append(future.result())
        except BaseException:
            for future in futures:
                future.cancel()
            raise
        return results


def _request(path, fetch, gate):
    for attempt in range(3):
        try:
            with gate:
                return fetch(path)
        except (SourceError, OSError, http.client.HTTPException) as exc:
            if attempt == 2 or (isinstance(exc, SourceError) and not isinstance(exc, RateLimited) and
                                'HTTP 5' not in str(exc) and 'SOCKS5' not in str(exc)):
                raise
            time.sleep(exc.retry_after if isinstance(exc, RateLimited) else 2 ** attempt * 2)
    raise SourceError('Source unavailable')


class _NextData(HTMLParser):
    def __init__(self):
        super().__init__()
        self.collect = False
        self.parts = []
        self.links = []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == 'script' and attrs.get('id') == '__NEXT_DATA__':
            self.collect = True
        if tag == 'a' and attrs.get('href'):
            self.links.append(attrs['href'])

    def handle_endtag(self, tag):
        if tag == 'script':
            self.collect = False

    def handle_data(self, text):
        if self.collect:
            self.parts.append(text)


def _page(html):
    if isinstance(html, bytes):
        html = html.decode('utf-8')
    if len(html) > MAX_HTML:
        raise SourceError('Public page exceeds size limit')
    parser = _NextData()
    parser.feed(html)
    try:
        props = json.loads(''.join(parser.parts))['props']['pageProps']
        if not isinstance(props, dict):
            raise TypeError()
    except (ValueError, KeyError, TypeError) as exc:
        raise SourceError('Public page structure changed') from exc
    return props, parser.links


def listing_page(html, page):
    """Return canonical event URLs on this page and its current pagination."""
    props, anchors = _page(html)
    try:
        params, events = props['urlParams'], props['events']
        pagination, items = events['pagination'], events['items']
        pages, current, total = pagination['total'], pagination['current'], events['total']
        if params['locale'] != 'moskva' or params['isPushkinsCard'] is not True or current != page:
            raise SourceError('Listing has wrong city, programme or page')
        if not isinstance(items, list) or not all(isinstance(x, dict) for x in items):
            raise SourceError('Listing items missing')
        if not all(type(n) is int and n >= 0 for n in (pages, current, total)) or pages < page:
            raise SourceError('Invalid pagination')
        ids = {str(x['urlEventId']) for x in items if x.get('isPushkinsCard') is True and
               isinstance(x.get('selectedLocalePlace'), dict) and
               (x['selectedLocalePlace'].get('locale') or {}).get('name') == 'moskva'}
        # Never infer a slug from an ID: use the public canonical anchor.
        urls = {}
        for href in anchors:
            if not href.startswith('/events/'):
                continue
            path = urlsplit(href).path
            if re.fullmatch(r'/events/[0-9]+/[a-z0-9-]+/?', path):
                event_id = path.split('/')[2]
                if event_id in ids:
                    url = 'https://' + HOST + path
                    if public_event_page(url):
                        urls[event_id] = url
        if len(urls) != len(ids):
            raise SourceError('Listing missing event anchors')
        if not items and total:
            raise SourceError('Unexpected empty listing page')
        return list(urls.values()), pages, total, len(items)
    except (KeyError, TypeError, AttributeError) as exc:
        raise SourceError('Listing structure changed') from exc


def event_rows(html, url, now, fetched_at):
    """Only future, specifically timed Moscow sessions from a listed event."""
    if not public_event_page(url):
        raise SourceError('Unsafe event page')
    props, _ = _page(html)
    event = props.get('event')
    if not isinstance(event, dict) or str(event.get('_id')) != urlsplit(url).path.split('/')[2]:
        raise SourceError('Event page identity mismatch')
    if event.get('status') != 'published':
        return []
    genres = event.get('genres') or []
    category = genres[0].get('title') if genres and isinstance(genres[0], dict) else None
    age = event.get('ageRestriction')
    price = event.get('priceMin')
    if (not category or type(age) is not int or age < 0 or
            type(price) is not int or price < 0 or not event.get('title')):
        return []
    # An exhibition's published opening interval (even a 4-hour slot) does
    # not establish a booked visit start. Show it only in a future untimed
    # catalogue, never as a conflict-free timed-plan candidate.
    if category == 'Выставки':
        return []
    places = {p.get('_id'): p for p in event.get('places') or [] if isinstance(p, dict) and p.get('_id')}
    max_price = event.get('priceMax')
    if type(max_price) is not int or max_price < price:
        max_price = None
    rows = {}
    for session in event.get('seances') or []:
        if not isinstance(session, dict) or session.get('status') not in (None, 'published', 'active'):
            continue
        place = places.get(session.get('placeId'))
        if not place or (place.get('locale') or {}).get('name') != 'moskva':
            continue
        try:
            tzname = place['locale']['timezone']
            tz = ZoneInfo(tzname)
            start = instant(session['startDate'])
            if start <= now or start > now + timedelta(days=90):
                continue
            # 00:00–23:59 movie slots and 8–10h exhibitions are day ranges,
            # not a timed showing. Do not fabricate a visit time from them.
            local = start.astimezone(tz)
            start_time = session.get('startTime')
            if (type(start_time) is not int or start_time <= 0 or
                    start_time != (local.hour * 60 + local.minute) * 60_000):
                continue
            end_estimated = False
            if session.get('endDate'):
                end = instant(session['endDate'])
                if not timedelta(0) < end - start <= timedelta(hours=6):
                    continue
            elif category in DURATION_MINUTES:
                end = start + timedelta(minutes=DURATION_MINUTES[category])
                end_estimated = True
            else:
                continue
            coords = (place.get('location') or {}).get('coordinates')
            longitude, latitude = (coords[0], coords[1]) if isinstance(coords, list) and len(coords) == 2 else (None, None)
            if not all(type(n) in (int, float) and -180 <= n <= 180 for n in (latitude, longitude)):
                latitude = longitude = None
            sid = session.get('_id')
            if not isinstance(sid, str) or not sid:
                raise SourceError('Session identity missing')
            eid = str(event['_id'])
            vid = str(place['_id'])
            key = f'culture:{eid}:{vid}:{sid}'
            rows[key] = {'id':key, 'eventId':f'culture:{eid}', 'venueId':f'culture:{vid}',
                         'source':'culture-public', 'sourceUrl':url, 'title':event['title'],
                         'category':category, 'ageRestriction':age, 'venueName':place.get('title') or 'Площадка',
                         'address':place.get('address') or '', 'latitude':latitude, 'longitude':longitude,
                         'localeId':'Москва', 'timezone':tzname, 'minPrice':price, 'maxPrice':max_price,
                         'exactPriceKnown':False, 'startsAt':start.isoformat(), 'endsAt':end.isoformat(),
                         'endEstimated':end_estimated, 'saleLink':None, 'approved':True, 'published':True,
                         'fetchedAt':fetched_at, 'raw':{'cultureEventId':eid, 'sessionId':sid,
                             'priceBasis':'event-minimum', 'programmeEvidence':'moskva/pushkinskaya-karta'}}
        except SourceError:
            raise
        except (KeyError, TypeError, ValueError, OverflowError):
            continue
    return list(rows.values())


class _SocksHTTPS(http.client.HTTPSConnection):
    """Only remote-DNS SOCKS5 with user/password, then verified HTTPS to HOST."""
    def __init__(self, username, password, timeout=25):
        super().__init__(HOST, 443, timeout=timeout, context=ssl.create_default_context())
        self.username = username.encode('utf-8')
        self.password = password.encode('utf-8')
        if not self.username or not self.password or max(len(self.username), len(self.password)) > 255:
            raise SourceError('Proxy credentials missing or invalid')

    @staticmethod
    def _read(sock, size):
        parts = bytearray()
        while len(parts) < size:
            part = sock.recv(size - len(parts))
            if not part:
                raise SourceError('SOCKS5 connection closed')
            parts.extend(part)
        return bytes(parts)

    def connect(self):
        sock = socket.create_connection((PROXY_HOST, PROXY_PORT), timeout=self.timeout)
        try:
            sock.sendall(b'\x05\x01\x02')  # username/password only, never anonymous fallback
            if self._read(sock, 2) != b'\x05\x02':
                raise SourceError('SOCKS5 authentication method rejected')
            sock.sendall(b'\x01' + bytes([len(self.username)]) + self.username +
                         bytes([len(self.password)]) + self.password)
            if self._read(sock, 2) != b'\x01\x00':
                raise SourceError('SOCKS5 authentication failed')
            host = HOST.encode('ascii')
            sock.sendall(b'\x05\x01\x00\x03' + bytes([len(host)]) + host + b'\x01\xbb')
            reply = self._read(sock, 4)
            if reply[:3] != b'\x05\x00\x00':
                raise SourceError('SOCKS5 target connection failed')
            length = {1:4, 4:16}.get(reply[3])
            if reply[3] == 3:
                length = self._read(sock, 1)[0]
            if length is None:
                raise SourceError('SOCKS5 invalid reply')
            self._read(sock, length + 2)
            self.sock = self._context.wrap_socket(sock, server_hostname=HOST)
        except BaseException:
            sock.close()
            raise


def fetch_public(path, *, credentials=None):
    """Single bounded request. Refuse redirects and all non-public hosts."""
    if not (path == LISTING or re.fullmatch(re.escape(LISTING) + r'\?page=[1-9][0-9]*', path) or
            public_event_page('https://' + HOST + path)):
        raise SourceError('Only public listing/event pages are allowed')
    user, password = credentials if credentials is not None else (os.getenv('CULTURE_PROXY_USER'), os.getenv('CULTURE_PROXY_PASSWORD'))
    if not user or not password:
        raise SourceError('Proxy credentials not configured')
    connection = _SocksHTTPS(user, password)
    try:
        connection.request('GET', path, headers={'Host':HOST, 'Accept-Encoding':'gzip',
                           'User-Agent':'PushkaPlan-MoscowPilot/1.0', 'Connection':'close'})
        response = connection.getresponse()
        if response.status == 429:
            header = response.getheader('Retry-After')
            seconds = int(header) if header and header.isdecimal() else 60
            raise RateLimited(min(300, max(1, seconds)))
        if response.status != 200:
            raise SourceError('Public source returned HTTP ' + str(response.status))
        body = response.read(MAX_COMPRESSED + 1)
        if len(body) > MAX_COMPRESSED:
            raise SourceError('Public response exceeds size limit')
        if response.getheader('Content-Encoding') == 'gzip':
            inflater = zlib.decompressobj(16 + zlib.MAX_WBITS)
            body = inflater.decompress(body, MAX_HTML + 1)
            if not inflater.eof or len(body) > MAX_HTML:
                raise SourceError('Public page exceeds decompression limit')
        elif response.getheader('Content-Encoding') not in ('', None, 'identity'):
            raise SourceError('Unsupported content encoding')
        if len(body) > MAX_HTML:
            raise SourceError('Public page exceeds size limit')
        return body
    finally:
        connection.close()


def collect(now=None, fetch=None, max_pages=150, max_events=3500,
            max_bytes=2_500_000_000, max_concurrency=10,
            on_listing=None, on_event=None):
    """Collect a complete snapshot with bounded parallelism and a 5 req/s cap."""
    if type(max_concurrency) is not int or not 1 <= max_concurrency <= 10:
        raise ValueError('max_concurrency must be between 1 and 10')
    now = now or datetime.now(timezone.utc)
    fetch = fetch or fetch_public
    live = fetch is fetch_public
    gate = _RequestGate(max_concurrency)
    bytes_lock = threading.Lock()
    transferred = [0]  # decompressed bytes, an intentionally conservative budget

    def paced(path):
        if live and datetime.now(timezone.utc) - now >= timedelta(hours=12):
            raise SourceError('Full Moscow cycle exceeded freshness budget')
        data = _request(path, fetch, gate)
        with bytes_lock:
            transferred[0] += len(data)
            if transferred[0] > max_bytes:
                raise SourceError('Moscow collection traffic budget exceeded')
        return data

    first = paced(LISTING + '?page=1')
    urls, pages, total, count = listing_page(first, 1)
    if pages > max_pages or total > max_events:
        raise SourceError('Moscow listing exceeds configured budget')
    links = {u.rsplit('/', 2)[-2]:u for u in urls}

    def read_listing(page):
        found, reported_pages, reported_total, number = listing_page(
            paced(LISTING + f'?page={page}'), page)
        if reported_pages != pages or reported_total != total:
            raise SourceError('Pagination changed during collection')
        return found, number

    for found, number in _parallel_map(range(2, pages + 1), read_listing, max_concurrency):
        count += number
        for url in found:
            event_id = url.rsplit('/', 2)[-2]
            if event_id in links:
                raise SourceError('Event repeated across listing pages')
            links[event_id] = url
    if count != total or not links:
        raise SourceError('Moscow listing incomplete')
    resume_urls, timed_sessions = on_listing(links, pages, total, count, now.isoformat()) if on_listing else (set(), 0)
    event_urls = [url for url in links.values() if url not in resume_urls]

    def read_event(url):
        body = paced(urlsplit(url).path)
        checked_at = datetime.now(timezone.utc).isoformat() if live else now.isoformat()
        rows = event_rows(body, url, now, checked_at)
        if on_event:
            on_event(url, rows)
            return len(rows)
        return url, rows

    rows = {}
    for result in _parallel_map(event_urls, read_event, max_concurrency):
        if on_event:
            timed_sessions += result
            continue
        url, event_rows_result = result
        for row in event_rows_result:
            if row['id'] in rows and row != rows[row['id']]:
                raise SourceError('Conflicting duplicate session')
            rows[row['id']] = row
    # Even an internally consistent but entirely ineligible listing is not
    # proof that the real source has no useful events: retain the old snapshot.
    if not rows and timed_sessions == 0:
        raise SourceError('No timed Moscow sessions in full snapshot')
    completed = datetime.now(timezone.utc) if live else now
    if completed - now >= timedelta(hours=12):
        raise SourceError('Full Moscow cycle exceeded freshness budget')
    # The oldest checked page bounds freshness of the entire snapshot.
    return list(rows.values()), {'kind':'culture-public', 'label':'Культура.РФ · московская публичная афиша (предварительный план)',
                'sourceUrl':'https://' + HOST + LISTING, 'fetchedAt':now.isoformat(),
                'lastError':None, 'lastAttempt':completed.isoformat(), 'lastCompletedAt':completed.isoformat(),
                'coverage':{'listedEvents':len(links), 'listingItems':total,
                            'timedSessions':timed_sessions if on_event else len(rows),
                            'decompressedBytes':transferred[0]}}


def _parser_process(db_path, options):
    """Parser process: fetch/parse pages and persist results to the durable queue."""
    from .catalog_writer import write_culture_queue

    store = Store(db_path)
    run = {'id':None, 'writer':None, 'startedAt':None, 'eventPages':0}

    def begin_after_listing(links, pages, total, listing_items, fetched_at):
        signature = hashlib.sha256(json.dumps(
            {'pages':pages, 'total':total, 'urls':sorted(links.values())},
            separators=(',', ':')).encode()).hexdigest()
        run_id, skipped, existing_sessions, started_at = store.begin_culture_sync(
            signature, list(links.values()), listing_items, fetched_at)
        run.update(id=run_id, startedAt=started_at, eventPages=len(links))
        context = multiprocessing.get_context('spawn')
        writer = context.Process(target=write_culture_queue, args=(db_path, run_id),
                                 name='culture-db-writer')
        writer.start()
        run['writer'] = writer
        return skipped, existing_sessions

    def enqueue_result(url, rows):
        store.queue_culture_page(run['id'], url, rows)

    writer = None
    try:
        _, source = collect(**options, on_listing=begin_after_listing,
                            on_event=enqueue_result)
        if run['id'] is None:
            raise SourceError('Sync did not initialize its durable writer')
        source['fetchedAt'] = run['startedAt']
        source['coverage']['parsedEventPages'] = run['eventPages']
        store.mark_culture_sync_ready(run['id'], source)
        writer = run['writer']
        writer.join()
        completed = store.culture_sync_run(run['id'])
        if writer.exitcode != 0 or not completed or completed['status'] != 'completed':
            raise SourceError('Database writer did not publish a complete snapshot')
    except BaseException as exc:
        if run['id']:
            store.fail_culture_sync(run['id'], type(exc).__name__)
        store.source_error('Сбор Культура.РФ не завершён: предыдущий снимок сохранён.')
        writer = run['writer']
        if writer and writer.is_alive():
            writer.join(timeout=30)
            if writer.is_alive():
                writer.terminate()
                writer.join()
        raise SystemExit(1)


def sync(store, use_processes=None, **kwargs):
    """Run a parser process and durable DB-writer process; publish on completion only."""
    if use_processes is None:
        use_processes = kwargs.get('fetch') is None
    if not use_processes:
        # Offline seam for deterministic parser tests.
        try:
            rows, source = collect(**kwargs)
            store.replace_catalog(rows, source)
            return len(rows)
        except Exception:
            store.source_error('Сбор Культура.РФ не завершён: предыдущий снимок сохранён.')
            raise
    context = multiprocessing.get_context('spawn')
    parser = context.Process(target=_parser_process,
                             args=(os.path.abspath(store.path), kwargs),
                             name='culture-parser')
    parser.start()
    parser.join()
    if parser.exitcode != 0:
        store.source_error('Сбор Культура.РФ не завершён: предыдущий снимок сохранён.')
        raise SourceError(f'Culture parser exited with code {parser.exitcode}')
    latest = store.latest_culture_sync()
    if not latest or latest['status'] != 'completed':
        raise SourceError('Culture snapshot was not published')
    return latest['staged_sessions']


def main():
    parser = argparse.ArgumentParser(description='Moscow public-afisha collection')
    choice = parser.add_mutually_exclusive_group(required=True)
    choice.add_argument('--probe', action='store_true', help='Only one listing and up to 10 events; never publish')
    choice.add_argument('--sync', action='store_true', help='Explicitly run a complete Moscow sync')
    parser.add_argument('--db', default=os.getenv('PUSHKA_DB', 'data/pushka.sqlite3'))
    args = parser.parse_args()
    if args.probe:
        now = datetime.now(timezone.utc)
        gate = _RequestGate(10)
        html = _request(LISTING + '?page=1', fetch_public, gate)
        urls, pages, total, _ = listing_page(html, 1)
        def inspect(url):
            body = _request(urlsplit(url).path, fetch_public, gate)
            return event_rows(body, url, now, now.isoformat())
        results = _parallel_map(urls[:10], inspect, 10)
        counts = {'listed':len(urls), 'pages':pages, 'total':total,
                  'timed':sum(len(rows) for rows in results),
                  'empty':sum(not bool(rows) for rows in results)}
        print(json.dumps(counts, ensure_ascii=False))
    else:
        print('Full Moscow sync completed:', sync(Store(args.db)))


if __name__ == '__main__':
    main()
