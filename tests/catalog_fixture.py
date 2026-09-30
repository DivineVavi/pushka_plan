"""Test-only generated rows from the synthetic demo fixture."""
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo


FIXTURE = Path(__file__).resolve().parent / 'fixtures' / 'demo-v1.json'


def demo_rows(now):
    fixture = json.loads(FIXTURE.read_text(encoding='utf-8'))
    tz = ZoneInfo(fixture['timezone'])
    base = now.astimezone(tz).date()
    rows = []
    for event in fixture['events']:
        start = datetime.combine(base + timedelta(days=event['days']), datetime.min.time(), tz).replace(hour=event['hour'])
        for ordinal, start_time in enumerate((start, start + timedelta(days=7)) if event['id'] in ('stage-1', 'exhibit-1') else (start,)):
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
