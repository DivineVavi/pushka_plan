"""Pure, deterministic session planner. Money is integer rubles; timestamps are UTC."""
from __future__ import annotations

from datetime import datetime, date, time, timedelta, timezone
from math import asin, cos, radians, sin, sqrt
import re
from urllib.parse import urlsplit
from zoneinfo import ZoneInfo

MODES = ('interest', 'more', 'spend')
MIN_RELEVANCE = 35
LABELS = {
    'locale': 'город', 'date': 'дата / срок', 'availability': 'свободное время',
    'age': 'возраст', 'excluded': 'исключённая категория', 'price': 'бюджет',
    'unknown_price': 'неизвестная цена', 'link': 'нет страницы источника или ссылки для проверки',
    'distance': 'расстояние', 'approval': 'нет подтверждения участия',
}


def instant(value):
    if isinstance(value, (int, float)):
        return datetime.fromtimestamp(value / (1000 if value > 10**11 else 1), timezone.utc)
    return datetime.fromisoformat(value.replace('Z', '+00:00')).astimezone(timezone.utc)


def public_event_page(url):
    """Only a genuine HTTPS event page may stand in for a seller link."""
    if not isinstance(url, str):
        return False
    try:
        parts = urlsplit(url)
        return (parts.scheme == 'https' and parts.netloc == 'www.culture.ru' and
                bool(re.fullmatch(r'/events/[0-9]+/[a-z0-9-]+/?', parts.path)) and
                not parts.fragment)
    except ValueError:
        return False


def distance_km(a, b, c, d):
    r1, r2 = radians(float(a)), radians(float(c))
    delta = radians(float(d) - float(b))
    h = sin((r2 - r1) / 2)**2 + cos(r1) * cos(r2) * sin(delta / 2)**2
    return 6371 * 2 * asin(sqrt(h))


def availability_fit(start, end, rules, tz):
    local_start, local_end = start.astimezone(tz), end.astimezone(tz)
    for rule in rules:
        day = local_start.date()
        if ('date' in rule and rule['date'] != day.isoformat()) or ('weekday' in rule and rule['weekday'] != day.weekday()):
            continue
        first = datetime.combine(day, time.fromisoformat(rule['start']), tz)
        last = datetime.combine(day, time.fromisoformat(rule['end']), tz)
        if first <= local_start and local_end <= last:
            return min(20, 12 + min(8, int(min((local_start-first).total_seconds(), (last-local_end).total_seconds()) // 3600)))
    return None


def conflict(a, b, buffer_minutes):
    if a['eventId'] == b['eventId']:
        return True
    early, late = sorted((a, b), key=lambda x: x['startsAt'])
    gap = instant(late['startsAt']) - instant(early['endsAt'])
    if gap.total_seconds() < 0:
        return True
    # Same calendar day in venue time; do not penalize travel on different days.
    tz = ZoneInfo(early.get('timezone') or 'Europe/Moscow')
    same_day = instant(early['startsAt']).astimezone(tz).date() == instant(late['startsAt']).astimezone(tz).date()
    return same_day and gap < timedelta(minutes=buffer_minutes)


def candidates(profile, records, now, balance, purchased=()):
    counts = {key: 0 for key in LABELS}
    selected = []
    deadline = date.fromisoformat(profile['planningDeadline'])
    blocked_ids = {p['sessionId'] for p in purchased}
    locked = [p['item'] for p in purchased if p.get('item')]
    locked_events = {item['eventId'] for item in locked}
    for row in records:
        if row['id'] in blocked_ids or row['eventId'] in locked_events:
            continue
        reason = None
        if not row['approved'] or not row['published']:
            reason = 'approval'
        elif row['localeId'].casefold() != profile['localeId'].casefold():
            reason = 'locale'
        else:
            try:
                start, end = instant(row['startsAt']), instant(row['endsAt'])
                tz = ZoneInfo(row.get('timezone') or 'Europe/Moscow')
                if start <= now or end <= start or start.astimezone(tz).date() > deadline:
                    reason = 'date'
                else:
                    time_score = availability_fit(start, end, profile['availability'], tz)
                    if time_score is None:
                        reason = 'availability'
                    elif profile['age'] < row['ageRestriction']:
                        reason = 'age'
                    elif row['category'] in profile['excludedCategories']:
                        reason = 'excluded'
                    elif row['minPrice'] is None:
                        reason = 'unknown_price'
                    elif row['minPrice'] > balance:
                        reason = 'price'
                    elif row['source'] == 'culture-public' and not public_event_page(row.get('sourceUrl')):
                        reason = 'link'
                    elif row['source'] not in ('culture-public', 'fixture') and not row.get('saleLink'):
                        reason = 'link'
                    else:
                        km = None
                        if profile.get('maxDistanceKm') is not None:
                            if any(v is None for v in (profile.get('latitude'), profile.get('longitude'), row.get('latitude'), row.get('longitude'))):
                                reason = 'distance'
                            else:
                                km = distance_km(profile['latitude'], profile['longitude'], row['latitude'], row['longitude'])
                                if km > profile['maxDistanceKm']:
                                    reason = 'distance'
                        if reason is None:
                            weight = profile['categoryWeights'].get(row['category'], 1)
                            interest = weight * 10
                            affordability = min(10, max(0, 10 - round(10 * row['minPrice'] / max(1, balance))))
                            distance_score = round(10 * (1 - km / profile['maxDistanceKm'])) if km is not None and profile.get('maxDistanceKm') else 0
                            reasons = [f"Интерес «{row['category']}»: {weight}/5", 'Сеанс полностью попадает в свободное окно', 'Плановая цена укладывается в остаток']
                            if km is not None:
                                reasons.append(f'Расстояние ≈ {km:.1f} км')
                            item = {key: row[key] for key in ('id','eventId','title','category','startsAt','endsAt','timezone','saleLink','exactPriceKnown')}
                            item.update(source=row['source'], sourceUrl=row.get('sourceUrl'), endEstimated=bool(row.get('endEstimated')), venue={'name': row['venueName'], 'address': row['address']}, price=row['minPrice'], fetchedAt=row.get('fetchedAt'),
                                        interestWeight=weight, score=interest + time_score + affordability + distance_score, reasons=reasons)
                            selected.append(item)
            except (ValueError, KeyError):
                reason = 'date'
        if reason:
            counts[reason] += 1
    # Novelty measures underrepresented categories/venues among eligible events,
    # not among sessions (repeat dates must not inflate popularity).
    categories = {}
    venues = {}
    for item in selected:
        categories.setdefault(item['category'], set()).add(item['eventId'])
        venues.setdefault(item['venue']['name'], set()).add(item['eventId'])
    for item in selected:
        if len(categories[item['category']]) <= 2:
            item['score'] += 5
            item['reasons'].append('Редкая категория среди подходящих событий')
        if len(venues[item['venue']['name']]) <= 2:
            item['score'] += 5
            item['reasons'].append('Новая площадка среди подходящих событий')
    # Reserve one item for each category and day before filling by relevance.
    ranked = sorted(selected, key=lambda x: (-x['score'], x['startsAt'], x['id']))
    chosen, seen = [], set()
    for axis in ('category', 'day'):
        for item in ranked:
            value = item['category'] if axis == 'category' else item['startsAt'][:10]
            if value not in seen and item not in chosen and len(chosen) < 30:
                chosen.append(item)
            seen.add(value)
        seen.clear()
    chosen += [item for item in ranked if item not in chosen][:max(0, 30-len(chosen))]
    return chosen, {LABELS[k]: v for k, v in counts.items() if v}, len(records)


def optimize(items, balance, max_events, buffer_minutes, mode, locked=()):
    if mode not in MODES:
        raise ValueError('unknown mode')
    locked_items = [p['item'] for p in locked if p.get('item')]
    # Every mode rejects low-interest filler, including the relevance-first mode.
    eligible = [item for item in items if item['score'] >= MIN_RELEVANCE and item['interestWeight'] >= 2]
    best, best_key = [], None

    def rank(current, cost):
        if not current:
            return None
        score = sum(i['score'] for i in current)
        categories = len({i['category'] for i in current})
        venues = len({i['venue']['name'] for i in current})
        leftover = balance - cost
        first = min(i['startsAt'] for i in current)
        ids = tuple(sorted(i['id'] for i in current))
        if mode == 'interest':
            return (score, -leftover, categories, venues, -instant(first).timestamp(), tuple(-ord(c) for c in '|'.join(ids)))
        if mode == 'more':
            return (len(current), score, -leftover, categories, venues, -instant(first).timestamp(), tuple(-ord(c) for c in '|'.join(ids)))
        return (-leftover, score, categories, venues, -instant(first).timestamp(), tuple(-ord(c) for c in '|'.join(ids)))

    def visit(index, current, cost):
        nonlocal best, best_key
        key = rank(current, cost)
        if key is not None and (best_key is None or key > best_key):
            best_key, best = key, current[:]
        if len(current) >= max_events or index == len(eligible):
            return
        for pos in range(index, len(eligible)):
            item = eligible[pos]
            if cost + item['price'] > balance or any(conflict(item, other, buffer_minutes) for other in current + locked_items):
                continue
            current.append(item)
            visit(pos+1, current, cost+item['price'])
            current.pop()

    visit(0, [], 0)
    ordered = sorted(locked_items + best, key=lambda x: (x['startsAt'], x['id']))
    # Actual price is already deducted from remaining balance; display it, but never double-charge.
    spent = sum(i['price'] for i in best)
    return {'items': ordered, 'total': spent, 'leftover': balance-spent, 'score': sum(i['score'] for i in best)}


def plan(profile, records, purchased=(), now=None):
    now = now or datetime.now(timezone.utc)
    paid = sum(p['actualPrice'] for p in purchased)
    balance = max(0, profile['maxBalance']-paid)
    pool, blocked, total = candidates(profile, records, now, balance, purchased)
    modes = {mode: optimize(pool, balance, max(0, profile['maxEvents']-len(purchased)), profile['travelBufferMinutes'], mode, purchased) for mode in MODES}
    message = ('Измените город, даты, интересы, возраст, расстояние или бюджет вручную — ограничения не ослабляются автоматически.' if not pool
               else 'Подходящие сеансы есть, но они не достигли минимального порога интереса. Измените интересы вручную.' if not any(i['score'] >= MIN_RELEVANCE and i['interestWeight'] >= 2 for i in pool) and not purchased else '')
    return {'plans': modes, 'remainingBalance': balance, 'diagnostics': {'sourceSessions': total, 'eligibleSessions': len(pool), 'excludedBy': blocked, 'message': message}}
