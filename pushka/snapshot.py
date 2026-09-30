"""Offline catalogue-only SQLite snapshots; never copy application/user state."""
import argparse
import json
import os
import sqlite3
import tempfile
from contextlib import closing
from pathlib import Path

from .planner import instant
from .store import Store

DEFAULT_SNAPSHOT = Path(__file__).resolve().parent.parent / 'data' / 'catalog-snapshot.sqlite3'
CATALOG_TABLES = ('events', 'venues', 'sessions', 'meta')
SNAPSHOT_KINDS = ('culture-public', 'culture-public-prepared')


def read_snapshot(path):
    """Read one consistent catalogue transaction without modifying the source DB."""
    uri = Path(path).resolve().as_uri() + '?mode=ro'
    with closing(sqlite3.connect(uri, uri=True)) as db:
        db.execute('BEGIN')
        if db.execute('PRAGMA quick_check').fetchone()[0] != 'ok':
            raise ValueError('Catalogue snapshot failed SQLite integrity check')
        source = {key: json.loads(value) for key, value in db.execute('SELECT key,value FROM meta')}
        rows = [{**json.loads(event), **json.loads(venue), **json.loads(session)}
                for event, venue, session in db.execute('''
                    SELECT e.payload,v.payload,s.payload FROM sessions s
                    JOIN events e ON e.id=s.event_id JOIN venues v ON v.id=s.venue_id
                    ORDER BY s.id''')]
        count = db.execute('SELECT COUNT(*) FROM sessions').fetchone()[0]
    if not rows or len(rows) != count:
        raise ValueError('Catalogue snapshot is empty or has missing event/venue references')
    if not isinstance(source, dict) or source.get('kind') not in SNAPSHOT_KINDS:
        raise ValueError('Unsupported catalogue snapshot source')
    if any(row.get('source') != 'culture-public' for row in rows):
        raise ValueError('Catalogue snapshot contains non-culture-public rows')
    instant(source['fetchedAt'])  # Missing/invalid collection timestamp is not hidden.
    return rows, source


def load_catalog_snapshot(store, path=DEFAULT_SNAPSHOT):
    """Seed only a new catalogue; restarting cannot reset purchases or chosen plans."""
    if store.meta():
        return 0
    try:
        rows, source = read_snapshot(path)
    except (OSError, sqlite3.Error, ValueError, KeyError, TypeError) as exc:
        raise ValueError('Cannot load catalogue snapshot: check CATALOG_SNAPSHOT_PATH and file integrity') from exc
    store.replace_catalog(rows, {
        'kind': 'culture-public-prepared',
        'label': 'Подготовленный снимок московской афиши Культура.РФ (не живая интеграция)',
        'sourceUrl': source.get('sourceUrl'),
        'fetchedAt': source['fetchedAt'],
        'lastError': None,
        'snapshotFile': Path(path).name,
    })
    return len(rows)


def export_catalog(source_path, destination):
    """Construct a NEW database from public catalogue rows only, not a DB backup."""
    destination = Path(destination)
    if Path(source_path).resolve() == destination.resolve():
        raise ValueError('Snapshot destination must differ from the working database')
    rows, source = read_snapshot(source_path)
    destination.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix='.catalog-', suffix='.sqlite3', dir=destination.parent)
    os.close(fd)
    try:
        snapshot = Store(temporary)
        snapshot.replace_catalog(rows, {key: source[key] for key in ('kind', 'sourceUrl', 'fetchedAt') if key in source})
        with snapshot.db() as db:
            tables = [r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")]
            for table in tables:
                if table not in CATALOG_TABLES:
                    db.execute('DROP TABLE "' + table + '"')
            db.commit()
            db.execute('VACUUM')
        os.chmod(temporary, 0o644)
        os.replace(temporary, destination)
    finally:
        Path(temporary).unlink(missing_ok=True)
    return len(rows)


def main():
    parser = argparse.ArgumentParser(description='Export a catalogue without users, purchases or service state')
    parser.add_argument('--export', required=True, metavar='WORKING_DB')
    parser.add_argument('--output', required=True, metavar='SNAPSHOT_DB')
    args = parser.parse_args()
    count = export_catalog(args.export, args.output)
    print(f'Catalogue-only snapshot exported: {count} sessions')


if __name__ == '__main__':
    main()
