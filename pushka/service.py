"""Application-level validation, identity, and purchase workflow."""
import hashlib
import hmac
import json
import re
from datetime import date, datetime, timedelta, timezone
from urllib.parse import parse_qsl
from .planner import MODES, instant, plan
from .store import purchase_matches_source


class Invalid(ValueError):
    pass


def integer(value, lo, hi, label):
    if isinstance(value, bool) or isinstance(value, float) or not str(value).isdigit() or not lo <= int(value) <= hi:
        raise Invalid(f'{label}: допустимо целое число от {lo} до {hi}')
    return int(value)


def validate_profile(data, now=None):
    now = now or datetime.now(timezone.utc)
    if not isinstance(data, dict):
        raise Invalid('Нужен объект профиля')
    balance = integer(data.get('maxBalance'), 0, 100000, 'Остаток')
    locale = data.get('localeId')
    if not isinstance(locale, str) or not 1 <= len(locale.strip()) <= 100:
        raise Invalid('Укажите город или ID локали')
    try:
        deadline = date.fromisoformat(data['planningDeadline'])
    except (KeyError, ValueError, TypeError):
        raise Invalid('Укажите срок в формате ГГГГ-ММ-ДД') from None
    if deadline < now.date() or deadline > now.date()+timedelta(days=90):
        raise Invalid('Срок должен быть в пределах следующих 90 дней')
    rules = data.get('availability')
    if not isinstance(rules, list) or not 1 <= len(rules) <= 40:
        raise Invalid('Укажите от 1 до 40 свободных окон')
    available = []
    for rule in rules:
        if not isinstance(rule, dict) or ('date' in rule) == ('weekday' in rule):
            raise Invalid('Для окна укажите дату или день недели')
        key = {}
        if 'date' in rule:
            try:
                day = date.fromisoformat(rule['date'])
            except (TypeError, ValueError):
                raise Invalid('Неверная дата свободного дня') from None
            if day > deadline or day < now.date():
                raise Invalid('Свободная дата вне планируемого срока')
            key['date'] = day.isoformat()
        else:
            key['weekday'] = integer(rule['weekday'], 0, 6, 'День недели')
        try:
            start, end = rule['start'], rule['end']
            if not all(isinstance(x, str) and re.fullmatch(r'([01]\d|2[0-3]):[0-5]\d', x) for x in (start, end)) or start >= end:
                raise ValueError()
        except (KeyError, ValueError, TypeError):
            raise Invalid('Укажите начало и конец окна в формате ЧЧ:ММ') from None
        available.append({**key, 'start': start, 'end': end})
    weights = data.get('categoryWeights', {})
    if not isinstance(weights, dict) or len(weights) > 30:
        raise Invalid('Неверные интересы')
    weights = {str(k): integer(v, 1, 5, 'Интерес') for k, v in weights.items() if isinstance(k, str) and 0 < len(k) <= 100}
    excluded = data.get('excludedCategories', [])
    if not isinstance(excluded, list) or len(excluded) > 30 or not all(isinstance(x, str) and len(x) <= 100 for x in excluded):
        raise Invalid('Неверные исключённые категории')
    clean = {'maxBalance': balance, 'localeId': locale.strip(), 'planningDeadline': deadline.isoformat(), 'availability': available,
             'categoryWeights': weights, 'excludedCategories': list(dict.fromkeys(excluded)), 'age': integer(data.get('age'), 0, 120, 'Возраст'),
             'maxEvents': integer(data.get('maxEvents'), 1, 4, 'Количество событий'), 'travelBufferMinutes': integer(data.get('travelBufferMinutes', 30), 0, 240, 'Буфер')}
    if data.get('maxDistanceKm') not in (None, ''):
        try:
            dist = float(data['maxDistanceKm'])
            lat, lon = float(data['latitude']), float(data['longitude'])
            if not 0 < dist <= 500 or not -90 <= lat <= 90 or not -180 <= lon <= 180:
                raise ValueError()
        except (ValueError, TypeError, KeyError):
            raise Invalid('Для расстояния нужны лимит (1–500 км) и координаты') from None
        clean.update(maxDistanceKm=dist, latitude=lat, longitude=lon)
    return clean


def validate_max_init(raw, token, now=None):
    if not token or not raw or len(raw) > 8192:
        raise Invalid('Нет данных запуска MAX')
    try:
        fields = parse_qsl(raw, keep_blank_values=True, strict_parsing=True)
        if len(fields) != len({k for k, _ in fields}) or sum(k == 'hash' for k, _ in fields) != 1:
            raise Invalid('Повтор или отсутствие параметров MAX')
        params = dict(fields)
        hash_value = params.pop('hash')
        check = '\n'.join(f'{k}={v}' for k, v in sorted(params.items()))
        key = hmac.new(b'WebAppData', token.encode(), hashlib.sha256).digest()
        expected = hmac.new(key, check.encode(), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(expected, hash_value):
            raise Invalid('Подпись MAX не совпала')
        auth = integer(params['auth_date'], 0, 99999999999, 'Время авторизации')
        now = now or datetime.now(timezone.utc)
        if not -60 <= now.timestamp()-auth <= 3600:
            raise Invalid('Данные запуска MAX устарели')
        user = json.loads(params['user'])
        uid = user['id']
        if isinstance(uid, bool) or not isinstance(uid, int) or uid <= 0:
            raise ValueError()
        return 'max:' + str(uid)
    except (KeyError, ValueError, TypeError, json.JSONDecodeError) as exc:
        if isinstance(exc, Invalid):
            raise
        raise Invalid('Некорректные данные запуска MAX') from None


class Service:
    def __init__(self, store):
        self.store = store

    def state(self, uid):
        row = self.store.user(uid)
        profile = json.loads(row['profile']) if row['profile'] else None
        meta = self.store.meta()
        bought = [p for p in self.store.purchases(uid) if purchase_matches_source(p, meta.get('kind'))]
        now = datetime.now(timezone.utc)
        # Only hydrate the relevant locale and future range; purchases are
        # separately preserved even if the source no longer lists the session.
        before = (date.fromisoformat(profile['planningDeadline']) + timedelta(days=2)).isoformat() if profile else None
        categories, locales = self.store.facets()
        locale = next((name for name in locales if profile and name.casefold() == profile['localeId'].casefold()),
                      profile['localeId'] if profile else None)
        records = self.store.catalog(locale=locale, after=now.isoformat(), before=before) if profile else []
        output = plan(profile, records, bought, now) if profile else {'plans': None, 'remainingBalance': None, 'diagnostics': {}}
        stamp = meta.get('fetchedAt')
        source = {'kind': meta.get('kind', 'unavailable'), 'label': meta.get('label', 'Нет каталога'), 'fetchedAt': stamp,
                  'stale': bool(meta.get('lastError') or (stamp and (now-instant(stamp)).total_seconds() > 12*3600)),
                  'error': meta.get('lastError')}
        selected = json.loads(row['selected_plan']) if row.get('selected_plan') else None
        if selected:
            mode = selected.get('mode')
            current = [self._selection_item(i) for i in output['plans'].get(mode, {}).get('items', []) if not i.get('purchased')]
            chosen = [i for i in selected['items'] if i['id'] not in {p['sessionId'] for p in bought}]
            selected = {'mode': mode, 'sessionIds': [i['id'] for i in selected['items']],
                        'needsConfirmation': selected.get('sourceKind') != source['kind'] or chosen != current}
        return {'demo': source['kind'] == 'simulated', 'profile': profile, 'purchased': bought, 'source': source,
                'categories': categories, 'locales': locales, 'selectedPlan': selected,
                'remindersEnabled': bool(row['reminders']), **output}

    @staticmethod
    def _selection_item(item):
        return {key: item[key] for key in ('id', 'startsAt', 'endsAt', 'price', 'sourceUrl')}

    def select_plan(self, uid, mode):
        if mode not in MODES:
            raise Invalid('Неизвестный вариант плана')
        state = self.state(uid)
        if not state['profile']:
            raise Invalid('Сначала заполните профиль')
        items = [self._selection_item(i) for i in state['plans'][mode]['items'] if not i.get('purchased')]
        if not items:
            raise Invalid('В этом варианте нет сеансов для напоминаний')
        self.store.update_user(uid, selected_plan=json.dumps({'mode': mode, 'items': items,
            'sourceKind': state['source']['kind']}, ensure_ascii=False))
        return self.state(uid)

    def save_profile(self, uid, data):
        profile = validate_profile(data)
        bought = [p for p in self.store.purchases(uid) if purchase_matches_source(p, self.store.meta().get('kind'))]
        if sum(p['actualPrice'] for p in bought) > profile['maxBalance']:
            raise Invalid('Новый баланс меньше уже записанных покупок')
        if len(bought) > profile['maxEvents']:
            raise Invalid('Лимит событий меньше уже записанных покупок')
        self.store.update_user(uid, profile=json.dumps(profile, ensure_ascii=False), stage=None, draft=None, selected_plan=None)
        state = self.state(uid)
        self.store.metric(uid, 'plan_completed', state['plans']['interest']['leftover'])
        return state

    def purchase(self, uid, session_id, price):
        state = self.state(uid)
        profile = state['profile']
        if not profile:
            raise Invalid('Сначала заполните профиль')
        actual = integer(price, 0, 100000, 'Фактическая цена')
        previous = next((p for p in state['purchased'] if p['sessionId'] == session_id), None)
        if previous:
            if previous['actualPrice'] != actual:
                raise Invalid('Покупка уже записана с другой ценой')
            return state
        # Only allow locking a currently feasible suggestion, not arbitrary catalog ids.
        item = next((item for mode in state['plans'].values() for item in mode['items'] if item['id'] == session_id and not item.get('purchased')), None)
        if not item:
            raise Invalid('Сеанс не входит в доступные планы; обновите подбор')
        item = {**item, 'plannedPrice': item['price'], 'price': actual, 'purchased': True, 'reasons': ['Покупка подтверждена вручную', *item['reasons']]}
        try:
            created = self.store.purchase(uid, session_id, actual, item, profile['maxBalance'], profile['maxEvents'], profile['travelBufferMinutes'])
            if created:
                self.store.metric(uid, 'purchase_confirmed', actual - item['plannedPrice'])
                self.store.metric(uid, 'replanned')
        except ValueError as exc:
            raise Invalid(str(exc)) from exc
        return self.state(uid)
