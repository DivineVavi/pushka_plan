// Launch credentials stay in memory, never in localStorage or rendered markup.
export function bridge() {
  return typeof window.WebApp === 'object' && window.WebApp ? window.WebApp : null;
}

export function extractInitData() {
  const raw = window.location.hash.slice(1);
  const params = new URLSearchParams(raw);
  for (const key of ['tgWebAppData', 'WebAppData', 'webAppData', 'initData', 'init_data']) {
    const value = params.get(key);
    if (value) return value;
  }
  if (params.has('hash') && params.has('auth_date') && params.has('user')) return raw;
  return bridge()?.initData || null;
}

const initData = extractInitData();
export async function api(path, { method = 'GET', body } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (initData) headers['X-Max-Init-Data'] = initData;
  let response;
  try {
    response = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new Error('Нет соединения с сервером. Проверьте сеть и попробуйте ещё раз.');
  }
  let data = null;
  try { data = await response.json(); } catch { /* Handle an empty error response below. */ }
  if (!response.ok) {
    const message = data?.error || data?.detail || data?.message;
    const error = new Error(typeof message === 'string' ? message : `Ошибка сервера (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return data;
}

export const modeNames = { interest: 'По интересам', more: 'Больше впечатлений', spend: 'Почти без остатка' };
export const fmtPrice = (value) => typeof value === 'number' && Number.isFinite(value)
  ? `${new Intl.NumberFormat('ru-RU').format(Math.round(value))} ₽` : '—';
export function fmtDate(value, options = { day: 'numeric', month: 'long' }, timeZone = 'Europe/Moscow') {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  try { return new Intl.DateTimeFormat('ru-RU', { ...options, timeZone }).format(date); }
  catch { return new Intl.DateTimeFormat('ru-RU', options).format(date); }
}
export const fmtStamp = (value) => fmtDate(value, { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });

export function buildShareText(data, mode) {
  const plan = data?.plans?.[mode];
  if (!plan?.items?.length) return null;
  const publicSource = ['culture-public', 'culture-public-prepared'].includes(data.source?.kind);
  const lines = plan.items.map((item, index) => {
    const purchase = data.purchased?.find((p) => p.sessionId === (item.sessionId || item.id));
    const price = purchase ? fmtPrice(purchase.actualPrice ?? item.price)
      : `${item.exactPriceKnown ? '' : 'от '}${fmtPrice(item.price)}`;
    const venue = typeof item.venue === 'object' ? item.venue?.name : item.venue;
    const when = fmtDate(item.startsAt, { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }, item.timezone);
    return `${index + 1}. ${when} — «${item.title}»${venue ? ` (${venue})` : ''} — ${price}`;
  });
  return [
    `План «${modeNames[mode]}» · Пушка-план${data.demo ? ' · ДЕМО: вымышленные события, билеты недоступны' : ''}`,
    ...lines,
    `${publicSource ? 'Плановая сумма от: ' : data.purchased?.length ? 'Новые билеты: ' : 'Итого: '}${fmtPrice(plan.total)} · ${publicSource ? 'Расчётный остаток до: ' : 'Остаток: '}${fmtPrice(plan.leftover)}`,
    ...(publicSource ? ['Проверьте сеанс, итоговую цену и наличие билетов на странице события.'] : []),
  ].join('\n');
}

export async function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    try { await navigator.clipboard.writeText(text); return true; } catch { /* Legacy webview fallback. */ }
  }
  const previousFocus = document.activeElement;
  const textarea = document.createElement('textarea');
  textarea.className = 'clipboard-copy';
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  document.body.appendChild(textarea);
  textarea.select();
  try { return Boolean(document.execCommand('copy')); }
  catch { return false; }
  finally { textarea.remove(); previousFocus?.focus?.({ preventScroll: true }); }
}

export function openSource(item) {
  const url = item.source === 'culture-public' ? item.sourceUrl : item.saleLink;
  if (!url) return;
  // Opening remains synchronous so the browser doesn't classify it as a popup.
  try {
    if (typeof bridge()?.openLink === 'function') { bridge().openLink(url); return; }
  } catch { /* Desktop/web fallback. */ }
  window.open(url, '_blank', 'noopener,noreferrer');
}
