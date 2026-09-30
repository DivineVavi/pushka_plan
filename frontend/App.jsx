import { useEffect, useRef, useState } from 'react';
import { Button, Panel, Spinner, Typography } from '@maxhub/max-ui';
import ProfileForm from './ProfileForm.jsx';
import Plans from './Plans.jsx';
import PurchaseDialog from './PurchaseDialog.jsx';
import { api, bridge, buildShareText, copyText, fmtDate, fmtPrice, fmtStamp, openSource } from './client.js';

const BOT_URL = 'https://max.ru/t99_hakaton_max_bot';

function ProfileSummary({ data }) {
  const profile = data?.profile;
  const stats = profile ? [
    ['Введённый остаток', fmtPrice(profile.maxBalance)],
    ...(data.remainingBalance !== profile.maxBalance ? [['Учтённый остаток', fmtPrice(data.remainingBalance)]] : []),
    ['Город', profile.localeId],
    ['Успеть до', fmtDate(`${profile.planningDeadline.slice(0, 10)}T12:00:00`)],
    ['Свободных окон', profile.availability?.length || '—'],
    ['Максимум событий', profile.maxEvents],
    ['Возраст', `${profile.age} лет`],
  ] : [];
  return <div id="profile-summary" className="profile-summary" hidden={!profile}>
    {stats.map(([label, value]) => <div className="pstat" key={label}><span className="pstat__label">{label}</span><span className="pstat__value">{value}</span></div>)}
  </div>;
}

export default function App() {
  const [data, setData] = useState(null);
  const [authRequired, setAuthRequired] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [editing, setEditing] = useState(false);
  const [formKey, setFormKey] = useState(0);
  const [mode, setMode] = useState('interest');
  const [purchase, setPurchase] = useState(null);
  const [failure, setFailure] = useState(null);
  const [notice, setNotice] = useState('');
  const profileRef = useRef(null);
  const errorRef = useRef(null);
  const authRef = useRef(null);
  const [entered, setEntered] = useState(false);

  useEffect(() => {
    try { bridge()?.ready?.(); } catch { /* Optional bridge feature. */ }
    loadState();
  }, []);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(''), 3500);
    return () => clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    if (failure) { errorRef.current?.focus({ preventScroll: true }); errorRef.current?.scrollIntoView({ block: 'center' }); }
  }, [failure]);
  useEffect(() => {
    if (authRequired) { authRef.current?.focus({ preventScroll: true }); authRef.current?.scrollIntoView({ block: 'start' }); }
  }, [authRequired]);

  async function request(path, options) {
    try { return await api(path, options); }
    catch (error) {
      if (error.status === 401) {
        setData(null);
        setAuthRequired(true);
        setEditing(false);
        setPurchase(null);
        setFailure(null);
        setNotice('');
        setFormKey((key) => key + 1);
      }
      throw error;
    }
  }

  async function run(operation, { message, inline = false, retry = operation } = {}) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setFailure(null);
    try {
      const result = await operation();
      if (message) setNotice(message);
      return result;
    } catch (error) {
      if (!inline && error.status !== 401) setFailure({ message: error.message, retry });
      if (inline) throw error;
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  async function loadState() {
    await run(async () => {
      const state = await request('/api/state');
      setData(state);
      setEditing(!state.profile);
      setAuthRequired(false);
      setFormKey((key) => key + 1);
    }, { retry: loadState });
    setEntered(true);
  }

  async function saveProfile(profile) {
    await run(async () => {
      const state = await request('/api/profile', { method: 'PUT', body: profile }) || await request('/api/state');
      setData(state);
      setEditing(false);
      setFormKey((key) => key + 1);
    }, { inline: true, message: 'Профиль сохранён — планы рассчитаны' });
  }

  function editProfile() {
    if (busyRef.current) return;
    setFormKey((key) => key + 1);
    setEditing(true);
    requestAnimationFrame(() => profileRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  }

  async function update(path, body, message) {
    const operation = () => update(path, body, message);
    await run(async () => {
      const state = await request(path, { method: 'POST', body }) || await request('/api/state');
      setData(state);
    }, { message, retry: operation });
  }

  async function recordPurchase(sessionId, actualPrice) {
    await run(async () => {
      const state = await request('/api/purchase', { method: 'POST', body: { sessionId, actualPrice } }) || await request('/api/state');
      setData(state);
      setPurchase(null);
    }, { inline: true, message: 'Покупка учтена — план пересчитан под новый остаток' });
  }

  async function share() {
    const text = buildShareText(data, mode);
    if (!text) { setNotice('План для отправки недоступен'); return; }
    try {
      if (typeof bridge()?.shareMaxContent === 'function') {
        await bridge().shareMaxContent({ text });
        return;
      }
    } catch { /* Web-client bridge fallback to clipboard. */ }
    setNotice(await copyText(text) ? 'Текст плана скопирован в буфер обмена' : 'Не удалось скопировать текст плана');
  }

  function openLink(item) {
    openSource(item);
    request('/api/track', { method: 'POST', body: { sessionId: item.id } }).catch(() => {});
  }

  const stale = Boolean(data?.source?.stale);
  const hasPlans = Boolean(data?.plans && ['interest', 'more', 'spend'].some((key) => data.plans[key]));
  return (
    <Panel mode="secondary" className="app-panel">
      <header className="app-header">
        <div className="app-header__inner">
          <div className="brand"><span className="brand__mark" aria-hidden="true">П</span><div className="brand__text"><Typography.Title variant="small-strong">Пушка-план</Typography.Title><span>Культура в вашем расписании</span></div></div>
          <span id="demo-badge" className="badge badge--demo" hidden={!data?.demo}>демо</span>
        </div>
      </header>
      <main className="container" aria-busy={busy}>
        <div className="page-intro" hidden={authRequired}>
          <Typography.Title asChild variant="large-strong"><h1>Куда пойдём?</h1></Typography.Title>
          <p>Ваши интересы, свободные дни и Пушкинская карта — в одном предварительном плане.</p>
        </div>
        <div className="initial-loading" role="status" hidden={entered || authRequired || failure}>
          <Spinner /><span>Загружаем ваши планы…</span>
        </div>
        <section id="banners" className="banners" hidden={!data?.demo && !stale && !failure} aria-live="polite">
          <div id="banner-demo" className="banner banner--demo" hidden={!data?.demo}>
            <span aria-hidden="true">🧪</span><div><strong>Демо-режим.</strong> События смоделированы и не получены из официального источника. Билеты на них не продаются. Отметка покупки лишь демонстрирует пересчёт.</div>
          </div>
          <div id="banner-stale" className="banner banner--warn" hidden={!stale}>
            <span aria-hidden="true">◷</span><div id="banner-stale-text">Данные событий устарели{data?.source?.fetchedAt ? ` (последнее обновление: ${fmtStamp(data.source.fetchedAt)})` : ''}. Сверьте расписание и цены на странице события.</div>
          </div>
          <div id="banner-error" ref={errorRef} className="banner banner--error" hidden={!failure} role="alert" tabIndex={-1}>
            <div className="banner-error__body"><div id="banner-error-text">{failure?.message}</div><Button id="btn-retry" type="button" variant="ghost" size="small" hidden={!failure?.retry} disabled={busy} onClick={() => failure?.retry?.()}>Повторить</Button></div>
          </div>
        </section>
        <section id="auth-required" ref={authRef} className="card auth-card" hidden={!authRequired} aria-labelledby="auth-title" tabIndex={-1}>
          <Typography.Title asChild><h2 id="auth-title">Откройте планы в MAX</h2></Typography.Title>
          <p>Это мини-приложение бота «Пушка-план», а не самостоятельный сайт. Откройте бота в MAX и нажмите «Открыть планы».</p>
          <p>Если вы уже в MAX, закройте мини-приложение и откройте его заново из бота: данные запуска могли устареть.</p>
          <Button asChild stretched><a id="auth-bot-link" href={BOT_URL} target="_blank" rel="noopener noreferrer">Открыть бота в MAX</a></Button>
        </section>
        <section id="profile-card" ref={profileRef} className="card profile-card" hidden={!data || authRequired} aria-labelledby="profile-title">
          <div className="card__head"><Typography.Title asChild><h2 id="profile-title">{data?.profile ? 'Ваш профиль' : 'Настроим ваш план'}</h2></Typography.Title><Button id="btn-edit-profile" type="button" variant="ghost" size="small" hidden={!data?.profile || editing} disabled={busy} onClick={editProfile}>Изменить</Button></div>
          <ProfileSummary data={data} />
          <div hidden={!editing}>
            <ProfileForm key={formKey} data={data} busy={busy} onSave={saveProfile} onCancel={() => setEditing(false)} />
          </div>
        </section>
        <section id="empty-card" className="card plan-empty" hidden={!data?.profile || hasPlans}>
          <Typography.Title asChild><h2 id="empty-title">Планы ещё не рассчитаны</h2></Typography.Title>
          <p id="empty-text">Профиль сохранён, но вариантов пока нет. Пересчитайте их или уточните профиль.</p>
          <Button id="btn-empty-action" type="button" disabled={busy} onClick={() => run(async () => {
            setData(await request('/api/profile', { method: 'PUT', body: data.profile }));
          }, { message: 'Планы пересчитаны', retry: () => document.getElementById('btn-empty-action')?.click() })}>Пересчитать планы</Button>
        </section>
        <Plans data={data} mode={mode} onModeChange={setMode} busy={busy} onEdit={editProfile}
          onBuy={setPurchase} onOpenLink={openLink} onSelectPlan={(selectedMode) => update('/api/selected-plan', { mode: selectedMode }, 'План выбран для напоминаний')}
          onReminders={(enabled) => update('/api/reminders', { enabled }, enabled ? 'Напоминания включены' : 'Напоминания выключены')} onShare={share} />
        <footer className="app-footer">
          <div id="source-line" className="source-line" hidden={!data?.source}>{data?.source ? <><span className={`source-dot${stale ? ' source-dot--stale' : ''}`} aria-hidden="true" /><span>Данные: {data.source.label || 'Источник не указан'}{data.source.fetchedAt ? ` · обновлено ${fmtStamp(data.source.fetchedAt)}` : ''}{stale ? ' · устарели' : ''}</span></> : null}</div>
        </footer>
      </main>
      <PurchaseDialog item={purchase} busy={busy} onSave={recordPurchase} onClose={() => setPurchase(null)} />
      <div id="toast" role="status" aria-live="polite" className={`toast${notice ? ' is-visible' : ''}`}>{notice}</div>
    </Panel>
  );
}
