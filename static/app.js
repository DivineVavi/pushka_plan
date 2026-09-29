/* «Пушка-план» — mini-app frontend. No dependencies.
 *
 * Auth: MAX launch data is taken from the location.hash fragment or
 * window.WebApp.initData and sent as the X-Max-Init-Data header on every
 * request. Without init data the backend serves a demo state bound to a
 * scoped cookie.
 */
(function () {
  'use strict';

  /* ================= helpers ================= */

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  const WebApp = typeof window.WebApp === 'object' && window.WebApp ? window.WebApp : null;

  const esc = (s) =>
    String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const priceFmt = new Intl.NumberFormat('ru-RU');
  const fmtPrice = (n) =>
    typeof n === 'number' && Number.isFinite(n) ? priceFmt.format(Math.round(n)) + ' ₽' : '—';

  const DATE_FMT = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long' });
  const DT_FMT = new Intl.DateTimeFormat('ru-RU', { weekday: 'short', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
  const SHARE_FMT = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
  const TIME_FMT = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' });
  const DAY_FMT = new Intl.DateTimeFormat('ru-RU', { day: 'numeric' });
  const MON_FMT = new Intl.DateTimeFormat('ru-RU', { month: 'short' });

  const fmtDate = (iso) => { const d = new Date(iso); return isNaN(d) ? String(iso || '') : DATE_FMT.format(d); };
  const fmtDT = (iso) => { const d = new Date(iso); return isNaN(d) ? String(iso || '') : DT_FMT.format(d); };
  function localized(iso, options, zone) {
    const d = new Date(iso);
    if (isNaN(d)) return '';
    try { return new Intl.DateTimeFormat('ru-RU', { ...options, timeZone: zone || 'Europe/Moscow' }).format(d); }
    catch (_) { return new Intl.DateTimeFormat('ru-RU', options).format(d); }
  }
  const fmtTime = (iso, zone) => localized(iso, { hour: '2-digit', minute: '2-digit' }, zone);

  function dateParts(iso, zone) {
    return { day: localized(iso, { day: 'numeric' }, zone) || '?', mon: localized(iso, { month: 'short' }, zone).replace('.', '') };
  }

  function clampInt(raw, def, min, max) {
    const n = Number(raw);
    if (!Number.isFinite(n)) return def;
    return Math.min(max, Math.max(min, Math.round(n)));
  }

  function defaultDeadline() {
    const d = new Date();
    d.setDate(d.getDate() + 30);
    return d.toISOString().slice(0, 10);
  }

  /* ================= auth ================= */

  function extractInitData() {
    const hash = window.location.hash || '';
    if (hash.length > 1) {
      const raw = hash.slice(1);
      let data = null;
      if (raw.indexOf('=') !== -1) {
        const params = new URLSearchParams(raw);
        const keys = ['tgWebAppData', 'WebAppData', 'webAppData', 'initData', 'init_data'];
        for (const k of keys) {
          const v = params.get(k);
          if (v) { data = v; break; }
        }
      } else {
        data = raw;
      }
      if (data) return data; // URLSearchParams has already decoded the fragment value.
    }
    if (WebApp && typeof WebApp.initData === 'string' && WebApp.initData) {
      return WebApp.initData;
    }
    return null;
  }

  const INIT_DATA = extractInitData();

  /* ================= api ================= */

  async function api(path, opts) {
    const options = opts || {};
    const method = options.method || 'GET';
    const headers = {};
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    if (INIT_DATA) headers['X-Max-Init-Data'] = INIT_DATA;

    let res;
    try {
      res = await fetch(path, {
        method,
        headers,
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      });
    } catch (err) {
      throw new Error('Нет соединения с сервером. Проверьте сеть и попробуйте ещё раз.');
    }

    let data = null;
    try { data = await res.json(); } catch (err) { /* empty body */ }

    if (!res.ok) {
      const msg = (data && (data.error || data.detail || data.message)) || 'Ошибка сервера (' + res.status + ')';
      throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
    }
    return data;
  }

  /* ================= state ================= */

  const S = {
    data: null,
    plan: 'interest',
    loading: 0,
    purchase: null,
  };

  function setLoading(on) {
    S.loading = Math.max(0, S.loading + (on ? 1 : -1));
    document.body.classList.toggle('is-loading', S.loading > 0);
  }

  /* ================= dom refs ================= */

  const bannersEl = $('#banners');
  const bannerDemo = $('#banner-demo');
  const bannerStale = $('#banner-stale');
  const bannerStaleText = $('#banner-stale-text');
  const bannerError = $('#banner-error');
  const bannerErrorText = $('#banner-error-text');
  const demoBadge = $('#demo-badge');

  const profileSummary = $('#profile-summary');
  const profileForm = $('#profile-form');
  const formIntro = $('#form-intro');
  const btnEditProfile = $('#btn-edit-profile');
  const btnCancelProfile = $('#btn-cancel-profile');

  const fBalance = $('#f-balance');
  const fLocale = $('#f-locale');
  const fLocaleText = $('#f-locale-text');
  const fDeadline = $('#f-deadline');
  const fAge = $('#f-age');
  const fMaxEvents = $('#f-max-events');
  const fBuffer = $('#f-buffer');
  const fDistance = $('#f-distance');
  const fLat = $('#f-lat');
  const fLng = $('#f-lng');
  const availabilityRows = $('#availability-rows');
  const weightsGroup = $('#weights-group');
  const weightsCont = $('#category-weights');
  const excludedGroup = $('#excluded-group');
  const excludedCont = $('#excluded-categories');

  const emptyCard = $('#empty-card');
  const emptyTitle = $('#empty-title');
  const emptyText = $('#empty-text');
  const btnEmptyAction = $('#btn-empty-action');

  const plansSection = $('#plans-section');
  const tabsEl = $('#tabs');
  const viewsEl = $('#plan-views');
  const remindersToggle = $('#reminders-toggle');
  const balanceChip = $('#balance-chip');

  const sourceLine = $('#source-line');
  const diagnosticsBlock = $('#diagnostics-block');
  const diagnosticsPre = $('#diagnostics-pre');

  const purchaseDialog = $('#purchase-dialog');
  const purchaseForm = $('#purchase-form');
  const purchaseEvent = $('#purchase-event');
  const purchasePrice = $('#purchase-price');
  const purchaseHint = $('#purchase-hint');

  const toastEl = $('#toast');

  /* ================= banners & toast ================= */

  function syncBanners() {
    bannersEl.hidden = bannerDemo.hidden && bannerStale.hidden && bannerError.hidden;
  }

  function showError(msg) {
    bannerErrorText.textContent = msg;
    bannerError.hidden = false;
    syncBanners();
  }

  function hideError() {
    bannerError.hidden = true;
    syncBanners();
  }

  let toastTimer = null;
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('is-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('is-visible'), 2800);
  }

  /* ================= rendering ================= */

  function renderAll(d) {
    hideError();
    renderBanners(d);
    renderProfile(d);
    renderEmpty(d);
    renderPlans(d);
    renderSource(d);
  }

  function renderBanners(d) {
    demoBadge.hidden = !d.demo;
    bannerDemo.hidden = !d.demo;

    const stale = !!(d.source && d.source.stale);
    bannerStale.hidden = !stale;
    if (stale) {
      bannerStaleText.textContent =
        'Данные событий устарели' +
        (d.source.fetchedAt ? ' (последнее обновление: ' + fmtDT(d.source.fetchedAt) + ').' : '.') +
        ' Планы могут не учитывать свежие изменения.';
    }
    syncBanners();
  }

  /* ---- profile ---- */

  let lastHadProfile = null;
  let formOpenFlag = false;

  function renderProfile(d) {
    const has = !!d.profile;
    if (lastHadProfile !== has) {
      if (has) {
        populateForm(d);
        profileForm.hidden = true;
        formOpenFlag = false;
      } else {
        populateForm(d);
        profileForm.hidden = false;
        formOpenFlag = true;
      }
    }
    lastHadProfile = has;

    if (has) {
      profileSummary.hidden = false;
      profileSummary.innerHTML = summaryHTML(d);
    } else {
      profileSummary.hidden = true;
      profileSummary.innerHTML = '';
    }
    syncProfileChrome();
  }

  function syncProfileChrome() {
    const has = !!(S.data && S.data.profile);
    btnEditProfile.hidden = !has || formOpenFlag;
    btnCancelProfile.hidden = !formOpenFlag || !has;
    formIntro.hidden = has || !formOpenFlag;
  }

  function openForm(scroll) {
    populateForm(S.data);
    profileForm.hidden = false;
    formOpenFlag = true;
    syncProfileChrome();
    if (scroll) profileForm.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function closeForm() {
    profileForm.hidden = true;
    formOpenFlag = false;
    syncProfileChrome();
  }

  function summaryHTML(d) {
    const p = d.profile;
    const chips = [];
    chips.push(pstat('Баланс', fmtPrice(p.maxBalance)));
    if (d.remainingBalance != null && d.remainingBalance !== p.maxBalance) {
      chips.push(pstat('Остаток сейчас', fmtPrice(d.remainingBalance)));
    }
    chips.push(pstat('Город', p.localeId || '—'));
    chips.push(pstat('Дедлайн', p.planningDeadline ? fmtDate(p.planningDeadline) : '—'));
    chips.push(pstat('Свободных окон', p.availability && p.availability.length ? String(p.availability.length) : '—'));
    chips.push(pstat('Максимум событий', p.maxEvents != null ? String(p.maxEvents) : '—'));
    if (p.age != null) chips.push(pstat('Возраст', String(p.age)));
    if (p.age != null && (p.age < 14 || p.age > 22)) {
      chips.push(pstat('Оплата Пушкинской картой', 'Программа рассчитана на возраст 14–22 года'));
    }
    if (p.maxDistanceKm != null) chips.push(pstat('Радиус', p.maxDistanceKm + ' км'));
    return chips
      .map((c) => '<div class="pstat"><span class="pstat__label">' + esc(c.label) + '</span><span class="pstat__value">' + esc(c.value) + '</span></div>')
      .join('');
  }

  function pstat(label, value) {
    return { label, value };
  }

  /* ---- profile form ---- */

  function populateForm(d) {
    const p = (d && d.profile) || {};
    fBalance.value = p.maxBalance != null ? p.maxBalance : '';
    populateLocale(d && d.locales, p.localeId);
    fDeadline.value = (p.planningDeadline || defaultDeadline()).slice(0, 10);
    fAge.value = p.age != null ? p.age : '';
    fMaxEvents.value = p.maxEvents != null ? p.maxEvents : 3;
    fBuffer.value = p.travelBufferMinutes != null ? p.travelBufferMinutes : 30;
    fDistance.value = p.maxDistanceKm != null ? p.maxDistanceKm : '';
    fLat.value = p.latitude != null ? p.latitude : '';
    fLng.value = p.longitude != null ? p.longitude : '';
    buildCategoryWeights((d && d.categories) || [], p.categoryWeights || {});
    buildExcluded((d && d.categories) || [], p.excludedCategories || []);
    buildAvailability(p.availability);
  }

  function populateLocale(locales, current) {
    const hasList = Array.isArray(locales) && locales.length > 0;
    fLocale.hidden = !hasList;
    fLocaleText.hidden = hasList;
    if (hasList) {
      fLocale.innerHTML = locales
        .map((l) => '<option value="' + esc(l) + '"' + (l === current ? ' selected' : '') + '>' + esc(l) + '</option>')
        .join('');
    } else {
      fLocaleText.value = current || '';
    }
  }

  function localeValue() {
    return fLocale.hidden ? fLocaleText.value.trim() : fLocale.value;
  }

  function buildCategoryWeights(categories, weights) {
    if (!Array.isArray(categories) || !categories.length) {
      weightsGroup.hidden = true;
      weightsCont.innerHTML = '';
      return;
    }
    weightsGroup.hidden = false;
    weightsCont.innerHTML = categories
      .map((cat) => {
        const v = clampWeight(weights[cat]);
        const opts = [1, 2, 3, 4, 5]
          .map((n) => '<button type="button" class="weight-opt' + (n === v ? ' is-active' : '') + '" data-v="' + n + '" aria-label="' + esc(cat) + ' — ' + n + '">' + n + '</button>')
          .join('');
        return '<div class="weight-row" data-category="' + esc(cat) + '"><span class="weight-row__name">' + esc(cat) + '</span><div class="weight-row__opts">' + opts + '</div></div>';
      })
      .join('');
  }

  function clampWeight(v) {
    const n = Number(v);
    return Number.isFinite(n) && n >= 1 && n <= 5 ? Math.round(n) : 3;
  }

  function buildExcluded(categories, excluded) {
    if (!Array.isArray(categories) || !categories.length) {
      excludedGroup.hidden = true;
      excludedCont.innerHTML = '';
      return;
    }
    excludedGroup.hidden = false;
    excludedCont.innerHTML = categories
      .map((cat) => {
        const on = excluded.indexOf(cat) !== -1;
        return '<label class="chip"><input type="checkbox" value="' + esc(cat) + '"' + (on ? ' checked' : '') + '><span>' + esc(cat) + '</span></label>';
      })
      .join('');
  }

  /* ---- availability ---- */

  const WEEKDAYS = [
    { v: 0, l: 'Понедельник' },
    { v: 1, l: 'Вторник' },
    { v: 2, l: 'Среда' },
    { v: 3, l: 'Четверг' },
    { v: 4, l: 'Пятница' },
    { v: 5, l: 'Суббота' },
    { v: 6, l: 'Воскресенье' },
  ];

  let availCounter = 0;

  function buildAvailability(rules) {
    availabilityRows.innerHTML = '';
    const list = Array.isArray(rules) && rules.length ? rules : [{ weekday: 6, start: '10:00', end: '22:00' }];
    list.forEach((r) => availabilityRows.appendChild(availRow(r)));
  }

  function availRow(r) {
    const isDate = !!(r && r.date);
    const name = 'avail-type-' + (++availCounter);
    const row = document.createElement('div');
    row.className = 'avail-row';
    row.innerHTML =
      '<div class="avail-row__type">' +
      '<label class="pill-radio"><input type="radio" name="' + name + '" value="weekday"' + (isDate ? '' : ' checked') + '><span>День недели</span></label>' +
      '<label class="pill-radio"><input type="radio" name="' + name + '" value="date"' + (isDate ? ' checked' : '') + '><span>Конкретная дата</span></label>' +
      '</div>' +
      '<div class="avail-row__fields">' +
      '<select class="avail-weekday"' + (isDate ? ' hidden' : '') + '>' +
      WEEKDAYS.map((w) => '<option value="' + w.v + '"' + (r && Number(r.weekday) === w.v ? ' selected' : '') + '>' + w.l + '</option>').join('') +
      '</select>' +
      '<input type="date" class="avail-date" value="' + esc(r && r.date) + '"' + (isDate ? '' : ' hidden') + '>' +
      '<input type="time" class="avail-start" value="' + esc((r && r.start) || '10:00') + '">' +
      '<span class="avail-sep">–</span>' +
      '<input type="time" class="avail-end" value="' + esc((r && r.end) || '22:00') + '">' +
      '<button type="button" class="avail-remove" title="Удалить окно" aria-label="Удалить окно">✕</button>' +
      '</div>';
    $$('input[type="radio"]', row).forEach((rd) => rd.addEventListener('change', syncAvailRow));
    $('.avail-remove', row).addEventListener('click', () => row.remove());
    return row;
  }

  function syncAvailRow(ev) {
    const row = ev.target.closest('.avail-row');
    const isDate = ev.target.value === 'date';
    $('.avail-weekday', row).hidden = isDate;
    $('.avail-date', row).hidden = !isDate;
  }

  function collectProfile() {
    const balance = Number(fBalance.value);
    if (!Number.isFinite(balance) || balance <= 0) {
      throw new Error('Укажите остаток на карте — число больше нуля.');
    }
    const deadline = fDeadline.value;
    if (!deadline) throw new Error('Укажите дедлайн планирования.');

    const availability = $$('.avail-row', availabilityRows).map((row) => {
      const isDate = $('input[value="date"]', row).checked;
      const start = $('.avail-start', row).value;
      const end = $('.avail-end', row).value;
      if (!start || !end) throw new Error('В каждом окне доступности укажите время начала и конца.');
      if (isDate) {
        const date = $('.avail-date', row).value;
        if (!date) throw new Error('Укажите дату в окне доступности.');
        return { date, start, end };
      }
      return { weekday: Number($('.avail-weekday', row).value), start, end };
    });

    const weights = {};
    $$('.weight-row', weightsCont).forEach((row) => {
      const active = $('.weight-opt.is-active', row);
      weights[row.dataset.category] = active ? Number(active.dataset.v) : 3;
    });

    const excluded = $$('input:checked', excludedCont).map((i) => i.value);

    const profile = {
      maxBalance: Math.round(balance),
      localeId: localeValue(),
      planningDeadline: deadline,
      availability,
      categoryWeights: weights,
      excludedCategories: excluded,
      maxEvents: clampInt(fMaxEvents.value, 3, 1, 4),
      travelBufferMinutes: clampInt(fBuffer.value, 30, 0, 240),
    };

    const age = Number(fAge.value);
    if (!Number.isInteger(age) || age < 1 || age > 99) throw new Error('Укажите возраст от 1 до 99 лет.');
    profile.age = age;

    const dist = Number(fDistance.value);
    if (Number.isFinite(dist) && dist > 0) profile.maxDistanceKm = dist;

    const lat = Number(fLat.value);
    const lng = Number(fLng.value);
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      profile.latitude = lat;
      profile.longitude = lng;
    }
    return profile;
  }

  /* ---- empty card ---- */

  function plansAvailable(d) {
    return !!(d && d.plans && (d.plans.interest || d.plans.more || d.plans.spend));
  }

  function renderEmpty(d) {
    const hasProfile = !!d.profile;
    if (!hasProfile || plansAvailable(d)) {
      emptyCard.hidden = true;
      return;
    }
    emptyCard.hidden = false;
    emptyTitle.textContent = 'Планы ещё не рассчитаны';
    emptyText.textContent = 'Профиль сохранён, но вариантов плана пока нет. Пересчитайте их или уточните профиль.';
    btnEmptyAction.textContent = 'Пересчитать планы';
    btnEmptyAction.dataset.action = 'recalc';
  }

  /* ---- plans ---- */

  const MODE_NAMES = { interest: 'По интересам', more: 'Больше впечатлений', spend: 'Почти без остатка' };
  const MODE_DESC = {
    interest: 'Максимум релевантных событий по вашим интересам.',
    more: 'Как можно больше впечатлений в рамках бюджета и времени.',
    spend: 'Потратить баланс почти без остатка, не жертвуя интересами.',
  };

  function renderPlans(d) {
    const avail = plansAvailable(d);
    plansSection.hidden = !avail;
    if (!avail) return;

    if (d.remainingBalance != null) {
      balanceChip.hidden = false;
      balanceChip.textContent = 'Учтённый остаток: ' + fmtPrice(d.remainingBalance);
    } else {
      balanceChip.hidden = true;
    }

    remindersToggle.checked = !!d.remindersEnabled;
    remindersToggle.disabled = !d.remindersAvailable;
    remindersToggle.title = d.remindersAvailable ? '' : 'Без подключённого бота MAX уведомления не отправляются';

    viewsEl.innerHTML = '';
    ['interest', 'more', 'spend'].forEach((key) => {
      const view = document.createElement('div');
      view.className = 'plan-view';
      view.dataset.plan = key;
      view.hidden = key !== S.plan;
      view.innerHTML = planViewHTML(d, key);
      viewsEl.appendChild(view);
    });
    syncTabs();
  }

  function planViewHTML(d, key) {
    const plan = d.plans && d.plans[key];
    if (!plan) {
      return (
        '<div class="plan-empty"><div class="plan-empty__icon" aria-hidden="true">📭</div>' +
        '<h3>' + MODE_NAMES[key] + ' — недоступен</h3>' +
        '<p>Этот вариант не был рассчитан сервером.</p></div>'
      );
    }

    const head =
      '<div class="plan-head">' +
      '<h2 class="plan-head__title">' + MODE_NAMES[key] + '</h2>' +
      '<p class="plan-head__desc">' + MODE_DESC[key] + '</p>' +
      '</div>' +
      '<div class="plan-stats">' +
      stat('события', String(plan.items ? plan.items.length : 0)) +
      stat(d.source && d.source.kind === 'culture-public' ? 'плановая сумма от' : (Array.isArray(d.purchased) && d.purchased.length ? 'новые билеты' : 'итого'), fmtPrice(plan.total)) +
      stat(d.source && d.source.kind === 'culture-public' ? 'расчётный остаток до' : 'остаток', fmtPrice(plan.leftover), 'stat--green') +
      stat('релевантность', typeof plan.score === 'number' ? String(Math.round(plan.score)) : '—', 'stat--accent') +
      '</div>';

    if (!Array.isArray(plan.items) || !plan.items.length) {
      let message = d.diagnostics && d.diagnostics.message;
      if (d.diagnostics && d.diagnostics.sourceSessions === 0) {
        message = d.source && (d.source.kind === 'unavailable' || d.source.error)
          ? 'Каталог событий ещё не загружен или источник недоступен. Профиль сохранён — попробуйте позже.'
          : 'На выбранные город и даты пока нет подходящих сеансов. Попробуйте изменить срок или город.';
      }
      return head + planEmptyHTML(message);
    }
    const selected = d.selectedPlan;
    const isSelected = selected && selected.mode === key && !selected.needsConfirmation;
    const selection = d.remindersAvailable && plan.items.some((item) => !item.purchased)
      ? '<div class="plan-selection"><button type="button" class="btn btn--outline btn--sm js-select-plan" data-mode="' + key + '">' +
        (isSelected ? '✓ Выбран для напоминаний' : 'Напоминать об этом плане') + '</button>' +
        (selected && selected.mode === key && selected.needsConfirmation ? '<span role="status">План изменился — подтвердите новый состав</span>' : '') +
        '</div>' : '';
    const items = plan.items.map((item, i) => eventCardHTML(d, item, i)).join('');
    return head + selection + '<div class="plan-items">' + items + '</div>';
  }

  function stat(label, value, cls) {
    return '<div class="stat ' + (cls || '') + '"><span class="stat__value">' + esc(value) + '</span><span class="stat__label">' + esc(label) + '</span></div>';
  }

  function planEmptyHTML(message) {
    return (
      '<div class="plan-empty"><div class="plan-empty__icon" aria-hidden="true">🔍</div>' +
      '<h3>Подходящих событий не нашлось</h3>' +
      '<p>' + esc(message || 'Попробуйте расширить свободные даты, увеличить остаток, ослабить фильтры по категориям или снять ограничение по расстоянию.') + '</p>' +
      '<button type="button" class="btn btn--primary btn--sm js-edit-profile">Настроить профиль</button></div>'
    );
  }

  function purchaseOf(d, item) {
    const sid = item.sessionId || item.id;
    const found = Array.isArray(d.purchased) ? d.purchased.find((p) => p.sessionId === sid) : undefined;
    if (found) return found;
    return item.purchased ? {} : null;
  }

  function priceLabel(item) {
    const base = fmtPrice(item.price);
    if (base === '—') return 'цена неизвестна';
    return item.exactPriceKnown ? base : 'от ' + base;
  }

  function itemLink(item) {
    // Public-afisha plans never send the user directly to an unverified seller.
    return item.source === 'culture-public' ? item.sourceUrl : item.saleLink;
  }

  function eventCardHTML(d, item, index) {
    const pur = purchaseOf(d, item);
    const parts = dateParts(item.startsAt, item.timezone);
    const priceVal = pur ? fmtPrice(pur.actualPrice != null ? pur.actualPrice : item.price) : priceLabel(item);
    const priceBasis = pur
      ? (pur.actualPrice != null ? 'фактическая цена' : 'куплено')
      : (item.exactPriceKnown ? 'точная цена' : 'минимальная цена');

    const venue = typeof item.venue === 'object' && item.venue ? [item.venue.name, item.venue.address].filter(Boolean).join(' · ') : item.venue;
    const meta = [];
    if (item.category) meta.push('<span class="tag">' + esc(item.category) + '</span>');
    if (item.startsAt) meta.push('<span class="meta-item">' + esc(fmtTime(item.startsAt, item.timezone)) + '</span>');
    if (item.endsAt) meta.push('<span class="meta-item">' + (item.endEstimated ? 'окончание примерно ' : 'до ') + esc(fmtTime(item.endsAt, item.timezone)) + '</span>');

    const reasons = Array.isArray(item.reasons) && item.reasons.length
      ? '<div class="event-card__reasons"><span class="reasons-title">Почему в плане</span><ul>' +
        item.reasons.map((r) => '<li>' + esc(r) + '</li>').join('') +
        '</ul></div>'
      : '';

    const scoreHTML = typeof item.score === 'number'
      ? '<span class="score" title="Релевантность события"><progress class="score__bar" value="' +
        Math.max(0, Math.min(100, item.score)) + '" max="100" aria-label="Релевантность события"></progress><span class="score__text">' + Math.round(item.score) + '/100</span></span>'
      : '';

    const link = itemLink(item);
    const publicAfisha = item.source === 'culture-public';
    const actions = pur
      ? '<span class="bought-badge">✓ Куплено' + (pur.actualPrice != null ? ' · ' + fmtPrice(pur.actualPrice) : '') + '</span>'
      : '<button type="button" class="btn btn--primary btn--sm btn-buy"' +
        (link ? '' : ' disabled title="Страница для проверки недоступна"') +
        (link ? ' title="Сверьте сеанс, цену и наличие самостоятельно; билеты не гарантированы"' : '') +
        '>' + (link ? (publicAfisha ? 'Проверить расписание и билеты на Культура.РФ' : 'Проверить билеты у продавца') : 'Ссылка для проверки недоступна') + '</button>' +
        '<button type="button" class="btn btn--outline btn--sm btn-bought">Купил</button>';

    return (
      '<article class="event-card' + (pur ? ' is-purchased' : '') + '" data-item-id="' + esc(item.id || '') + '" data-session-id="' + esc(item.sessionId || item.id || '') + '">' +
      '<div class="event-card__top">' +
      '<div class="event-date" aria-hidden="true"><span class="event-date__day">' + esc(parts.day) + '</span><span class="event-date__mon">' + esc(parts.mon) + '</span></div>' +
      '<div class="event-card__head">' +
      '<h3 class="event-card__title"><span class="event-index">' + (index + 1) + '</span>' + esc(item.title) + '</h3>' +
      '<div class="event-card__meta">' + meta.join('') + '</div>' +
      (venue ? '<div class="event-card__venue">📍 ' + esc(venue) + '</div>' : '') +
      '</div>' +
      '<div class="event-card__price"><span class="price-val">' + esc(priceVal) + '</span><span class="price-basis">' + esc(priceBasis) + '</span></div>' +
      '</div>' +
      reasons +
      '<div class="event-card__freshness">' + esc(d.demo ? 'Учебное событие · не для покупки' : 'Данные обновлены ' + fmtDT(item.fetchedAt || (d.source && d.source.fetchedAt)) + (publicAfisha ? ' · Предварительный план: проверьте время сеанса, возможность покупки и итоговую цену на сайте' : '')) + '</div>' +
      '<div class="event-card__foot">' + scoreHTML + '<div class="event-card__actions">' + actions + '</div></div>' +
      '</article>'
    );
  }

  function itemFromCard(card) {
    if (!S.data || !S.data.plans) return null;
    const sid = card.dataset.sessionId || card.dataset.itemId;
    for (const key of ['interest', 'more', 'spend']) {
      const plan = S.data.plans[key];
      if (!plan || !Array.isArray(plan.items)) continue;
      const it = plan.items.find((x) => (x.sessionId || x.id) === sid || x.id === card.dataset.itemId);
      if (it) return it;
    }
    return null;
  }

  function syncTabs() {
    $$('button[data-plan]', tabsEl).forEach((b) => {
      const on = b.dataset.plan === S.plan;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    $$('.plan-view', viewsEl).forEach((v) => { v.hidden = v.dataset.plan !== S.plan; });
  }

  /* ---- source & diagnostics ---- */

  function renderSource(d) {
    const src = d.source;
    if (src) {
      sourceLine.hidden = false;
      const label = [src.kind, src.label].filter(Boolean).join(' · ');
      const parts = [];
      if (label) parts.push('Данные: ' + esc(label));
      if (src.fetchedAt) parts.push('обновлено ' + esc(fmtDT(src.fetchedAt)));
      if (src.stale) parts.push('устарели');
      sourceLine.innerHTML =
        '<span class="source-dot' + (src.stale ? ' source-dot--stale' : '') + '" aria-hidden="true"></span>' +
        '<span>' + parts.join(' · ') + '</span>';
    } else {
      sourceLine.hidden = true;
    }

    const diag = d.diagnostics;
    const hasDiag = diag && typeof diag === 'object' && Object.keys(diag).length > 0;
    diagnosticsBlock.hidden = !hasDiag;
    if (hasDiag) diagnosticsPre.textContent = JSON.stringify(diag, null, 2);
  }

  /* ================= actions ================= */

  async function loadState() {
    setLoading(true);
    hideError();
    try {
      S.data = await api('/api/state');
      renderAll(S.data);
    } catch (err) {
      showError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function saveProfileObject(profile, successMsg) {
    setLoading(true);
    hideError();
    try {
      const d = await api('/api/profile', { method: 'PUT', body: profile });
      S.data = d || (await api('/api/state'));
      closeForm();
      renderAll(S.data);
      toast(successMsg || 'Профиль сохранён — планы рассчитаны');
    } catch (err) {
      showError(err.message);
    } finally {
      setLoading(false);
    }
  }

  function openSaleLink(url) {
    if (WebApp && typeof WebApp.openLink === 'function') {
      try {
        WebApp.openLink(url);
        return;
      } catch (err) { /* fall through to window.open */ }
    }
    window.open(url, '_blank', 'noopener');
  }

  function openPurchaseDialog(card) {
    const item = itemFromCard(card);
    if (!item) return;
    S.purchase = { sessionId: item.sessionId || item.id, item };

    const dt = item.startsAt ? localized(item.startsAt, { weekday:'short', day:'numeric', month:'long', hour:'2-digit', minute:'2-digit' }, item.timezone) : '';
    const venue = typeof item.venue === 'object' && item.venue ? item.venue.name : item.venue;
    purchaseEvent.innerHTML =
      '<strong>«' + esc(item.title) + '»</strong>' +
      (venue ? ' · ' + esc(venue) : '') +
      (dt ? '<br>' + esc(dt) : '');

    purchasePrice.value = item.price != null ? item.price : '';
    purchaseHint.textContent = item.exactPriceKnown
      ? 'Если фактическая цена совпадает с плановой — просто подтвердите. Иначе введите сумму, которую заплатили.'
      : 'Указана минимальная цена. Введите фактическую сумму, которую вы заплатили за билет.';

    if (typeof purchaseDialog.showModal === 'function') purchaseDialog.showModal();
    else purchaseDialog.setAttribute('open', '');
    purchasePrice.focus();
  }

  function closePurchaseDialog() {
    S.purchase = null;
    if (typeof purchaseDialog.close === 'function') purchaseDialog.close();
    else purchaseDialog.removeAttribute('open');
  }

  function shareCurrentPlan() {
    const d = S.data;
    if (!d || !d.plans) {
      toast('Плана пока нет');
      return;
    }
    const text = buildShareText(d, S.plan);
    if (!text) {
      toast('План для отправки недоступен');
      return;
    }
    if (WebApp && typeof WebApp.shareMaxContent === 'function') {
      try {
        const res = WebApp.shareMaxContent({ text });
        if (res && typeof res.catch === 'function') res.catch(() => copyText(text));
        return;
      } catch (err) { /* fall back to clipboard */ }
    }
    copyText(text);
  }

  function buildShareText(d, key) {
    const plan = d.plans && d.plans[key];
    if (!plan || !Array.isArray(plan.items) || !plan.items.length) return null;
    const lines = plan.items.map((it, i) => {
      const when = it.startsAt ? localized(it.startsAt, { day:'numeric', month:'long', hour:'2-digit', minute:'2-digit' }, it.timezone) : '';
      const pur = purchaseOf(d, it);
      const price = pur ? (pur.actualPrice != null ? fmtPrice(pur.actualPrice) : 'куплено') : priceLabel(it);
      const venue = typeof it.venue === 'object' && it.venue ? it.venue.name : it.venue;
      return (i + 1) + '. ' + when + ' — «' + it.title + '»' + (venue ? ' (' + venue + ')' : '') + ' — ' + price;
    });
    return [
      'План «' + MODE_NAMES[key] + '» · Пушка-план' + (d.demo ? ' · ДЕМО: вымышленные события, билеты недоступны' : ''),
      lines.join('\n'),
      (d.source && d.source.kind === 'culture-public' ? 'Плановая сумма от: ' : (d.purchased && d.purchased.length ? 'Новые билеты: ' : 'Итого: ')) + fmtPrice(plan.total) + ' · ' + (d.source && d.source.kind === 'culture-public' ? 'Расчётный остаток до: ' : 'Остаток: ') + fmtPrice(plan.leftover),
      ...(d.source && d.source.kind === 'culture-public' ? ['Проверьте сеанс, итоговую цену и наличие билетов на странице события.'] : []),
    ].join('\n');
  }

  function copyText(text) {
    const done = () => toast('Текст плана скопирован в буфер обмена');
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
    } else {
      fallbackCopy(text, done);
    }
  }

  function fallbackCopy(text, done) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
      done();
    } catch (err) {
      toast('Не удалось скопировать текст плана');
    } finally {
      ta.remove();
    }
  }

  /* ================= events ================= */

  function bindEvents() {
    $('#btn-retry').addEventListener('click', loadState);

    btnEditProfile.addEventListener('click', () => openForm(true));
    btnCancelProfile.addEventListener('click', closeForm);
    $('#btn-add-window').addEventListener('click', () => {
      availabilityRows.appendChild(availRow({ weekday: 6, start: '10:00', end: '22:00' }));
    });

    weightsCont.addEventListener('click', (ev) => {
      const btn = ev.target.closest('.weight-opt');
      if (!btn) return;
      const row = btn.closest('.weight-row');
      $$('.weight-opt', row).forEach((b) => b.classList.toggle('is-active', b === btn));
    });

    profileForm.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      let profile;
      try {
        profile = collectProfile();
      } catch (err) {
        toast(err.message);
        return;
      }
      await saveProfileObject(profile);
    });

    btnEmptyAction.addEventListener('click', () => {
      const action = btnEmptyAction.dataset.action;
      if (action === 'recalc') {
        const p = S.data && S.data.profile;
        if (p) saveProfileObject(p, 'Планы пересчитаны');
      } else {
        openForm(true);
      }
    });

    tabsEl.addEventListener('click', (ev) => {
      const btn = ev.target.closest('button[data-plan]');
      if (!btn) return;
      S.plan = btn.dataset.plan;
      syncTabs();
    });

    viewsEl.addEventListener('click', async (ev) => {
      const select = ev.target.closest('.js-select-plan');
      if (select) {
        setLoading(true);
        try {
          S.data = await api('/api/selected-plan', { method: 'POST', body: { mode: select.dataset.mode } });
          renderAll(S.data);
          toast('План выбран для напоминаний');
        } catch (err) { showError(err.message); }
        finally { setLoading(false); }
        return;
      }
      const buy = ev.target.closest('.btn-buy');
      if (buy) {
        const card = buy.closest('.event-card');
        const item = card && itemFromCard(card);
        if (item && itemLink(item)) {
          api('/api/track', { method: 'POST', body: { sessionId: item.id } }).catch(() => {});
          openSaleLink(itemLink(item));
        }
        return;
      }
      const bought = ev.target.closest('.btn-bought');
      if (bought) {
        openPurchaseDialog(bought.closest('.event-card'));
        return;
      }
      if (ev.target.closest('.js-edit-profile')) openForm(true);
    });

    $('#btn-share').addEventListener('click', shareCurrentPlan);

    remindersToggle.addEventListener('change', async () => {
      const enabled = remindersToggle.checked;
      setLoading(true);
      hideError();
      try {
        const d = await api('/api/reminders', { method: 'POST', body: { enabled } });
        S.data = d || (await api('/api/state'));
        renderAll(S.data);
        toast(enabled ? 'Напоминания включены' : 'Напоминания выключены');
      } catch (err) {
        remindersToggle.checked = !enabled;
        showError(err.message);
      } finally {
        setLoading(false);
      }
    });

    purchaseForm.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      if (!S.purchase) return;
      const price = Number(purchasePrice.value);
      if (!Number.isFinite(price) || price < 0) {
        toast('Введите фактическую цену билета');
        purchasePrice.focus();
        return;
      }
      setLoading(true);
      hideError();
      try {
        const d = await api('/api/purchase', {
          method: 'POST',
          body: { sessionId: S.purchase.sessionId, actualPrice: Math.round(price) },
        });
        S.data = d || (await api('/api/state'));
        closePurchaseDialog();
        renderAll(S.data);
        toast('Покупка учтена — план пересчитан под новый остаток');
      } catch (err) {
        showError(err.message);
      } finally {
        setLoading(false);
      }
    });

    $('#purchase-cancel').addEventListener('click', closePurchaseDialog);
    purchaseDialog.addEventListener('click', (ev) => {
      if (ev.target === purchaseDialog) closePurchaseDialog();
    });
  }

  /* ================= init ================= */

  function init() {
    if (WebApp) {
      try {
        if (typeof WebApp.ready === 'function') WebApp.ready();
      } catch (err) { /* optional */ }
    }
    bindEvents();
    loadState();
  }

  init();
})();
