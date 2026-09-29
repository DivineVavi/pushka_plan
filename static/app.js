/* «Пушка-план» — mini-app frontend. No dependencies.
 *
 * Auth: MAX launch data is taken from the location.hash fragment or
 * window.WebApp.initData and sent as the X-Max-Init-Data header on every
 * request. With a configured bot, missing/expired launch data requires
 * reopening in MAX. A tokenless local sandbox uses a scoped cookie.
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

  function fieldError(message, field) {
    const err = new Error(message);
    err.field = field;
    return err;
  }

  function readNumber(field, label, min, max, integer = true, optional = false) {
    const raw = field.value.trim();
    if (optional && raw === '' && !field.validity.badInput) return null;
    const n = Number(raw);
    // Inspect the text too: Number('400.0000000000000001') rounds to 400.
    // Whole-ruble fields must never turn such a fraction into a purchase.
    const whole = Number.isInteger(n) && /^\d+(?:\.0+)?$/.test(raw);
    if (raw === '' || !Number.isFinite(n) || (integer && !whole) || n < min || n > max) {
      throw fieldError('Введите ' + label + ': ' + (integer ? 'целое число ' : 'число ') + 'от ' + min + ' до ' + max + '.', field);
    }
    return n;
  }

  function syncDateBounds() {
    const today = new Date();
    fDeadline.min = today.toISOString().slice(0, 10);
    today.setUTCDate(today.getUTCDate() + 90);
    fDeadline.max = today.toISOString().slice(0, 10);
    $$('.avail-date', availabilityRows).forEach((input) => {
      input.min = fDeadline.min;
      input.max = fDeadline.value && fDeadline.value <= fDeadline.max ? fDeadline.value : fDeadline.max;
    });
  }

  function defaultDeadline() {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + 30);
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
        // A direct signed query-string fragment is also supported. A normal
        // page anchor such as #plan must not shadow valid bridge launch data.
        if (!data && params.has('hash') && params.has('auth_date') && params.has('user')) data = raw;
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
      const err = new Error(typeof msg === 'string' ? msg : 'Ошибка сервера (' + res.status + ')');
      err.status = res.status;
      if (res.status === 401) showAuthRequired();
      throw err;
    }
    return data;
  }

  /* ================= state ================= */

  const S = {
    data: null,
    plan: 'interest',
    loading: 0,
    purchase: null,
    retry: null,
  };

  let lastHadProfile = null;
  let formOpenFlag = false;

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

  const profileCard = $('#profile-card');
  const authRequired = $('#auth-required');
  const profileError = $('#profile-error');
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
  const remindersControl = $('#reminders-control');
  const remindersHint = $('#reminders-hint');
  const balanceChip = $('#balance-chip');

  const sourceLine = $('#source-line');

  const purchaseDialog = $('#purchase-dialog');
  const purchaseForm = $('#purchase-form');
  const purchaseEvent = $('#purchase-event');
  const purchasePrice = $('#purchase-price');
  const purchaseHint = $('#purchase-hint');
  const purchaseError = $('#purchase-error');

  const toastEl = $('#toast');

  /* ================= banners & toast ================= */

  function syncBanners() {
    bannersEl.hidden = bannerDemo.hidden && bannerStale.hidden && bannerError.hidden;
  }

  function showError(err, retry) {
    if (err.status === 401) return; // api() already switched to MAX guidance.
    bannerErrorText.textContent = err.message || String(err);
    bannerError.hidden = false;
    S.retry = retry || null;
    $('#btn-retry').hidden = !S.retry;
    syncBanners();
    bannerError.focus({ preventScroll: true });
    bannerError.scrollIntoView({ block: 'center' });
  }

  function hideError() {
    bannerError.hidden = true;
    S.retry = null;
    syncBanners();
  }

  function clearProfileError() {
    profileError.hidden = true;
    profileError.textContent = '';
    $$('[aria-invalid]', profileForm).forEach((field) => {
      field.removeAttribute('aria-invalid');
      const ids = (field.getAttribute('aria-describedby') || '').split(' ').filter((id) => id && id !== 'profile-error');
      if (ids.length) field.setAttribute('aria-describedby', ids.join(' '));
      else field.removeAttribute('aria-describedby');
    });
    $('.form-actions', profileForm).before(profileError);
  }

  function showProfileError(err) {
    if (err.status === 401) return;
    clearProfileError();
    const field = err.field;
    if (field && profileForm.contains(field)) {
      const details = field.closest('details');
      if (details) details.open = true;
      (field.closest('.field, .avail-row') || field).after(profileError);
      field.setAttribute('aria-invalid', 'true');
      field.setAttribute('aria-describedby', ((field.getAttribute('aria-describedby') || '') + ' profile-error').trim());
    }
    profileError.textContent = err.message;
    profileError.hidden = false;
    (field && field.matches('input, select') ? field : profileError).focus({ preventScroll: true });
    profileError.scrollIntoView({ block: 'center' });
  }

  function clearPurchaseError() {
    purchaseError.hidden = true;
    purchaseError.textContent = '';
    purchasePrice.removeAttribute('aria-invalid');
  }

  function showPurchaseError(err) {
    if (err.status === 401) return;
    purchaseError.textContent = err.message;
    purchaseError.hidden = false;
    if (err.field) purchasePrice.setAttribute('aria-invalid', 'true');
    purchasePrice.focus({ preventScroll: true });
    purchaseError.scrollIntoView({ block: 'center' });
  }

  function showAuthRequired() {
    closePurchaseDialog();
    clearProfileError();
    S.data = null;
    lastHadProfile = null;
    formOpenFlag = false;
    profileCard.hidden = true;
    profileForm.hidden = true;
    profileSummary.innerHTML = '';
    availabilityRows.innerHTML = '';
    weightsCont.innerHTML = '';
    excludedCont.innerHTML = '';
    fLocale.innerHTML = '';
    $$('input', profileForm).forEach((input) => { input.value = ''; });
    plansSection.hidden = true;
    viewsEl.innerHTML = '';
    emptyCard.hidden = true;
    sourceLine.hidden = true;
    sourceLine.innerHTML = '';
    balanceChip.textContent = '';
    purchaseEvent.innerHTML = '';
    purchasePrice.value = '';
    purchaseHint.textContent = '';
    bannerErrorText.textContent = '';
    toastEl.textContent = '';
    bannerDemo.hidden = true;
    bannerStale.hidden = true;
    demoBadge.hidden = true;
    toastEl.classList.remove('is-visible');
    hideError();
    $('#btn-retry').hidden = true;
    authRequired.hidden = false;
    authRequired.focus({ preventScroll: true });
    authRequired.scrollIntoView({ block: 'start' });
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
    authRequired.hidden = true;
    profileCard.hidden = false;
    hideError();
    clearProfileError();
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
    clearProfileError();
    populateForm(S.data);
    profileForm.hidden = false;
    formOpenFlag = true;
    syncProfileChrome();
    if (scroll) profileForm.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function closeForm() {
    clearProfileError();
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
    syncDateBounds();
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
    $('#btn-add-window').disabled = list.length >= 40;
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
    $('.avail-remove', row).addEventListener('click', () => {
      clearProfileError();
      row.remove();
      $('#btn-add-window').disabled = $$('.avail-row', availabilityRows).length >= 40;
    });
    $('.avail-date', row).min = fDeadline.min;
    $('.avail-date', row).max = fDeadline.value || fDeadline.max;
    return row;
  }

  function syncAvailRow(ev) {
    const row = ev.target.closest('.avail-row');
    const isDate = ev.target.value === 'date';
    $('.avail-weekday', row).hidden = isDate;
    $('.avail-date', row).hidden = !isDate;
  }

  function collectProfile() {
    const balance = readNumber(fBalance, 'остаток на карте', 0, 100000);
    syncDateBounds();
    const deadline = fDeadline.value;
    if (!deadline || deadline < fDeadline.min || deadline > fDeadline.max) {
      throw fieldError('Укажите срок от сегодня до следующих 90 дней.', fDeadline);
    }
    const locale = localeValue();
    if (!locale || locale.length > 100) throw fieldError('Укажите город (не больше 100 символов).', fLocale.hidden ? fLocaleText : fLocale);
    const rows = $$('.avail-row', availabilityRows);
    if (!rows.length || rows.length > 40) throw fieldError('Укажите от 1 до 40 свободных окон.', availabilityRows);
    const availability = rows.map((row) => {
      const isDate = $('input[value="date"]', row).checked;
      const start = $('.avail-start', row).value;
      const end = $('.avail-end', row).value;
      if (!start || !end || start >= end) throw fieldError('Укажите время начала и конца окна: конец должен быть позже начала в тот же день.', !start ? $('.avail-start', row) : $('.avail-end', row));
      if (isDate) {
        const date = $('.avail-date', row).value;
        if (!date || date < fDeadline.min || date > deadline) throw fieldError('Укажите свободную дату от сегодня до срока планирования.', $('.avail-date', row));
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
      maxBalance: balance,
      localeId: locale,
      planningDeadline: deadline,
      availability,
      categoryWeights: weights,
      excludedCategories: excluded,
      maxEvents: readNumber(fMaxEvents, 'количество событий', 1, 4),
      travelBufferMinutes: readNumber(fBuffer, 'запас на дорогу в минутах', 0, 240),
      age: readNumber(fAge, 'возраст', 0, 120),
    };

    const dist = readNumber(fDistance, 'радиус в километрах', 0, 500, false, true);
    if (dist !== null) {
      if (dist <= 0) throw fieldError('Радиус должен быть больше 0 и не больше 500 км. Очистите поле, чтобы снять ограничение.', fDistance);
      profile.maxDistanceKm = dist;
      profile.latitude = readNumber(fLat, 'широту', -90, 90, false);
      profile.longitude = readNumber(fLng, 'долготу', -180, 180, false);
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

  const isPublicSource = (d) => d.source && ['culture-public', 'culture-public-prepared'].includes(d.source.kind);
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
    remindersControl.classList.toggle('is-unavailable', !d.remindersAvailable);
    remindersHint.hidden = !!d.remindersAvailable;

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
      stat(isPublicSource(d) ? 'плановая сумма от' : (Array.isArray(d.purchased) && d.purchased.length ? 'новые билеты' : 'итого'), fmtPrice(plan.total)) +
      stat(isPublicSource(d) ? 'расчётный остаток до' : 'остаток', fmtPrice(plan.leftover), 'stat--green') +
      '</div>';

    if (!Array.isArray(plan.items) || !plan.items.length) {
      let message = d.diagnostics && d.diagnostics.message;
      if (d.diagnostics && d.diagnostics.sourceSessions === 0) {
        message = d.source && (d.source.kind === 'unavailable' || d.source.error)
          ? 'Каталог событий ещё не загружен или источник недоступен. Профиль сохранён — попробуйте позже.'
          : 'На выбранные город и даты пока нет подходящих сеансов. Попробуйте изменить срок или город.';
      }
      return head + planEmptyHTML(message, d.diagnostics && d.diagnostics.excludedBy);
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

  function planEmptyHTML(message, excludedBy) {
    const exclusions = Object.entries(excludedBy || {})
      .filter(([, count]) => Number.isInteger(count) && count > 0)
      .sort((a, b) => b[1] - a[1]);
    const reasons = exclusions.length
      ? '<div class="plan-exclusions"><p>Основные ограничения, отсеявшие сеансы:</p><ul>' +
        exclusions.slice(0, 3).map(([label, count]) => '<li>' + esc(label) + ' — ' + esc(priceFmt.format(count)) + '</li>').join('') +
        '</ul><p>Для каждого сеанса учтена первая причина исключения.</p></div>'
      : '';
    return (
      '<div class="plan-empty"><div class="plan-empty__icon" aria-hidden="true">🔍</div>' +
      '<h3>Подходящих событий не нашлось</h3>' +
      '<p>' + esc(message || 'Попробуйте расширить свободные даты, увеличить остаток, ослабить фильтры по категориям или снять ограничение по расстоянию.') + '</p>' +
      reasons +
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
    if (Number.isInteger(item.ageRestriction) && item.ageRestriction >= 0) {
      meta.push('<span class="tag" aria-label="Возрастная маркировка события">' + item.ageRestriction + '+</span>');
    }
    if (item.startsAt) meta.push('<span class="meta-item">' + esc(fmtTime(item.startsAt, item.timezone)) + '</span>');
    if (item.endsAt) meta.push('<span class="meta-item">' + (item.endEstimated ? 'окончание примерно ' : 'до ') + esc(fmtTime(item.endsAt, item.timezone)) + '</span>');

    const reasons = Array.isArray(item.reasons) && item.reasons.length
      ? '<div class="event-card__reasons"><span class="reasons-title">Почему в плане</span><ul>' +
        item.reasons.map((r) => '<li>' + esc(r) + '</li>').join('') +
        '</ul></div>'
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
      '<div class="event-card__foot"><div class="event-card__actions">' + actions + '</div></div>' +
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

  /* ---- source ---- */

  function renderSource(d) {
    const src = d.source;
    if (src) {
      sourceLine.hidden = false;
      const label = src.label || 'Источник не указан';
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

  }

  /* ================= actions ================= */

  async function loadState() {
    setLoading(true);
    hideError();
    try {
      S.data = await api('/api/state');
      renderAll(S.data);
    } catch (err) {
      showError(err, loadState);
    } finally {
      setLoading(false);
    }
  }

  async function saveProfileObject(profile, successMsg, fromForm = false) {
    setLoading(true);
    hideError();
    try {
      const d = await api('/api/profile', { method: 'PUT', body: profile });
      S.data = d || (await api('/api/state'));
      closeForm();
      renderAll(S.data);
      toast(successMsg || 'Профиль сохранён — планы рассчитаны');
    } catch (err) {
      if (fromForm) showProfileError(err);
      else showError(err, () => saveProfileObject(profile, successMsg));
    } finally {
      setLoading(false);
    }
  }

  async function selectPlan(mode) {
    setLoading(true);
    hideError();
    try {
      S.data = await api('/api/selected-plan', { method: 'POST', body: { mode } });
      renderAll(S.data);
      toast('План выбран для напоминаний');
    } catch (err) {
      showError(err, () => selectPlan(mode));
    } finally {
      setLoading(false);
    }
  }

  async function setReminders(enabled) {
    setLoading(true);
    hideError();
    try {
      const d = await api('/api/reminders', { method: 'POST', body: { enabled } });
      S.data = d || (await api('/api/state'));
      renderAll(S.data);
      toast(enabled ? 'Напоминания включены' : 'Напоминания выключены');
    } catch (err) {
      remindersToggle.checked = !enabled;
      showError(err, () => setReminders(enabled));
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

    clearPurchaseError();
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
    clearPurchaseError();
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
      (isPublicSource(d) ? 'Плановая сумма от: ' : (d.purchased && d.purchased.length ? 'Новые билеты: ' : 'Итого: ')) + fmtPrice(plan.total) + ' · ' + (isPublicSource(d) ? 'Расчётный остаток до: ' : 'Остаток: ') + fmtPrice(plan.leftover),
      ...(isPublicSource(d) ? ['Проверьте сеанс, итоговую цену и наличие билетов на странице события.'] : []),
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
    ta.className = 'clipboard-copy';
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
      if (document.execCommand('copy')) done();
      else toast('Не удалось скопировать текст плана');
    } catch (err) {
      toast('Не удалось скопировать текст плана');
    } finally {
      ta.remove();
    }
  }

  /* ================= events ================= */

  function bindEvents() {
    $('#btn-retry').addEventListener('click', () => {
      if (!S.loading && S.retry) S.retry();
    });
    fDeadline.addEventListener('change', syncDateBounds);

    btnEditProfile.addEventListener('click', () => openForm(true));
    btnCancelProfile.addEventListener('click', closeForm);
    $('#btn-add-window').addEventListener('click', () => {
      if ($$('.avail-row', availabilityRows).length >= 40) return;
      availabilityRows.appendChild(availRow({ weekday: 6, start: '10:00', end: '22:00' }));
      $('#btn-add-window').disabled = $$('.avail-row', availabilityRows).length >= 40;
    });

    weightsCont.addEventListener('click', (ev) => {
      const btn = ev.target.closest('.weight-opt');
      if (!btn) return;
      const row = btn.closest('.weight-row');
      $$('.weight-opt', row).forEach((b) => b.classList.toggle('is-active', b === btn));
    });

    profileForm.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      if (S.loading) return;
      clearProfileError();
      let profile;
      try {
        profile = collectProfile();
      } catch (err) {
        showProfileError(err);
        return;
      }
      await saveProfileObject(profile, undefined, true);
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
        if (!S.loading) await selectPlan(select.dataset.mode);
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
      if (!S.loading) await setReminders(remindersToggle.checked);
      else remindersToggle.checked = !!(S.data && S.data.remindersEnabled);
    });

    purchaseForm.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      if (!S.purchase || S.loading) return;
      clearPurchaseError();
      let price;
      try {
        price = readNumber(purchasePrice, 'фактическую цену билета', 0, 100000);
      } catch (err) {
        showPurchaseError(err);
        return;
      }
      setLoading(true);
      $('#purchase-confirm').disabled = true;
      $('#purchase-cancel').disabled = true;
      hideError();
      try {
        const d = await api('/api/purchase', {
          method: 'POST',
          body: { sessionId: S.purchase.sessionId, actualPrice: price },
        });
        S.data = d || (await api('/api/state'));
        closePurchaseDialog();
        renderAll(S.data);
        toast('Покупка учтена — план пересчитан под новый остаток');
      } catch (err) {
        showPurchaseError(err);
      } finally {
        $('#purchase-confirm').disabled = false;
        $('#purchase-cancel').disabled = false;
        setLoading(false);
      }
    });

    $('#purchase-cancel').addEventListener('click', closePurchaseDialog);
    purchaseDialog.addEventListener('click', (ev) => {
      if (ev.target === purchaseDialog && !S.loading) closePurchaseDialog();
    });
    purchaseDialog.addEventListener('cancel', (ev) => {
      if (S.loading) ev.preventDefault();
      else { S.purchase = null; clearPurchaseError(); }
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
