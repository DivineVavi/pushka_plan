"""Prepared simulated data and optional official PRO.Культура.РФ export adapter."""
import json
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlencode, urlparse
from urllib.request import urlopen
from zoneinfo import ZoneInfo
from .planner import instant

API = 'https://pro.culture.ru/api/2.5/pushkinsCardEvents'


def safe_link(link):
    try:
        url = urlparse(link or '')
        return link if url.scheme == 'https' and url.hostname and not url.username else None
    except ValueError:
        return None


def demo_rows(now):
    fixture = json.loads((Path(__file__).resolve().parent.parent / 'data/demo-v1.json').read_text())
    tz = ZoneInfo(fixture['timezone'])
    base = now.astimezone(tz).date()
    rows = []
    for event in fixture['events']:
        start = datetime.combine(base + timedelta(days=event['days']), datetime.min.time(), tz).replace(hour=event['hour'])
        for ordinal, start_time in enumerate((start, start + timedelta(days=7)) if event['id'] in ('stage-1','exhibit-1') else (start,)):
            end = start_time + timedelta(minutes=event['duration'])
            rows.append({'id': f"demo:{event['id']}:{ordinal}", 'eventId': f"demo:{event['id']}", 'venueId': f"demo:{event['id']}",
                         'source': 'fixture', 'sourceUrl': fixture['sourceUrl'], 'title': event['title'], 'category': event['category'],
                         'ageRestriction': event['ageRestriction'], 'venueName': event['venue'], 'address': event['address'],
                         'latitude': event['latitude'], 'longitude': event['longitude'], 'localeId': fixture['localeId'],
                         'timezone': fixture['timezone'], 'minPrice': event['price'], 'maxPrice': event['price'],
                         'exactPriceKnown': True, 'startsAt': start_time.astimezone(timezone.utc).isoformat(),
                         'endsAt': end.astimezone(timezone.utc).isoformat(), 'saleLink': None, 'approved': True,
                         'published': True, 'raw': event})
    return rows


def normalize_official(event, fetched_at):
    """Fail closed on missing approval, publication, session, price or verified link."""
    if event.get('statusPushka') is not True or event.get('isPublished') is not True or event.get('inAccepted') is not True:
        return []
    event_id = event.get('id', event.get('_id'))
    if event_id is None or not event.get('name'):
        return []
    category = event.get('category') or {}
    if not isinstance(category, dict):
        return []
    age = event.get('ageRestriction')
    if not isinstance(age, int) or isinstance(age, bool) or age < 0:
        return []
    price = 0 if event.get('isFree') is True else event.get('price')
    if isinstance(price, bool) or not isinstance(price, (int, float)) or price < 0 or price != int(price):
        price = None
    max_price = event.get('maxPrice')
    exact = price is not None and (event.get('isFree') is True or max_price == price)
    rows = []
    for idx, place in enumerate(event.get('places') or []):
        locale = place.get('locale') or {}
        locale_id = locale.get('id') or locale.get('name')
        if not locale_id:
            continue
        place_id = str(place.get('id') or f'{event_id}:{idx}')
        coords = place.get('mapPosition') or {}
        address = place.get('address') or {}
        if isinstance(address, dict):
            address = ', '.join(str(x.get('name', '')) for x in (address.get('city'), address.get('street'), address.get('house')) if isinstance(x, dict))
        try:
            latitude = coords.get('latitude', coords.get('lat')) if isinstance(coords, dict) else None
            longitude = coords.get('longitude', coords.get('lon')) if isinstance(coords, dict) else None
            latitude, longitude = float(latitude) if latitude is not None else None, float(longitude) if longitude is not None else None
        except (TypeError, ValueError):
            latitude = longitude = None
        for num, session in enumerate(place.get('seances') or []):
            try:
                start, end = instant(session['start']), instant(session['end'])
                if end <= start:
                    continue
            except (ValueError, KeyError, TypeError, OverflowError):
                continue
            rows.append({'id': f'pro:{event_id}:{place_id}:{num}:{int(start.timestamp())}', 'eventId': f'pro:{event_id}', 'venueId': f'pro:{place_id}',
                         'source': 'pro-culture', 'sourceUrl': API, 'title': event['name'], 'category': category.get('name') or category.get('sysName') or 'Прочие',
                         'ageRestriction': age, 'venueName': place.get('name') or 'Площадка', 'address': str(address),
                         'latitude': latitude, 'longitude': longitude, 'localeId': str(locale_id), 'timezone': locale.get('timezone') or 'Europe/Moscow',
                         'minPrice': int(price) if price is not None else None, 'maxPrice': max_price, 'exactPriceKnown': exact,
                         'startsAt': start.isoformat(), 'endsAt': end.isoformat(), 'saleLink': safe_link(place.get('saleLink') or event.get('saleLink')),
                         'approved': True, 'published': True, 'fetchedAt': fetched_at, 'raw': event})
    return rows


def sync_official(store, key, locale_ids='', now=None, fetch=None):
    now = now or datetime.now(timezone.utc)
    fetched_at = now.isoformat()
    def download(url):
        with urlopen(url, timeout=25) as response:
            return json.load(response)
    fetch = fetch or download
    raw = []
    for offset in range(0, 100000, 100):
        params = {'apiKey': key, 'status': 'accepted', 'start': int(now.timestamp()*1000), 'end': int((now+timedelta(days=90)).timestamp()*1000), 'offset': offset, 'limit': 100}
        if locale_ids:
            params['locales'] = locale_ids
        body = fetch(API + '?' + urlencode(params))
        page = body.get('events') if isinstance(body, dict) else None
        if not isinstance(page, list):
            raise ValueError('Unexpected PRO.Культура response (events list missing)')
        raw.extend(page)
        if len(page) < 100:
            break
    else:
        raise ValueError('PRO.Культура page limit exceeded')
    rows = [r for event in raw for r in normalize_official(event, fetched_at)]
    store.replace_catalog(rows, {'kind': 'pro-culture', 'label': 'PRO.Культура.РФ · официальная выгрузка', 'fetchedAt': fetched_at, 'sourceUrl': API, 'lastError': None})
    return len(rows)


def load_prepared_snapshot(store, path):
    """Import a user-supplied export without ever labeling it live."""
    body = json.loads(Path(path).read_text(encoding='utf-8'))
    if not isinstance(body, dict) or body.get('sourceUrl') != API or not isinstance(body.get('events'), list):
        raise ValueError('Snapshot needs official sourceUrl and events array')
    fetched = instant(body['fetchedAt']).isoformat()
    rows = [r for event in body['events'] for r in normalize_official(event, fetched)]
    store.replace_catalog(rows, {'kind':'pro-culture-prepared', 'label':'Подготовленный снимок PRO.Культура.РФ (не живая интеграция)',
                                 'sourceUrl': API, 'fetchedAt':fetched, 'lastError':None})
    return len(rows)


def ensure_catalog(store, token=None, now=None):
    now = now or datetime.now(timezone.utc)
    meta = store.meta()
    snapshot = os.getenv('PRO_SNAPSHOT_PATH')
    if snapshot and not token:
        try:
            load_prepared_snapshot(store, snapshot)
        except Exception:
            if not meta or meta.get('kind') == 'simulated':
                store.replace_catalog([], {'kind':'unavailable','label':'Ошибка подготовленного снимка',
                                           'fetchedAt':now.isoformat(),'sourceUrl':API,'lastError':'Снимок не загружен: проверьте файл и структуру.'})
            else:
                with store.db() as db:
                    db.execute('INSERT OR REPLACE INTO meta VALUES (?,?)', ('lastError', json.dumps('Снимок не обновлён: предыдущие данные сохранены.')))
        return
    if not meta and not token:
        store.replace_catalog(demo_rows(now), {'kind': 'simulated', 'label': 'Учебный набор demo-v1: вымышленные события, не официальная выгрузка', 'fetchedAt': now.isoformat(), 'sourceUrl': API, 'lastError': None})
    elif token and (meta.get('kind') != 'pro-culture' or (now-instant(meta['fetchedAt'])).total_seconds() > 8*3600):
        if meta.get('lastAttempt') and (now-instant(meta['lastAttempt'])).total_seconds() < 3600:
            return
        try:
            sync_official(store, token, os.getenv('PRO_LOCALE_IDS', ''), now)
        except Exception:
            # Network exceptions may embed apiKey in the URL: never expose them to users.
            # Never silently use simulated events as an official feed.
            error = 'Не удалось обновить официальный источник; проверьте ключ/сеть в журнале сервера.'
            if meta.get('kind') != 'pro-culture':
                store.replace_catalog([], {'kind': 'unavailable', 'label': 'Официальная выгрузка недоступна', 'fetchedAt': now.isoformat(), 'sourceUrl': API, 'lastError': error, 'lastAttempt': now.isoformat()})
            else:
                with store.db() as db:
                    for k, value in (('lastError', error), ('lastAttempt', now.isoformat())):
                        db.execute('INSERT OR REPLACE INTO meta VALUES (?,?)', (k, json.dumps(value)))
