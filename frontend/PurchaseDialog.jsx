import { useEffect, useRef, useState } from 'react';
import { Button, Input, Typography } from '@maxhub/max-ui';
import { fmtDate } from './client.js';

export default function PurchaseDialog({ item, busy, onSave, onClose }) {
  const dialogRef = useRef(null);
  const priceRef = useRef(null);
  const errorRef = useRef(null);
  const [price, setPrice] = useState('');
  const [error, setError] = useState(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    setPrice(item?.price == null ? '' : String(item.price));
    setError(null);
    if (item) {
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', '');
      priceRef.current?.focus();
    } else {
      if (typeof dialog.close === 'function') dialog.close();
      else dialog.removeAttribute('open');
    }
  }, [item]);

  async function submit(event) {
    event.preventDefault();
    if (!item || busy) return;
    const raw = price.trim();
    const number = Number(raw);
    if (!/^\d+(?:\.0+)?$/.test(raw) || !Number.isInteger(number) || number < 0 || number > 100000) {
      showError('Введите фактическую цену билета: целое число от 0 до 100000.', true);
      return;
    }
    setError(null);
    try { await onSave(item.sessionId || item.id, number); }
    catch (failure) { if (failure.status !== 401) showError(failure.message); }
  }

  function showError(message, invalid = false) {
    setError({ message, invalid });
    requestAnimationFrame(() => {
      priceRef.current?.focus({ preventScroll: true });
      errorRef.current?.scrollIntoView({ block: 'center' });
    });
  }

  const venue = typeof item?.venue === 'object' ? item.venue?.name : item?.venue;
  return (
    <dialog id="purchase-dialog" ref={dialogRef} aria-labelledby="purchase-title"
      onCancel={(event) => { if (busy) event.preventDefault(); else onClose(); }}
      onClick={(event) => {
        if (event.target !== event.currentTarget || busy) return;
        const rect = event.currentTarget.getBoundingClientRect();
        if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onClose();
      }}>
      <form id="purchase-form" noValidate onSubmit={submit}>
        <Typography.Title asChild><h2 id="purchase-title" className="purchase__title">Отметить покупку</h2></Typography.Title>
        <p id="purchase-event" className="purchase__event">{item ? <><strong>«{item.title}»</strong>{venue ? ` · ${venue}` : ''}<br />{fmtDate(item.startsAt, { weekday: 'short', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }, item.timezone)}</> : null}</p>
        <div className="field">
          <label className="field__label" htmlFor="purchase-price">Фактическая цена, ₽</label>
          <Input id="purchase-price" ref={priceRef} type="number" min="0" max="100000" step="1" inputMode="numeric"
            required disabled={busy} value={price} onChange={(event) => { setPrice(event.target.value); setError(null); }}
            aria-describedby="purchase-hint purchase-error" aria-invalid={error?.invalid ? 'true' : undefined} />
        </div>
        <p id="purchase-hint" className="form-hint">{item ? item.exactPriceKnown
          ? 'Подтвердите плановую цену или укажите сумму, которую действительно заплатили.'
          : 'Указана минимальная цена. Введите фактическую сумму, которую вы заплатили за билет.' : ''}</p>
        <p id="purchase-error" ref={errorRef} className="form-error" role="alert" hidden={!error}>{error?.message}</p>
        <div className="form-actions">
          <Button id="purchase-cancel" type="button" variant="ghost" disabled={busy} onClick={onClose}>Отмена</Button>
          <Button id="purchase-confirm" type="submit" disabled={busy} loading={busy}>Сохранить</Button>
        </div>
      </form>
    </dialog>
  );
}
