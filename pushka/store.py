"""SQLite persistence and all-or-nothing catalogue replacement."""
import json
import sqlite3
import secrets
from statistics import median
from contextlib import contextmanager
from pathlib import Path


def purchase_matches_source(purchase, kind):
    expected = {'simulated':'fixture', 'culture-public':'culture-public',
                'culture-public-prepared':'culture-public',
                'pro-culture':'pro-culture', 'pro-culture-prepared':'pro-culture'}.get(kind)
    if not expected:
        return False
    item = purchase.get('item') or {}
    source = item.get('source')
    if not source:
        sid = purchase.get('sessionId', '')
        source = ('fixture' if sid.startswith('demo:') else
                  'pro-culture' if sid.startswith('pro:') else
                  'culture-public' if sid.startswith('culture:') else None)
    return source == expected


class Store:
    def __init__(self, path):
        self.path = str(path)
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        with self.db() as db:
            db.executescript('''
                CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS venues (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, event_id TEXT NOT NULL REFERENCES events(id), venue_id TEXT NOT NULL REFERENCES venues(id), payload TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS app_config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, profile TEXT, stage TEXT, draft TEXT, reminders INTEGER NOT NULL DEFAULT 0, selected_plan TEXT);
                CREATE TABLE IF NOT EXISTS purchases (user_id TEXT NOT NULL, session_id TEXT NOT NULL, actual_price INTEGER NOT NULL, item TEXT NOT NULL, PRIMARY KEY(user_id, session_id));
                CREATE TABLE IF NOT EXISTS deliveries (id TEXT PRIMARY KEY, delivered_at TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS reminders (user_id TEXT NOT NULL, session_id TEXT NOT NULL, kind TEXT NOT NULL, PRIMARY KEY(user_id,session_id,kind));
                CREATE TABLE IF NOT EXISTS analytics (id INTEGER PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, value INTEGER, at TEXT NOT NULL);
                CREATE INDEX IF NOT EXISTS idx_sessions_start ON sessions(json_extract(payload, '$.startsAt'));
                CREATE INDEX IF NOT EXISTS idx_venues_locale ON venues(json_extract(payload, '$.localeId'));
                CREATE INDEX IF NOT EXISTS idx_sessions_event ON sessions(event_id);
            ''')
            if 'selected_plan' not in {r['name'] for r in db.execute('PRAGMA table_info(users)')}:
                db.execute('ALTER TABLE users ADD COLUMN selected_plan TEXT')

    @contextmanager
    def db(self):
        db = sqlite3.connect(self.path, timeout=30)
        db.row_factory = sqlite3.Row
        try:
            yield db
            db.commit()
        except Exception:
            db.rollback()
            raise
        finally:
            db.close()

    def demo_cookie_key(self):
        """Stable per-install secret, separate from distributable catalogue metadata."""
        with self.db() as db:
            db.execute('INSERT OR IGNORE INTO app_config VALUES (?,?)', ('demo_cookie_key', secrets.token_hex(32)))
            return db.execute('SELECT value FROM app_config WHERE key=?', ('demo_cookie_key',)).fetchone()[0]

    def meta(self):
        with self.db() as db:
            return {r['key']: json.loads(r['value']) for r in db.execute('SELECT * FROM meta')}

    def replace_catalog(self, rows, source):
        # Validate the whole snapshot first; never replace last successful data on failure.
        ids = set()
        for row in rows:
            if row['id'] in ids or not all(k in row for k in ('eventId','venueId','startsAt','endsAt','source')):
                raise ValueError('Invalid/duplicate catalog row')
            ids.add(row['id'])
        event_fields = ('eventId','source','sourceUrl','title','category','ageRestriction','approved','published','fetchedAt','raw')
        venue_fields = ('venueId','venueName','address','latitude','longitude','localeId','timezone')
        session_fields = ('id','startsAt','endsAt','endEstimated','minPrice','maxPrice','exactPriceKnown','saleLink')
        events = {r['eventId']: {k:r[k] for k in event_fields if k in r} for r in rows}
        venues = {r['venueId']: {k:r[k] for k in venue_fields if k in r} for r in rows}
        with self.db() as db:
            db.execute('PRAGMA foreign_keys=ON')
            db.execute('DELETE FROM sessions')
            db.execute('DELETE FROM events')
            db.execute('DELETE FROM venues')
            db.execute('DELETE FROM meta')
            db.executemany('INSERT INTO events VALUES (?,?)', ((k,json.dumps(v,ensure_ascii=False)) for k,v in events.items()))
            db.executemany('INSERT INTO venues VALUES (?,?)', ((k,json.dumps(v,ensure_ascii=False)) for k,v in venues.items()))
            db.executemany('INSERT INTO sessions VALUES (?,?,?,?)', ((r['id'],r['eventId'],r['venueId'],json.dumps({k:r[k] for k in session_fields if k in r},ensure_ascii=False)) for r in rows))
            for k, v in source.items():
                db.execute('INSERT OR REPLACE INTO meta VALUES (?,?)', (k, json.dumps(v, ensure_ascii=False)))

    def catalog(self, locale=None, after=None, before=None):
        where, params = [], []
        if locale is not None:
            where.append("json_extract(v.payload, '$.localeId') = ?")
            params.append(locale)
        if after is not None:
            where.append("json_extract(s.payload, '$.startsAt') > ?")
            params.append(after)
        if before is not None:
            where.append("json_extract(s.payload, '$.startsAt') < ?")
            params.append(before)
        query = '''SELECT e.payload AS event,v.payload AS venue,s.payload AS session
                   FROM sessions s JOIN events e ON e.id=s.event_id JOIN venues v ON v.id=s.venue_id'''
        if where:
            query += ' WHERE ' + ' AND '.join(where)
        query += ' ORDER BY s.id'
        with self.db() as db:
            return [{**json.loads(r['event']), **json.loads(r['venue']), **json.loads(r['session'])}
                    for r in db.execute(query, params)]

    def facets(self):
        with self.db() as db:
            categories = [r[0] for r in db.execute("SELECT DISTINCT json_extract(payload, '$.category') FROM events WHERE json_extract(payload, '$.category') IS NOT NULL ORDER BY 1")]
            locales = [r[0] for r in db.execute("SELECT DISTINCT json_extract(payload, '$.localeId') FROM venues WHERE json_extract(payload, '$.localeId') IS NOT NULL ORDER BY 1")]
        return categories, locales

    def user(self, uid):
        with self.db() as db:
            row = db.execute('SELECT * FROM users WHERE id=?', (uid,)).fetchone()
            return dict(row) if row else {'id': uid, 'profile': None, 'stage': None, 'draft': None, 'reminders': 0, 'selected_plan': None}

    def update_user(self, uid, **changes):
        with self.db() as db:
            db.execute('INSERT OR IGNORE INTO users(id) VALUES (?)', (uid,))
            for k, v in changes.items():
                if k not in ('profile','stage','draft','reminders','selected_plan'):
                    raise ValueError('Unexpected field')
                db.execute(f'UPDATE users SET {k}=? WHERE id=?', (v, uid))

    def purchases(self, uid):
        with self.db() as db:
            return [{'sessionId': r['session_id'], 'actualPrice': r['actual_price'], 'item': json.loads(r['item'])} for r in db.execute('SELECT * FROM purchases WHERE user_id=? ORDER BY session_id', (uid,))]

    def purchase(self, uid, session_id, price, item, maximum, max_events=4, buffer_minutes=30):
        with self.db() as db:
            db.execute('BEGIN IMMEDIATE')
            purchase_rows = db.execute('SELECT session_id,actual_price,item FROM purchases WHERE user_id=?', (uid,)).fetchall()
            current = [r for r in purchase_rows if purchase_matches_source(
                {'sessionId':r['session_id'], 'item':json.loads(r['item'])},
                {'fixture':'simulated','culture-public':'culture-public','pro-culture':'pro-culture'}.get(item.get('source'), 'unavailable'))]
            spent = sum(r['actual_price'] for r in current)
            existing = next((r for r in purchase_rows if r['session_id'] == session_id), None)
            if existing:
                if existing['actual_price'] != price:
                    raise ValueError('Покупка уже записана с другой ценой')
                return False
            if price > maximum - spent:
                raise ValueError('Фактическая цена превышает вручную указанный остаток')
            from .planner import conflict
            locked = [json.loads(r['item']) for r in current]
            if len(locked) >= max_events or any(conflict(item, other, buffer_minutes) for other in locked):
                raise ValueError('Покупка конфликтует с уже закреплёнными сеансами или лимитом событий')
            db.execute('INSERT INTO purchases VALUES (?,?,?,?)', (uid, session_id, price, json.dumps(item, ensure_ascii=False)))
            return True

    def claim_delivery(self, key, at):
        with self.db() as db:
            return db.execute('INSERT OR IGNORE INTO deliveries VALUES (?,?)', (key, at)).rowcount == 1

    def release_delivery(self, key):
        with self.db() as db:
            db.execute('DELETE FROM deliveries WHERE id=?', (key,))

    def claim_reminder(self, uid, sid, kind):
        with self.db() as db:
            return db.execute('INSERT OR IGNORE INTO reminders VALUES (?,?,?)', (uid,sid,kind)).rowcount == 1

    def metric(self, uid, name, value=None):
        from datetime import datetime, timezone
        if name not in ('plan_started','plan_completed','plan_opened','ticket_link_opened','source_link_opened','purchase_confirmed','replanned'):
            raise ValueError('Unknown metric')
        with self.db() as db:
            db.execute('INSERT INTO analytics(user_id,name,value,at) VALUES (?,?,?,?)',
                       (uid, name, value, datetime.now(timezone.utc).isoformat()))

    def stats(self):
        with self.db() as db:
            counts = {r['name']: r['n'] for r in db.execute('SELECT name,COUNT(*) AS n FROM analytics GROUP BY name')}
            users = db.execute('SELECT COUNT(*) FROM users WHERE profile IS NOT NULL').fetchone()[0]
            purchases = db.execute('SELECT COUNT(*) FROM purchases').fetchone()[0]
            prices = db.execute('SELECT actual_price,item FROM purchases').fetchall()
            differences = [r['actual_price'] - json.loads(r['item']).get('plannedPrice', r['actual_price']) for r in prices]
            leftovers = [r[0] for r in db.execute("SELECT value FROM analytics WHERE name='plan_completed' AND value IS NOT NULL")]
            unique = {r['name']:r['n'] for r in db.execute('SELECT name, COUNT(DISTINCT user_id) AS n FROM analytics GROUP BY name')}
            return {'events':counts, 'uniqueUsersByEvent':unique, 'profiles':users, 'purchases':purchases,
                    'medianPlanLeftover':median(leftovers) if leftovers else None,
                    'meanPriceDifference':round(sum(differences)/len(differences), 2) if differences else None}
