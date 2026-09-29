import hashlib
import hmac
import json
import os
import sqlite3
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlencode
from zoneinfo import ZoneInfo
from pushka.catalog import API, demo_rows, normalize_official, sync_official, load_prepared_snapshot
from pushka.planner import plan, conflict, public_event_page
from pushka.service import Invalid, Service, validate_max_init, validate_profile
from pushka.store import Store
from pushka.bot import Bot, show_mode, send_due_reminders
from pushka.server import App, handler
from http.server import ThreadingHTTPServer
from urllib.error import HTTPError
from urllib.request import Request, build_opener, HTTPCookieProcessor
from http.cookiejar import CookieJar
import threading
from unittest.mock import patch
from pushka.setup_max import main as setup_max_main

NOW = datetime(2026, 9, 27, 10, tzinfo=timezone.utc)


def profile(**changes):
    p = {'maxBalance': 3200, 'localeId': 'Москва', 'planningDeadline': '2026-11-20',
         'availability': [{'weekday': w, 'start':'09:00', 'end':'23:00'} for w in range(7)],
         'categoryWeights': {'Спектакли':5, 'Выставки':4, 'Концерты':5, 'Кино':2, 'Экскурсии':3},
         'excludedCategories': [], 'age':18, 'maxEvents':4, 'travelBufferMinutes':30}
    p.update(changes)
    return p


class PlannerTests(unittest.TestCase):
    def setUp(self):
        self.rows = demo_rows(NOW)

    def test_three_modes_feasible_and_repeat_session_not_selected(self):
        result = plan(profile(), self.rows, now=NOW)
        self.assertEqual(3, len(result['plans']))
        for p in result['plans'].values():
            self.assertLessEqual(p['total'], 3200)
            self.assertLessEqual(len(p['items']), 4)
            self.assertEqual(len({i['eventId'] for i in p['items']}), len(p['items']))
            for idx, item in enumerate(p['items']):
                for other in p['items'][idx+1:]:
                    self.assertFalse(conflict(item, other, 30))
            self.assertTrue(all(i['reasons'] for i in p['items']))
        self.assertEqual(result, plan(profile(), self.rows, now=NOW))

    def test_hard_filters_and_diagnostics(self):
        result = plan(profile(age=5, maxBalance=100), self.rows, now=NOW)
        self.assertFalse(result['plans']['interest']['items'])
        self.assertTrue(result['diagnostics']['excludedBy'])
        result = plan(profile(localeId='Казань'), self.rows, now=NOW)
        self.assertEqual(0, result['diagnostics']['eligibleSessions'])
        self.assertIn('город', result['diagnostics']['excludedBy'])

    def test_age_rating_carried_and_eligibility_lock_unchanged(self):
        by_id = {row['id']: row['ageRestriction'] for row in self.rows}
        result = plan(profile(), self.rows, now=NOW)
        for mode, p in result['plans'].items():
            self.assertTrue(p['items'], mode)
            for item in p['items']:
                self.assertEqual(item['ageRestriction'], by_id[item['id']], mode)
        # Event rating still gates sessions: a 15-year-old loses 16+ but keeps public 12+ cards.
        restricted = plan(profile(age=15), self.rows, now=NOW)
        self.assertIn('возраст', restricted['diagnostics']['excludedBy'])
        self.assertTrue(all(item['ageRestriction'] == by_id[item['id']] and item['ageRestriction'] <= 15
                            for p in restricted['plans'].values() for item in p['items']))
        self.assertTrue(any(item['ageRestriction'] == 12
                            for p in restricted['plans'].values() for item in p['items']))
        # The 14-22 cardholder window never gates public cards: a 25-year-old still receives plans.
        self.assertTrue(all(p['items'] for p in plan(profile(age=25), self.rows, now=NOW)['plans'].values()))
        public_row = {**self.rows[0], 'source': 'culture-public',
                      'sourceUrl': 'https://www.culture.ru/events/7219156/koncert-da-zdravstvuet-meksika', 'saleLink': None}
        public = plan(profile(age=15), [public_row] + self.rows[1:], now=NOW)
        self.assertTrue(any(item['id'] == public_row['id'] and item['ageRestriction'] == public_row['ageRestriction']
                            for p in public['plans'].values() for item in p['items']))
        # Lock behavior unchanged: a purchased item keeps its rating in every mode.
        first = result['plans']['interest']['items'][0]
        purchased = [{'sessionId': first['id'], 'actualPrice': first['price'],
                      'item': {**first, 'price': first['price'], 'purchased': True}}]
        locked = plan(profile(), self.rows, purchased, NOW)
        for mode, p in locked['plans'].items():
            locked_item = next(i for i in p['items'] if i['id'] == first['id'])
            self.assertTrue(locked_item.get('purchased'), mode)
            self.assertEqual(locked_item['ageRestriction'], by_id[first['id']], mode)

    def test_budget_price_unknown_link_and_approval(self):
        from copy import deepcopy
        rows = deepcopy(self.rows[:4])
        rows[0]['minPrice'] = None
        rows[1]['source'] = 'pro-culture'; rows[1]['saleLink'] = None
        rows[2]['approved'] = False
        rows[3]['minPrice'] = 99999
        result = plan(profile(), rows, now=NOW)
        self.assertFalse(result['plans']['interest']['items'])
        self.assertEqual(set(result['diagnostics']['excludedBy']), {'неизвестная цена','нет страницы источника или ссылки для проверки','нет подтверждения участия','бюджет'})

    def test_public_afisha_uses_event_page_without_seller(self):
        row = {**self.rows[0], 'source':'culture-public', 'sourceUrl':'https://www.culture.ru/events/7219156/koncert-da-zdravstvuet-meksika', 'saleLink':None}
        result = plan(profile(), [row], now=NOW)
        item = result['plans']['interest']['items'][0]
        self.assertEqual(item['sourceUrl'], row['sourceUrl'])
        self.assertIsNone(item['saleLink'])
        self.assertEqual(item['source'], 'culture-public')
        text, buttons = show_mode({'plans':result['plans'], 'demo':False, 'source':{'kind':'culture-public','stale':False},
                                   'remindersEnabled':False, 'diagnostics':result['diagnostics']}, 'interest')
        self.assertIn('Предварительный план', text)
        self.assertTrue(any(button.get('url') == row['sourceUrl'] and 'Проверить' in button['text']
                            for group in buttons for button in group))
        self.assertNotIn('Купить билет', str(buttons))
        for bad in ('http://www.culture.ru/events/7219156/test', 'https://evil.example/events/7219156/test',
                    'https://www.culture.ru.evil.example/events/7219156/test', 'https://www.culture.ru/institutes/25295/test',
                    'https://www.culture.ru@evil.example/events/7219156/test'):
            self.assertFalse(public_event_page(bad))
            rejected = plan(profile(), [{**row, 'sourceUrl':bad, 'saleLink':'https://seller.example/ticket'}], now=NOW)
            self.assertFalse(rejected['plans']['interest']['items'])

    def test_availability_window_requires_whole_session(self):
        row = self.rows[0]
        local = datetime.fromisoformat(row['startsAt']).astimezone(ZoneInfo('Europe/Moscow'))
        p = profile(availability=[{'date':local.date().isoformat(),'start':'18:00','end':'19:00'}], maxEvents=1)
        result = plan(p, [row], now=NOW)
        self.assertFalse(result['plans']['interest']['items'])

    def test_purchase_lock_with_actual_price_and_conflict(self):
        initial = plan(profile(), self.rows, now=NOW)
        first = initial['plans']['interest']['items'][0]
        purchased = [{'sessionId':first['id'],'actualPrice':1900,'item':{**first,'price':1900,'purchased':True}}]
        result = plan(profile(), self.rows, purchased, NOW)
        self.assertEqual(result['remainingBalance'], 1300)
        for mode in result['plans'].values():
            self.assertTrue(any(i['id'] == first['id'] and i.get('purchased') for i in mode['items']))
            self.assertLessEqual(mode['total'], 1300)
            self.assertTrue(all(not conflict(first, i, 30) for i in mode['items'] if i['id'] != first['id']))

    def test_unwanted_category_cannot_fill_spend_mode(self):
        weights = {name:1 for name in ('Спектакли','Выставки','Концерты','Кино','Экскурсии')}
        result = plan(profile(categoryWeights=weights), self.rows, now=NOW)
        self.assertTrue(all(not p['items'] for p in result['plans'].values()))
        self.assertIn('порога интереса', result['diagnostics']['message'])

    def test_same_day_buffer(self):
        a = {'eventId':'a','startsAt':NOW.isoformat(),'endsAt':(NOW+timedelta(hours=1)).isoformat()}
        b = {'eventId':'b','startsAt':(NOW+timedelta(hours=1,minutes=20)).isoformat(),'endsAt':(NOW+timedelta(hours=2)).isoformat()}
        self.assertTrue(conflict(a,b,30))
        self.assertFalse(conflict(a,b,15))


class ServiceTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = Store(Path(self.tmp.name)/'test.db')
        self.store.replace_catalog(demo_rows(datetime.now(timezone.utc)), {'kind':'simulated','label':'Демо', 'fetchedAt':datetime.now(timezone.utc).isoformat()})
        self.service = Service(self.store)
        self.today = datetime.now(timezone.utc)
        self.profile = profile(planningDeadline=(self.today+timedelta(days=60)).date().isoformat())

    def tearDown(self):
        self.tmp.cleanup()

    def test_persistence_purchase_idempotency_and_replan(self):
        state = self.service.save_profile('user1', self.profile)
        first = state['plans']['interest']['items'][0]
        bought = self.service.purchase('user1', first['id'], first['price']+100)
        self.assertEqual(bought['remainingBalance'], self.profile['maxBalance']-first['price']-100)
        self.assertEqual(len(bought['purchased']), 1)
        self.assertEqual(len(self.service.purchase('user1',first['id'],first['price']+100)['purchased']),1)
        with self.assertRaises(Invalid):
            self.service.purchase('user1', first['id'],first['price']+200)
        self.assertEqual(len(Service(self.store).state('user1')['purchased']),1)

    def test_selected_plan_is_explicit_and_requires_confirmation_after_changes(self):
        state = self.service.save_profile('max:42', self.profile)
        self.assertIsNone(state['selectedPlan'])
        with self.assertRaises(Invalid):
            self.service.select_plan('max:42', 'unknown')
        chosen = self.service.select_plan('max:42', 'interest')
        self.assertFalse(chosen['selectedPlan']['needsConfirmation'])
        self.assertEqual(chosen['selectedPlan']['mode'], 'interest')
        self.assertEqual(chosen['selectedPlan'], Service(self.store).state('max:42')['selectedPlan'])
        self.assertIsNone(self.service.state('max:other')['selectedPlan'])
        selected_id = chosen['plans']['interest']['items'][0]['id']
        self.store.replace_catalog([{**r, 'minPrice': r['minPrice']+100 if r['id'] == selected_id else r['minPrice']}
                                    for r in self.store.catalog()], self.store.meta())
        self.assertTrue(self.service.state('max:42')['selectedPlan']['needsConfirmation'])
        self.assertFalse(self.service.select_plan('max:42', 'interest')['selectedPlan']['needsConfirmation'])
        self.assertIsNone(self.service.save_profile('max:42', self.profile)['selectedPlan'])

    def test_existing_sqlite_user_table_is_migrated(self):
        path = Path(self.tmp.name)/'legacy.db'
        with sqlite3.connect(path) as db:
            db.execute('CREATE TABLE users (id TEXT PRIMARY KEY, profile TEXT, stage TEXT, draft TEXT, reminders INTEGER NOT NULL DEFAULT 0)')
            db.execute("INSERT INTO users(id) VALUES ('max:42')")
        migrated = Store(path)
        self.assertIsNone(migrated.user('max:42')['selected_plan'])
        migrated.update_user('max:42', selected_plan='{}')
        self.assertEqual(migrated.user('max:42')['selected_plan'], '{}')

    def test_reminders_are_for_confirmed_selection_and_purchases(self):
        now = datetime.now(timezone.utc)
        row = {**demo_rows(now)[0], 'startsAt':(now+timedelta(minutes=75)).isoformat(),
               'endsAt':(now+timedelta(minutes=105)).isoformat()}
        self.store.replace_catalog([row], {'kind':'simulated','label':'Демо','fetchedAt':(now-timedelta(hours=13)).isoformat()})
        p = profile(planningDeadline=(now+timedelta(days=3)).date().isoformat(),
                    availability=[{'weekday':w,'start':'00:00','end':'23:59'} for w in range(7)])
        self.service.save_profile('max:42', p)
        self.store.update_user('max:42', reminders=1)
        class FakeClient:
            sent = []
            def send(self, uid, text):
                self.sent.append((uid,text))
        client = FakeClient()
        send_due_reminders(self.store, self.service, client, now)
        self.assertEqual(client.sent, [])  # Viewing a mode does not opt in to its events.
        state = self.service.select_plan('max:42','interest')
        item = state['plans']['interest']['items'][0]
        send_due_reminders(self.store, self.service, client, now)
        self.assertEqual(len(client.sent),1)
        self.assertIn('Данные устарели',client.sent[0][1])
        send_due_reminders(self.store, self.service, client, now)
        self.assertEqual(len(client.sent),1)
        self.service.purchase('max:42', item['id'], item['price'])
        send_due_reminders(self.store, self.service, client, now)
        self.assertEqual(len(client.sent),2)
        self.assertIn('покупку вручную',client.sent[-1][1])

    def test_changed_catalog_does_not_remind_about_replacement(self):
        now = datetime.now(timezone.utc)
        rows = demo_rows(now)[:2]
        for i, row in enumerate(rows):
            row['startsAt'] = (now+timedelta(hours=i+3)).isoformat()
            row['endsAt'] = (now+timedelta(hours=i+3, minutes=90)).isoformat()
        self.store.replace_catalog(rows, {'kind':'simulated','label':'Демо','fetchedAt':now.isoformat()})
        p = profile(planningDeadline=(now+timedelta(days=3)).date().isoformat(),
                    availability=[{'weekday':w,'start':'00:00','end':'23:59'} for w in range(7)])
        state = self.service.save_profile('max:42', p)
        self.assertTrue(state['plans']['interest']['items'])
        self.service.select_plan('max:42', 'interest')
        self.store.update_user('max:42', reminders=1)
        # Replace a chosen session with a different schedule: do not silently
        # promote the newly computed plan to the user's confirmed selection.
        chosen_id = state['plans']['interest']['items'][0]['id']
        changed = [{**r, 'startsAt':(now+timedelta(hours=10)).isoformat(),
                    'endsAt':(now+timedelta(hours=11)).isoformat()} if r['id'] == chosen_id else r for r in rows]
        self.store.replace_catalog(changed, self.store.meta())
        self.assertTrue(self.service.state('max:42')['selectedPlan']['needsConfirmation'])
        class FakeClient:
            sent = []
            def send(self, uid, text):
                self.sent.append((uid,text))
        client = FakeClient()
        send_due_reminders(self.store, self.service, client, now)
        self.assertEqual(client.sent, [])

    def test_public_afisha_track_and_manual_purchase_without_seller(self):
        rows = demo_rows(self.today)
        row = {**rows[0], 'source':'culture-public', 'sourceUrl':'https://www.culture.ru/events/7219156/koncert-da-zdravstvuet-meksika', 'saleLink':None}
        self.store.replace_catalog([row], {'kind':'culture-public', 'label':'Культура.РФ · публичная афиша', 'fetchedAt':self.today.isoformat()})
        state = self.service.save_profile('user1', self.profile)
        item = state['plans']['interest']['items'][0]
        app = App(Path(self.tmp.name)/'test.db')
        self.assertEqual(app.dispatch('POST','/api/track', {'sessionId':item['id']}, 'user1'), {'ok':True})
        bought = self.service.purchase('user1',item['id'],item['price']+100)
        self.assertEqual(bought['remainingBalance'], self.profile['maxBalance']-item['price']-100)

    def test_invalid_profile_and_purchase(self):
        with self.assertRaises(Invalid):
            validate_profile({**self.profile,'maxEvents':15})
        with self.assertRaises(Invalid):
            validate_profile({**self.profile,'availability':[{'weekday':6,'start':'19:00','end':'08:00'}]})
        self.service.save_profile('user1', self.profile)
        with self.assertRaises(Invalid):
            self.service.purchase('user1','arbitrary-id',100)
        with self.assertRaises(Invalid):
            self.service.purchase('user1','arbitrary-id',-1)

    def test_atomic_sync_keeps_previous_catalog(self):
        initial = self.store.catalog()
        def failed(url):
            raise OSError('offline')
        with self.assertRaises(OSError):
            sync_official(self.store,'secret',now=self.today,fetch=failed)
        self.assertEqual(initial,self.store.catalog())

    def test_official_sync_paginates_and_preserves_source(self):
        calls = []
        def fetch(url):
            from urllib.parse import parse_qs, urlsplit
            params = parse_qs(urlsplit(url).query)
            calls.append(int(params['offset'][0]))
            sample = {'id':1,'name':'Концерт','category':{'name':'Концерты'},'ageRestriction':12,'statusPushka':True,'isPublished':True,'inAccepted':True,
                'price':500,'maxPrice':1000,'places':[{'id':3,'name':'Зал','locale':{'id':77},'saleLink':'https://tickets.example/1',
                'seances':[{'start':int((self.today+timedelta(days=2)).timestamp()*1000),'end':int((self.today+timedelta(days=2,hours=2)).timestamp()*1000)}]}]}
            return {'events':[sample]}
        self.assertEqual(sync_official(self.store,'secret',now=self.today,fetch=fetch),1)
        self.assertEqual(calls,[0])
        self.assertEqual(self.store.catalog()[0]['raw']['name'],'Концерт')
        self.assertEqual(self.store.meta()['kind'],'pro-culture')

    def test_prepared_snapshot_is_not_labeled_live(self):
        path = Path(self.tmp.name)/'prepared.json'
        sample = {'id':10,'name':'Событие','category':{'name':'Концерты'},'ageRestriction':12,'statusPushka':True,'isPublished':True,'inAccepted':True,
                  'price':500,'maxPrice':500,'places':[{'id':9,'name':'Зал','locale':{'id':77},'saleLink':'https://tickets.example/10',
                  'seances':[{'start':int((self.today+timedelta(days=2)).timestamp()*1000),'end':int((self.today+timedelta(days=2,hours=2)).timestamp()*1000)}]}]}
        path.write_text(json.dumps({'sourceUrl':API,'fetchedAt':self.today.isoformat(),'events':[sample]}))
        self.assertEqual(load_prepared_snapshot(self.store, path),1)
        self.assertEqual(self.store.meta()['kind'],'pro-culture-prepared')
        self.assertEqual(self.store.catalog()[0]['saleLink'],'https://tickets.example/10')

    def test_official_adapter_fails_closed(self):
        event = {'id':1,'name':'Тест','category':{'name':'Концерты'},'ageRestriction':12,'statusPushka':True,'isPublished':True,'inAccepted':True,
                 'price':500,'maxPrice':1000,'places':[{'id':3,'name':'Театр','locale':{'id':77,'timezone':'Europe/Moscow'},'saleLink':'https://tickets.example/1',
                 'seances':[{'start':int((self.today+timedelta(days=2)).timestamp()*1000),'end':int((self.today+timedelta(days=2,hours=2)).timestamp()*1000)}]}]}
        row = normalize_official(event,self.today.isoformat())[0]
        self.assertFalse(row['exactPriceKnown'])
        self.assertEqual(row['minPrice'],500)
        self.assertEqual(row['localeId'],'77')
        self.assertEqual(normalize_official({**event,'isPublished':False}, self.today.isoformat()),[])


class AuthAndBotTests(unittest.TestCase):
    def test_reminder_uses_confirmed_mode_not_interest_mode(self):
        with tempfile.TemporaryDirectory() as path:
            store = Store(Path(path)/'bot.db')
            store.update_user('max:42', profile='{}', reminders=1)
            now = datetime.now(timezone.utc)
            when = (now+timedelta(hours=1)).isoformat()
            def event(sid):
                return {'id':sid, 'title':sid, 'startsAt':when}
            class FakeService:
                def state(self, uid):
                    return {'selectedPlan':{'mode':'spend','needsConfirmation':False},
                            'plans':{'interest':{'items':[event('wrong')]},
                                     'spend':{'items':[event('right')]}},
                            'purchased':[], 'source':{'stale':False}}
            class FakeClient:
                sent = []
                def send(self, uid, text):
                    self.sent.append((uid,text))
            client = FakeClient()
            send_due_reminders(store, FakeService(), client, now)
            self.assertEqual(len(client.sent), 1)
            self.assertIn('right', client.sent[0][1])
            self.assertNotIn('wrong', client.sent[0][1])

    def test_max_signature_freshness_and_duplicates(self):
        now = datetime.now(timezone.utc)
        params = {'auth_date':str(int(now.timestamp())),'user':json.dumps({'id':42,'first_name':'Маша'},ensure_ascii=False)}
        check = '\n'.join(f'{k}={v}' for k,v in sorted(params.items()))
        secret = hmac.new(b'WebAppData', b'token', hashlib.sha256).digest()
        params['hash'] = hmac.new(secret, check.encode(), hashlib.sha256).hexdigest()
        raw = urlencode(params)
        self.assertEqual(validate_max_init(raw,'token',now), 'max:42')
        for bad in (raw+'&hash=abc', raw.replace('42','43'), raw.replace('auth_date','wrong')):
            with self.assertRaises(Invalid):
                validate_max_init(bad,'token',now)
        with self.assertRaises(Invalid):
            validate_max_init(raw,'token',now+timedelta(hours=2))

    def test_bot_full_chat_flow(self):
        with tempfile.TemporaryDirectory() as path:
            db = Store(Path(path)/'bot.db')
            now = datetime.now(timezone.utc)
            db.replace_catalog(demo_rows(now), {'kind':'simulated','label':'Демо','fetchedAt':now.isoformat()})
            class FakeClient:
                sent = []
                def send(self, uid, text, buttons=None):
                    self.sent.append((uid,text,buttons))
                def answer(self, cid, notification='Готово'):
                    pass
            client = FakeClient()
            bot = Bot(db, Service(db), client)
            def msg(text):
                bot.handle({'update_type':'message_created','message':{'sender':{'user_id':42},'recipient':{'chat_type':'dialog'},'body':{'text':text}}})
            msg('/plan')
            for answer in ('3200','Москва',(now+timedelta(days=60)).date().isoformat(),'1,2,3,4,5,6,7','18','Спектакли=5, Выставки=4','нет','4','нет'):
                msg(answer)
            state = Service(db).state('max:42')
            self.assertTrue(state['profile'])
            self.assertTrue(state['plans']['interest']['items'])
            self.assertIn('По интересам',client.sent[-1][1])
            sid = state['plans']['interest']['items'][0]['id']
            bot.handle({'update_type':'message_callback','callback':{'user':{'user_id':42},'callback_id':'choose:1','payload':'choose:interest'},'message':{'recipient':{'chat_type':'dialog'}}})
            self.assertFalse(Service(db).state('max:42')['selectedPlan']['needsConfirmation'])
            bot.handle({'update_type':'message_callback','callback':{'user':{'user_id':42},'callback_id':'cb1','payload':'purchased:'+sid},'message':{'recipient':{'chat_type':'dialog'}}})
            msg('1300')
            self.assertEqual(len(Service(db).state('max:42')['purchased']),1)


class ProductionAuthTests(unittest.TestCase):
    def test_http_max_signature_and_webhook_secret(self):
        with tempfile.TemporaryDirectory() as path:
            # Authentication does not depend on the bundled snapshot's calendar dates.
            with patch.dict(os.environ, {'CULTURE_SOURCE_MODE':'demo'}):
                app = App(Path(path)/'prod.db','max-token','secret-webhook')
            received = []
            app.bot.handle = received.append
            server = ThreadingHTTPServer(('127.0.0.1',0), handler(app))
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            base = 'http://127.0.0.1:'+str(server.server_port)
            try:
                with self.assertRaises(HTTPError) as err:
                    build_opener().open(base+'/api/state')
                self.assertEqual(err.exception.code,401)
                now = datetime.now(timezone.utc)
                params = {'auth_date':str(int(now.timestamp())), 'user':json.dumps({'id':42})}
                key = hmac.new(b'WebAppData',b'max-token',hashlib.sha256).digest()
                params['hash'] = hmac.new(key, '\n'.join(f'{k}={v}' for k,v in sorted(params.items())).encode(),hashlib.sha256).hexdigest()
                init_data = urlencode(params)
                with build_opener().open(Request(base+'/api/state',headers={'X-Max-Init-Data':init_data})) as response:
                    self.assertIsNone(json.load(response)['profile'])
                p = profile(planningDeadline=(now+timedelta(days=60)).date().isoformat())
                headers = {'X-Max-Init-Data':init_data, 'Content-Type':'application/json', 'Origin':base}
                def signed_post(path, data, method='POST'):
                    return json.load(build_opener().open(Request(base+path, data=json.dumps(data).encode(),
                        headers=headers, method=method)))
                signed_post('/api/profile', p, 'PUT')
                selected = signed_post('/api/selected-plan', {'mode':'interest'})
                self.assertFalse(selected['selectedPlan']['needsConfirmation'])
                self.assertEqual(selected['selectedPlan']['mode'], 'interest')
                update = {'update_type':'message_created','message':{'body':{'mid':'mid-1'}}}
                request = Request(base+'/max/webhook',data=json.dumps(update).encode(),headers={'Content-Type':'application/json','X-Max-Bot-Api-Secret':'secret-webhook'})
                self.assertTrue(json.load(build_opener().open(request))['ok'])
                self.assertTrue(json.load(build_opener().open(request))['duplicate'])
                self.assertEqual(len(received),1)
            finally:
                server.shutdown(); server.server_close(); thread.join(timeout=2)


class SetupMaxTests(unittest.TestCase):
    def test_register_requires_valid_secret_and_https_origin(self):
        with patch.dict(os.environ, {'MAX_BOT_TOKEN':'token','MAX_WEBHOOK_SECRET':'bad!',
                                   'PUBLIC_URL':'https://demo.apigw.yandexcloud.net'}):
            with self.assertRaises(SystemExit):
                setup_max_main()
        with patch.dict(os.environ, {'MAX_BOT_TOKEN':'token','MAX_WEBHOOK_SECRET':'valid-secret',
                                   'PUBLIC_URL':'https://demo.apigw.yandexcloud.net/path'}):
            with self.assertRaises(SystemExit):
                setup_max_main()
        with patch.dict(os.environ, {'MAX_BOT_TOKEN':'token','MAX_WEBHOOK_SECRET':'valid-secret',
                                   'PUBLIC_URL':'https://demo.apigw.yandexcloud.net'}):
            with patch('pushka.setup_max.MaxClient') as client, patch('builtins.print'):
                setup_max_main()
                self.assertEqual(client.return_value.call.call_count, 2)
                self.assertEqual(client.return_value.call.call_args.args[:2], ('POST','/subscriptions'))
                self.assertEqual(client.return_value.call.call_args.args[2]['url'],
                                 'https://demo.apigw.yandexcloud.net/max/webhook')


class HTTPTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        with patch.dict(os.environ, {'CULTURE_SOURCE_MODE':'demo'}):
            self.app = App(Path(self.tmp.name)/'http.db')
        self.server = ThreadingHTTPServer(('127.0.0.1',0), handler(self.app))
        self.thread = threading.Thread(target=self.server.serve_forever,daemon=True)
        self.thread.start()
        self.base = 'http://127.0.0.1:'+str(self.server.server_port)
        self.client = build_opener(HTTPCookieProcessor(CookieJar()))

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
        self.tmp.cleanup()

    def test_demo_cookie_isolation_and_csrf(self):
        def send(client, path, data=None, method=None, origin=None):
            headers = {'Content-Type':'application/json'} if data is not None else {}
            if origin: headers['Origin'] = origin
            req = Request(self.base+path, data=json.dumps(data).encode() if data is not None else None, headers=headers, method=method)
            return json.load(client.open(req))
        self.assertFalse(send(self.client,'/api/state')['profile'])
        today = datetime.now(timezone.utc)
        p = profile(planningDeadline=(today+timedelta(days=60)).date().isoformat())
        state = send(self.client,'/api/profile',p,'PUT',self.base)
        self.assertTrue(state['profile'])
        other = build_opener(HTTPCookieProcessor(CookieJar()))
        self.assertFalse(send(other,'/api/state')['profile'])
        with self.assertRaises(HTTPError) as error:
            send(self.client,'/api/profile',p,'PUT','https://evil.example')
        self.assertEqual(error.exception.code, 403)
        with self.assertRaises(HTTPError) as error:
            send(self.client,'/max/webhook',{},'POST')
        self.assertEqual(error.exception.code, 403)
        with self.assertRaises(HTTPError) as error:
            self.client.open(self.base+'/api/admin/status')
        self.assertEqual(error.exception.code, 403)
        with self.assertRaises(HTTPError) as error:
            send(self.client,'/api/track',{'sessionId':'arbitrary-id'},'POST',self.base)
        self.assertEqual(error.exception.code, 400)


if __name__ == '__main__':
    unittest.main()
