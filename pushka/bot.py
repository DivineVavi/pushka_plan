"""MAX personal-chat conversational UI; webhook and local polling share a handler."""
import json
import os
import re
import ssl
from pathlib import Path
from datetime import datetime, timedelta, timezone
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from .service import Invalid, integer

API = 'https://platform-api2.max.ru'
STEPS = ('balance','locale','deadline','availability','age','weights','excluded','maxEvents','distance')
QUESTIONS = {
    'balance': 'Введите остаток Пушкинской карты вручную: от 0 до 5000 рублей (например, 3200). Это не банковский баланс.',
    'locale': 'Город: в московском пилоте укажите Москва.',
    'deadline': 'До какой даты планируем? Формат ГГГГ-ММ-ДД, не дальше 90 дней.',
    'availability': 'Свободные дни через запятую: ГГГГ-ММ-ДД или дни недели 1–7 (пн–вс). Время каждого дня по умолчанию 09:00–23:00; его можно изменить в мини‑приложении.',
    'age': 'Сколько вам лет? Укажите возраст от 14 до 22 лет включительно.',
    'weights': 'Интересы: категория=оценка 1–5, через запятую (Спектакли=5, Концерты=4). Названия категорий покажу ниже.',
    'excluded': 'Какие категории исключить? Через запятую или «нет».',
    'maxEvents': 'Сколько событий максимум в плане? От 1 до 4.',
    'distance': 'Ограничение по расстоянию: отправьте «нет» или широта,долгота;километры (например, 55.75,37.61;20). Буфер переезда по умолчанию 30 минут.',
}


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


def callback(text, payload):
    return {'type': 'callback', 'text': text, 'payload': payload}


def mini_app_button():
    # MAX opens the URL bound to the bot, not an arbitrary caller-provided URL.
    button = {'type': 'open_app', 'text': 'Открыть планы'}
    if os.getenv('MAX_WEB_APP_ID'):
        button['web_app'] = os.environ['MAX_WEB_APP_ID']
    return button


def parse_step(step, text, draft):
    text = text.strip()
    if step == 'balance':
        draft['maxBalance'] = integer(text, 0, 5000, 'Остаток')
    elif step == 'locale':
        draft['localeId'] = text
    elif step == 'deadline':
        draft['planningDeadline'] = text
    elif step == 'availability':
        rules = []
        for part in text.split(','):
            part = part.strip()
            if re.fullmatch('[1-7]', part):
                rules.append({'weekday': int(part)-1, 'start': '09:00', 'end': '23:00'})
            else:
                rules.append({'date': part, 'start': '09:00', 'end': '23:00'})
        draft['availability'] = rules
    elif step == 'age':
        draft['age'] = integer(text, 14, 22, 'Возраст')
    elif step == 'weights':
        draft['categoryWeights'] = {name.strip(): int(weight.strip()) for name, weight in (part.split('=', 1) for part in text.split(','))}
    elif step == 'excluded':
        draft['excludedCategories'] = [] if text.casefold() == 'нет' else [x.strip() for x in text.split(',') if x.strip()]
    elif step == 'maxEvents':
        draft['maxEvents'] = int(text)
    elif step == 'distance':
        if text.casefold() != 'нет':
            coords, limit = text.split(';', 1)
            lat, lon = coords.split(',', 1)
            draft.update(latitude=float(lat), longitude=float(lon), maxDistanceKm=float(limit))
        draft['travelBufferMinutes'] = 30
    return draft


def show_mode(state, mode):
    mode_name = {'interest':'По интересам','more':'Больше впечатлений','spend':'Почти без остатка'}[mode]
    p = state['plans'][mode]
    lines = [f'План «{mode_name}»', 'Остаток введён вами вручную; это не данные банка.']
    age = (state.get('profile') or {}).get('age')
    if age is not None and not 14 <= age <= 22:
        lines.append('Программа Пушкинской карты рассчитана на возраст 14–22 года; возрастная маркировка событий проверяется отдельно.')
    for item in p['items']:
        from .planner import instant
        from zoneinfo import ZoneInfo
        when = instant(item['startsAt']).astimezone(ZoneInfo(item.get('timezone') or 'Europe/Moscow')).strftime('%d.%m %H:%M')
        lines.append(f"{when} — {item['title']} — {'от ' if not item['exactPriceKnown'] and not item.get('purchased') else ''}{item['price']} ₽{' · куплено' if item.get('purchased') else ''}\nПочему: {'; '.join(item['reasons'][:2])}")
    if not p['items']:
        if state['diagnostics'].get('sourceSessions') == 0 and (state['source']['kind'] == 'unavailable' or state['source'].get('error')):
            lines.append('Каталог ещё не загружен или источник недоступен. Профиль сохранён; попробуйте позже.')
        else:
            lines.append('Подходящих событий нет. ' + state['diagnostics'].get('message', ''))
    if state.get('selectedPlan') and state['selectedPlan']['needsConfirmation']:
        lines.append('Ранее выбранный план изменился. Подтвердите новый состав для напоминаний о покупке.')
    if state['source']['kind'] in ('culture-public', 'culture-public-prepared'):
        lines.append(f"Плановая сумма от: {p['total']} ₽ · расчётный остаток до: {p['leftover']} ₽ (если билеты доступны по минимальной цене)")
    else:
        lines.append(f"Новые билеты: {p['total']} ₽ · после плана останется: {p['leftover']} ₽")
    if state['demo']:
        lines.append('ДЕМО: вымышленные события; нет переходов на покупку.')
    elif state['source']['kind'] in ('culture-public', 'culture-public-prepared'):
        lines.append('Предварительный план: на странице Культура.РФ проверьте сеанс, итоговую цену, возможность оплаты картой и наличие билетов.' + (' Данные устарели.' if state['source']['stale'] else ''))
    elif state['source']['stale']:
        lines.append('Данные устарели: проверьте цену и время у продавца.')
    buttons = [[callback('По интересам','mode:interest'), callback('Больше','mode:more'), callback('Без остатка','mode:spend')]]
    for item in p['items']:
        if not item.get('purchased'):
            buttons.append([callback('Купил · ' + item['title'][:25], 'purchased:' + item['id'])])
            link = item.get('sourceUrl') if item.get('source') == 'culture-public' else item.get('saleLink')
            if link:
                buttons.append([{'type':'link', 'text':'Проверить расписание и билеты ↗' if item.get('source') == 'culture-public' else 'Проверить билеты ↗', 'url':link}])
    if any(not item.get('purchased') for item in p['items']):
        selected = state.get('selectedPlan') or {}
        active = selected.get('mode') == mode and not selected.get('needsConfirmation')
        buttons.append([callback('Выбран для напоминаний ✓' if active else 'Напоминать об этом плане', 'choose:' + mode)])
    buttons.append([callback('Напоминания ' + ('✓' if state['remindersEnabled'] else '+'), 'remind:toggle')])
    buttons.append([mini_app_button()])
    return '\n\n'.join(lines), buttons


class Bot:
    def __init__(self, store, service, client):
        self.store, self.service, self.client = store, service, client

    def handle(self, update):
        kind = update.get('update_type')
        message = update.get('message') or (update.get('callback') or {}).get('message') or {}
        recipient = message.get('recipient') or {}
        sender = (update.get('callback') or {}).get('user') or message.get('sender') or update.get('user') or {}
        uid = sender.get('user_id')
        if not isinstance(uid, int) or uid <= 0 or recipient.get('chat_type','dialog').lower() != 'dialog':
            return
        key = 'max:' + str(uid)
        if kind == 'message_callback':
            cb = update.get('callback') or {}
            cbid = cb.get('callback_id')
            if not cbid:
                return
            # Acknowledge even if the update is repeated or out of order.
            self.client.answer(cbid)
            action = cb.get('payload', '')
            if action.startswith('mode:') and action[5:] in ('interest','more','spend'):
                state = self.service.state(key)
                if state['profile']:
                    text, buttons = show_mode(state, action[5:])
                    self.client.send(uid, text, buttons)
            elif action.startswith('purchased:'):
                sid = action[len('purchased:'):]
                state = self.service.state(key)
                valid = state['profile'] and any(i['id'] == sid and not i.get('purchased') for p in state['plans'].values() for i in p['items'])
                if valid:
                    self.store.update_user(key, stage='purchase', draft=json.dumps({'sessionId': sid}))
                    self.client.send(uid, 'Введите фактическую цену покупки в рублях. Даже если цена совпала, укажите её числом. /cancel — отменить.')
                else:
                    self.client.send(uid, 'Этот сеанс уже куплен или план изменился. Напишите /show.')
            elif action.startswith('choose:') and action[7:] in ('interest', 'more', 'spend'):
                try:
                    state = self.service.select_plan(key, action[7:])
                    body, buttons = show_mode(state, action[7:])
                    self.client.send(uid, 'Вариант выбран для напоминаний.\n\n' + body, buttons)
                except Invalid as exc:
                    self.client.send(uid, str(exc))
            elif action == 'remind:toggle':
                state = self.service.state(key)
                enabled = not state['remindersEnabled']
                self.store.update_user(key, reminders=int(enabled))
                note = '' if not enabled or state['selectedPlan'] and not state['selectedPlan']['needsConfirmation'] else '. Для напоминаний о покупке выберите план кнопкой «Напоминать об этом плане»'
                self.client.send(uid, 'Напоминания ' + ('включены' if enabled else 'отключены') + note)
            return
        if kind not in ('message_created','bot_started'):
            return
        text = ((message.get('body') or {}).get('text') or '/start').strip()
        row = self.store.user(key)
        if text in ('/start','/help'):
            demo_note = ' Демо-набор вымышленный.' if self.service.store.meta().get('kind') == 'simulated' else ''
            self.client.send(uid, 'Привет! «Пушка‑план» составляет план событий под ваш вручную указанный остаток и свободное время. Откройте мини-приложение кнопкой «Открыть планы», заполните профиль и сравните варианты. /plan — заполнить профиль в чате, /show — планы, /cancel — отменить ввод. План предварительный: сеанс, цену и билеты нужно проверить на сайте источника.' + demo_note, [[mini_app_button()], [{'type':'message','text':'/plan'}]])
            return
        if text == '/cancel':
            self.store.update_user(key, stage=None, draft=None)
            self.client.send(uid, 'Ввод отменён, сохранённый профиль остался. /plan — начать снова.')
            return
        if text == '/show':
            state = self.service.state(key)
            if not state['profile']:
                self.client.send(uid, 'Профиль пока не заполнен. /plan — начать.')
            else:
                body, buttons = show_mode(state, 'interest')
                self.client.send(uid, body, buttons)
            return
        if text == '/plan':
            self.store.metric(key, 'plan_started')
            self.store.update_user(key, stage='balance', draft='{}')
            self.client.send(uid, QUESTIONS['balance'])
            return
        stage = row['stage']
        if not stage:
            self.client.send(uid, 'Напишите /plan для составления плана или /show для просмотра.')
            return
        if stage == 'purchase':
            try:
                sid = json.loads(row['draft'])['sessionId']
                state = self.service.purchase(key, sid, text)
                self.store.update_user(key, stage=None, draft=None)
                body, buttons = show_mode(state, 'interest')
                self.client.send(uid, 'Покупка отмечена вручную; оставшийся план пересчитан.\n\n' + body, buttons)
            except (Invalid, ValueError) as exc:
                self.client.send(uid, f'{exc}. Попробуйте снова или /cancel.')
            return
        try:
            draft = parse_step(stage, text, json.loads(row['draft'] or '{}'))
            next_index = STEPS.index(stage) + 1
            if next_index == len(STEPS):
                state = self.service.save_profile(key, draft)
                body, buttons = show_mode(state, 'interest')
                self.client.send(uid, body, buttons)
            else:
                next_step = STEPS[next_index]
                self.store.update_user(key, stage=next_step, draft=json.dumps(draft, ensure_ascii=False))
                hint = ' Категории: ' + ', '.join(self.service.state(key)['categories']) if next_step == 'weights' else ''
                self.client.send(uid, QUESTIONS[next_step] + hint)
        except (Invalid, ValueError, IndexError, KeyError, TypeError) as exc:
            self.client.send(uid, f'Не удалось принять ответ: {exc}. {QUESTIONS[stage]}')


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
                    client.send(int(uid[4:]), f"Напоминание: {item['title']} скоро начнётся. {note}")
                except Exception:
                    with store.db() as db:
                        db.execute('DELETE FROM reminders WHERE user_id=? AND session_id=? AND kind=?', (uid,item['id'],kind))
