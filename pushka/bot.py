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

    def send(self, target_id, text, buttons=None, *, target='user_id'):
        if target not in ('user_id', 'chat_id'):
            raise ValueError('target must be user_id or chat_id')
        body = {'text': text[:4000]}
        if buttons:
            body['attachments'] = [{'type': 'inline_keyboard', 'payload': {'buttons': buttons}}]
        return self.call('POST', '/messages', body, {target: target_id})

    def answer(self, callback_id, notification='Готово'):
        return self.call('POST', '/answers', {'notification': notification}, {'callback_id': callback_id})


def mini_app_button():
    # MAX opens the URL bound to the bot, not an arbitrary caller-provided URL.
    # The live MAX API rejects open_app without web_app (proto.payload).
    # This is the bot's public username, not the mini-app HTTPS URL.
    return {'type': 'open_app', 'text': 'Открыть планы',
            'web_app': os.getenv('MAX_WEB_APP_ID') or 't99_hakaton_max_bot'}


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
        if kind == 'bot_started':
            sender = update.get('user') or {}
            target_id, target = update.get('chat_id'), 'chat_id'
            # bot_started has no Message/Recipient: MAX supplies chat_id on Update.
            chat_type = 'dialog'
        else:
            sender = (cb.get('user') if kind == 'message_callback' else message.get('sender')) or {}
            target_id, target = sender.get('user_id'), 'user_id'
            chat_type = recipient.get('chat_type', 'dialog')
        user_id = sender.get('user_id')
        if (isinstance(user_id, bool) or not isinstance(user_id, int) or user_id <= 0 or sender.get('is_bot') or
                isinstance(target_id, bool) or not isinstance(target_id, int) or target_id <= 0 or
                not isinstance(chat_type, str) or chat_type.lower() != 'dialog'):
            return
        if kind == 'message_callback':
            cbid = cb.get('callback_id')
            if not isinstance(cbid, str) or not cbid:
                return
            # Old chat buttons must not change profiles, purchases or reminders.
            self.client.answer(cbid, 'Все действия доступны в мини-приложении.')
        body = message.get('body') or {}
        first_entry = kind == 'bot_started' or (isinstance(body, dict) and body.get('text') == '/start')
        text = ('Привет! Это «Пушка-план». Все действия доступны в мини-приложении — '
                'нажмите «Открыть планы» ниже.' if first_entry else
                'Бот не принимает сообщения и команды в чате. Все действия доступны только '
                'в мини-приложении — нажмите «Открыть планы» ниже.')
        text += ('\n\nПлан предварительный: сеанс, итоговую цену и наличие билетов '
                 'проверяйте на странице источника.')
        if self.store.meta().get('kind') == 'simulated':
            text += '\n\nДЕМО: события вымышленные, билеты на них не продаются.'
        self.client.send(target_id, text, [[mini_app_button()]], target=target)


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
