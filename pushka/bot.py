"""MAX entry point to the mini-app and outbound notifications; no chat workflow."""
import json
import os
import ssl
from pathlib import Path
from datetime import datetime, timezone
from urllib.parse import urlencode
from urllib.request import Request, urlopen

API = 'https://platform-api2.max.ru'


class MaxClient:
    def __init__(self, token):
        self.token = token
        self.ssl_context = ssl.create_default_context()
        self.ssl_context.load_verify_locations(cafile=str(
            Path(__file__).resolve().parent.parent / 'certs' / 'russian_trusted_root_ca.pem'))

    def call(self, method, path, body=None, query=None):
        url = API + path + ('?' + urlencode(query) if query else '')
        request = Request(url, data=json.dumps(body, ensure_ascii=False).encode() if body is not None else None,
                          headers={'Authorization': self.token, 'Content-Type': 'application/json'}, method=method)
        with urlopen(request, timeout=15, context=self.ssl_context) as response:
            return json.load(response)

    def send(self, uid, text, buttons=None):
        body = {'text': text[:4000]}
        if buttons:
            body['attachments'] = [{'type': 'inline_keyboard', 'payload': {'buttons': buttons}}]
        return self.call('POST', '/messages', body, {'user_id': uid})

    def answer(self, callback_id, notification='Готово'):
        return self.call('POST', '/answers', {'notification': notification}, {'callback_id': callback_id})


def mini_app_button():
    # MAX opens the URL bound to the bot, not an arbitrary caller-provided URL.
    button = {'type': 'open_app', 'text': 'Открыть планы'}
    if os.getenv('MAX_WEB_APP_ID'):
        button['web_app'] = os.environ['MAX_WEB_APP_ID']
    return button


class Bot:
    def __init__(self, store, client):
        self.store, self.client = store, client

    def handle(self, update):
        kind = update.get('update_type')
        if kind not in ('bot_started', 'message_created', 'message_callback'):
            return
        cb = update.get('callback') or {}
        message = update.get('message') or cb.get('message') or {}
        recipient = message.get('recipient') or {}
        sender = (cb.get('user') if kind == 'message_callback' else
                  message.get('sender') or update.get('user')) or {}
        uid = sender.get('user_id')
        chat_type = recipient.get('chat_type', 'dialog')
        if (isinstance(uid, bool) or not isinstance(uid, int) or uid <= 0 or sender.get('is_bot') or
                not isinstance(chat_type, str) or chat_type.lower() != 'dialog'):
            return
        if kind == 'message_callback':
            cbid = cb.get('callback_id')
            if not isinstance(cbid, str) or not cbid:
                return
            # Old chat buttons must not change profiles, purchases or reminders.
            self.client.answer(cbid, 'Все действия доступны в мини-приложении.')
        first_entry = kind == 'bot_started' or (message.get('body') or {}).get('text') == '/start'
        text = ('Привет! Это «Пушка-план». ' if first_entry else '') + (
            'Все действия доступны в мини-приложении: заполните профиль, сравните планы '
            'и отметьте покупки. Нажмите «Открыть планы» ниже.\n\n'
            'План предварительный: сеанс, итоговую цену и наличие билетов проверяйте на странице источника.'
        )
        if self.store.meta().get('kind') == 'simulated':
            text += '\n\nДЕМО: события вымышленные, билеты на них не продаются.'
        self.client.send(uid, text, [[mini_app_button()]])


def send_due_reminders(store, service, client, now=None):
    from .planner import instant
    now = now or datetime.now(timezone.utc)
    with store.db() as db:
        ids = [r['id'] for r in db.execute("SELECT id FROM users WHERE id LIKE 'max:%' AND reminders=1 AND profile IS NOT NULL")]
    for uid in ids:
        state = service.state(uid)
        selected = state['selectedPlan']
        planned = (state['plans'][selected['mode']]['items'] if selected and not selected['needsConfirmation'] else [])
        planned = [i for i in planned if not i.get('purchased')]
        bought = [p['item'] for p in state['purchased'] if p.get('item')]
        for item, kind, threshold in ([(i, 'purchase', 24*3600) for i in planned] +
                                      [(i, 'attendance', 2*3600) for i in bought]):
            delta = (instant(item['startsAt']) - now).total_seconds()
            if 0 < delta <= threshold and store.claim_reminder(uid, item['id'], kind):
                try:
                    note = ('Вы отметили покупку вручную.' if kind == 'attendance' else
                            'Данные устарели — перепроверьте сеанс, цену и билет на странице источника.' if state['source']['stale'] else
                            'Проверьте сеанс, цену и билет на странице источника; покупка не подтверждена.')
                    if state.get('demo'):
                        note += ' ДЕМО: событие вымышленное, билеты не продаются.'
                    client.send(int(uid[4:]), f"Напоминание: {item['title']} скоро начнётся. {note}", [[mini_app_button()]])
                except Exception:
                    with store.db() as db:
                        db.execute('DELETE FROM reminders WHERE user_id=? AND session_id=? AND kind=?', (uid,item['id'],kind))
