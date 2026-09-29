"""HTTP entry point: local demo or authenticated MAX webhook + mini-app."""
import hmac
import json
import logging
import os
import secrets
import threading
import time
from datetime import datetime, timezone
from http import cookies
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit
from .bot import Bot, MaxClient, send_due_reminders
from .catalog import demo_rows, ensure_catalog
from .culture_public import sync as sync_culture
from .planner import public_event_page
from .service import Invalid, Service, validate_max_init
from .store import Store
from .snapshot import DEFAULT_SNAPSHOT, load_catalog_snapshot

ROOT = Path(__file__).resolve().parent.parent
MIMES = {'.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8'}
log = logging.getLogger(__name__)


class App:
    def __init__(self, path, token='', webhook_secret=''):
        self.store = Store(path)
        self.token = token
        self.secret = webhook_secret
        self.service = Service(self.store)
        self.client = MaxClient(token) if token else None
        self.bot = Bot(self.store, self.service, self.client) if token else None
        self.cookie_key = (os.getenv('DEMO_COOKIE_KEY') or self.store.demo_cookie_key()).encode()
        self.source_mode = os.getenv('CULTURE_SOURCE_MODE') or 'snapshot'
        if self.source_mode not in ('snapshot', 'demo', 'culture-public', 'pro-culture'):
            raise ValueError('CULTURE_SOURCE_MODE must be snapshot, demo, culture-public or pro-culture')
        self.culture_mode = self.source_mode == 'culture-public'
        if self.source_mode == 'snapshot':
            load_catalog_snapshot(self.store, os.getenv('CATALOG_SNAPSHOT_PATH') or DEFAULT_SNAPSHOT)
        elif self.source_mode == 'demo':
            if not self.store.meta():
                now = datetime.now(timezone.utc)
                self.store.replace_catalog(demo_rows(now), {'kind': 'simulated',
                    'label': 'Учебный набор demo-v1: вымышленные события, не для покупки',
                    'fetchedAt': now.isoformat(), 'sourceUrl': None, 'lastError': None})
        elif self.culture_mode:
            if self.store.meta().get('kind') != 'culture-public':
                # Switching sources must never label the old simulated or PRO
                # rows as real Moscow listings. Profiles/purchases survive.
                self.store.replace_catalog([], {'kind':'unavailable', 'label':'Культура.РФ · сбор Москвы ещё не завершён',
                    'fetchedAt':None, 'sourceUrl':'https://www.culture.ru/afisha/moskva/pushkinskaya-karta',
                    'lastError':'Ожидается первый полный снимок Культура.РФ'})
        else:
            if not (os.getenv('PRO_API_KEY') or os.getenv('PRO_SNAPSHOT_PATH')):
                raise ValueError('pro-culture mode requires PRO_API_KEY or PRO_SNAPSHOT_PATH')
            ensure_catalog(self.store, os.getenv('PRO_API_KEY', ''))

    def identity(self, headers):
        if self.token:
            return validate_max_init(headers.get('X-Max-Init-Data'), self.token), None
        jar = cookies.SimpleCookie()
        try:
            jar.load(headers.get('Cookie', ''))
            value = jar['pushka_demo'].value
            nonce, signature = value.split('.', 1)
            if len(nonce) == 32 and hmac.compare_digest(hmac.new(self.cookie_key, nonce.encode(), 'sha256').hexdigest(), signature):
                return 'demo:' + nonce, None
        except (KeyError, ValueError, cookies.CookieError):
            pass
        nonce = secrets.token_hex(16)
        sig = hmac.new(self.cookie_key, nonce.encode(), 'sha256').hexdigest()
        return 'demo:' + nonce, f'pushka_demo={nonce}.{sig}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000'

    def state_for_app(self, uid):
        return {**self.service.state(uid), 'remindersAvailable': bool(self.token)}

    def dispatch(self, method, path, data, uid):
        if method == 'GET' and path == '/api/state':
            state = self.state_for_app(uid)
            if state['profile']:
                self.store.metric(uid, 'plan_opened')
            return state
        if method == 'PUT' and path == '/api/profile':
            self.service.save_profile(uid, data)
            return self.state_for_app(uid)
        if method == 'POST' and path == '/api/purchase':
            if not isinstance(data, dict):
                raise Invalid('Неверный запрос')
            self.service.purchase(uid, data.get('sessionId'), data.get('actualPrice'))
            return self.state_for_app(uid)
        if method == 'POST' and path == '/api/selected-plan':
            if not isinstance(data, dict):
                raise Invalid('Неверный запрос')
            return {**self.service.select_plan(uid, data.get('mode')), 'remindersAvailable': bool(self.token)}
        if method == 'POST' and path == '/api/reminders':
            if not self.token:
                raise Invalid('Для напоминаний необходим бот MAX')
            if not isinstance(data, dict) or not isinstance(data.get('enabled'), bool):
                raise Invalid('Нужно указать enabled: true или false')
            self.store.update_user(uid, reminders=int(data['enabled']))
            return self.state_for_app(uid)
        if method == 'POST' and path == '/api/track':
            sid = data.get('sessionId') if isinstance(data, dict) else None
            state = self.service.state(uid)
            if not state['profile'] or not any(i['id'] == sid and (
                public_event_page(i.get('sourceUrl')) if i.get('source') == 'culture-public' else i.get('saleLink')
            ) for p in state['plans'].values() for i in p['items']):
                raise Invalid('Нет страницы для проверки этого сеанса')
            self.store.metric(uid, 'source_link_opened')
            return {'ok': True}
        raise FileNotFoundError(path)

    def background(self):
        while True:
            time.sleep(60)
            try:
                if self.culture_mode:
                    meta = self.store.meta()
                    now = datetime.now(timezone.utc)
                    stamp, attempt = meta.get('fetchedAt'), meta.get('lastAttempt')
                    if (not stamp or (now-datetime.fromisoformat(stamp)).total_seconds() >= 12*3600) and (
                            not attempt or (now-datetime.fromisoformat(attempt)).total_seconds() >= 3600):
                        try:
                            sync_culture(self.store)
                        except Exception:
                            log.warning('Moscow public-source sync failed; previous snapshot retained')
                elif self.source_mode == 'pro-culture' and os.getenv('PRO_API_KEY'):
                    ensure_catalog(self.store, os.environ['PRO_API_KEY'])
                if self.token:
                    send_due_reminders(self.store, self.service, self.client)
            except Exception:
                log.exception('Background synchronization/reminders failed')


def handler(app):
    class Handler(BaseHTTPRequestHandler):
        def send(self, status, payload, content_type='application/json; charset=utf-8', cookie=None):
            content = (json.dumps(payload, ensure_ascii=False).encode() if isinstance(payload, (dict, list)) else payload)
            self.send_response(status)
            self.send_header('Content-Type', content_type)
            self.send_header('Content-Length', str(len(content)))
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.send_header('Referrer-Policy', 'no-referrer')
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Content-Security-Policy', "default-src 'self'; script-src 'self' https://st.max.ru; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors https://max.ru https://*.max.ru")
            if cookie:
                self.send_header('Set-Cookie', cookie + ('; Secure' if self.headers.get('X-Forwarded-Proto') == 'https' else ''))
            self.end_headers()
            self.wfile.write(content)

        def execute(self):
            method = self.command
            path = urlsplit(self.path).path
            if path == '/health' and method == 'GET':
                return self.send(200, {'ok': True, 'source': app.store.meta().get('kind')})
            if path == '/max/webhook' and method == 'POST':
                if not app.token or not app.secret or not hmac.compare_digest(self.headers.get('X-Max-Bot-Api-Secret', ''), app.secret):
                    return self.send(403, {'error':'Forbidden'})
                update = self.body()
                if not isinstance(update, dict):
                    raise Invalid('Обновление должно быть объектом')
                # callback id or message id makes retries idempotent.
                mid = ((update.get('message') or {}).get('body') or {}).get('mid')
                delivery = (update.get('callback') or {}).get('callback_id') or mid
                key = str(delivery) if delivery else None
                if key and not app.store.claim_delivery(key, datetime.now(timezone.utc).isoformat()):
                    return self.send(200, {'ok':True, 'duplicate':True})
                try:
                    app.bot.handle(update)
                except Exception:
                    if key:
                        app.store.release_delivery(key)
                    raise
                return self.send(200, {'ok':True})
            if path == '/api/admin/status' and method == 'GET':
                admin = os.getenv('ADMIN_TOKEN', '')
                if not admin or not hmac.compare_digest(self.headers.get('Authorization', ''), 'Bearer ' + admin):
                    return self.send(403, {'error':'Forbidden'})
                rows = app.store.catalog()
                return self.send(200, {'source':app.store.meta(), 'events':len({r['eventId'] for r in rows}), 'sessions':len(rows),
                                       'pricedSessions':sum(r['minPrice'] is not None for r in rows),
                                       'linkedSessions':sum(bool(r['saleLink']) for r in rows),
                                       'sourcePageSessions':sum(public_event_page(r.get('sourceUrl')) for r in rows if r.get('source') == 'culture-public'),
                                       'sync':app.store.latest_culture_sync(), **app.store.stats()})
            if path.startswith('/api/'):
                if method not in ('GET','PUT','POST'):
                    return self.send(405, {'error':'Method not allowed'})
                if method != 'GET':
                    origin = self.headers.get('Origin')
                    host = self.headers.get('Host', '')
                    # Signed MAX initData does not remove the need to block cross-origin browser writes.
                    if origin and urlsplit(origin).netloc != host:
                        return self.send(403, {'error':'Forbidden origin'})
                    if self.headers.get('Content-Type','').split(';')[0].strip() != 'application/json':
                        return self.send(415, {'error':'JSON required'})
                try:
                    uid, cookie = app.identity(self.headers)
                except Invalid as exc:
                    return self.send(401, {'error':str(exc)})
                data = self.body() if method != 'GET' else None
                return self.send(200, app.dispatch(method, path, data, uid), cookie=cookie)
            if method == 'GET' and path in ('/','/index.html','/app.js','/style.css'):
                name = 'index.html' if path == '/' else path[1:]
                p = ROOT / 'static' / name
                return self.send(200, p.read_bytes(), MIMES[p.suffix])
            self.send(404, {'error':'Not found'})

        def body(self):
            length = int(self.headers.get('Content-Length','0'))
            if not 0 < length <= 1000000:
                raise Invalid('Размер JSON не поддерживается')
            return json.loads(self.rfile.read(length))

        def do_GET(self):
            self.guarded()

        def do_POST(self):
            self.guarded()

        def do_PUT(self):
            self.guarded()

        def guarded(self):
            try:
                self.execute()
            except (Invalid, ValueError, json.JSONDecodeError) as exc:
                self.send(400, {'error':str(exc)})
            except FileNotFoundError:
                self.send(404, {'error':'Not found'})
            except Exception:
                log.exception('Request failed')
                self.send(503, {'error':'Сервис временно недоступен; профиль сохранён'})
    return Handler


def main():
    logging.basicConfig(level=logging.INFO)
    token = os.getenv('MAX_BOT_TOKEN', '')
    secret = os.getenv('MAX_WEBHOOK_SECRET', '')
    if token and not secret:
        raise SystemExit('MAX_WEBHOOK_SECRET is required when MAX_BOT_TOKEN is set')
    app = App(os.getenv('PUSHKA_DB', 'data/pushka.sqlite3'), token, secret)
    threading.Thread(target=app.background, daemon=True).start()
    host, port = os.getenv('HOST','0.0.0.0'), int(os.getenv('PORT','8000'))
    print(f'Пушка-план listening on {host}:{port}; source={app.store.meta().get("kind")}', flush=True)
    ThreadingHTTPServer((host,port), handler(app)).serve_forever()


if __name__ == '__main__':
    main()
