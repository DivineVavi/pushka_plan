"""Durable SQLite queue consumer for public-afisha snapshots."""
import json
import time

from .store import Store


def write_culture_queue(db_path, run_id, idle_timeout=900):
    """Drain persisted parser results and publish only a complete run."""
    store = Store(db_path)
    last_activity = time.monotonic()
    while True:
        processed = store.write_culture_queue_batch(run_id)
        run = store.culture_sync_run(run_id)
        if run is None:
            return
        if processed:
            last_activity = time.monotonic()
        if run['status'] == 'ready' and run['queued_event_pages'] == 0:
            if run['completed_event_pages'] != run['expected_event_pages']:
                store.fail_culture_sync(run_id, 'incomplete_queue')
                return
            rows = store.culture_staged_rows(run_id)
            if not rows:
                store.fail_culture_sync(run_id, 'empty_snapshot')
                return
            source = json.loads(run['source_payload'])
            source.setdefault('coverage', {})['timedSessions'] = len(rows)
            source['coverage']['parsedEventPages'] = run['completed_event_pages']
            store.replace_catalog(rows, source)
            store.complete_culture_sync(run_id)
            return
        if run['status'] == 'failed' and run['queued_event_pages'] == 0:
            return
        if time.monotonic() - last_activity >= idle_timeout:
            store.fail_culture_sync(run_id, 'writer_idle_timeout')
            return
        time.sleep(0.05)
