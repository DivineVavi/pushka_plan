const { test, expect } = require('@playwright/test');

function profile(changes = {}) {
  const deadline = new Date();
  deadline.setUTCDate(deadline.getUTCDate() + 60);
  return {
    maxBalance: 3200, localeId: 'Москва', planningDeadline: deadline.toISOString().slice(0, 10),
    availability: Array.from({ length: 7 }, (_, weekday) => ({ weekday, start: '09:00', end: '23:00' })),
    categoryWeights: { 'Спектакли': 5, 'Концерты': 4, 'Выставки': 3, 'Кино': 3, 'Экскурсии': 3 },
    excludedCategories: [], age: 18, maxEvents: 4, travelBufferMinutes: 30, ...changes,
  };
}

async function start(page, withProfile = true) {
  await page.route('https://st.max.ru/**', (route) => route.abort());
  await page.goto('/');
  await expect(page.locator('#profile-form')).toBeVisible();
  if (withProfile) {
    const response = await page.request.put('/api/profile', { data: profile() });
    expect(response.ok()).toBeTruthy();
    await page.reload();
    await expect(page.locator('#plans-section')).toBeVisible();
  }
}

async function buy(page) {
  await page.locator('.plan-view:visible .btn-bought').first().click();
  await expect(page.locator('#purchase-dialog')).toBeVisible();
}

function track(page, path) {
  const requests = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === path && request.method() !== 'GET') requests.push(request);
  });
  return requests;
}

test('empty purchase price stays invalid, does not record a zero-price purchase', async ({ page }) => {
  await start(page);
  const requests = track(page, '/api/purchase');
  await buy(page);
  await page.locator('#purchase-price').fill('');
  await page.locator('#purchase-confirm').click();
  await page.waitForTimeout(150);
  expect(requests).toHaveLength(0);
  await expect(page.locator('#purchase-dialog')).toBeVisible();
  await expect(page.locator('#purchase-error')).toContainText('Введите');
  const state = await (await page.request.get('/api/state')).json();
  expect(state.purchased).toHaveLength(0);
});

test('no raw diagnostics or scoring; provenance, estimates and age rating remain', async ({ page }) => {
  await start(page);
  await expect(page.locator('#diagnostics-block')).toHaveCount(0);
  await expect(page.locator('#diagnostics-pre')).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText('sourceSessions');
  await expect(page.locator('body')).not.toContainText('excludedBy');
  await expect(page.locator('.score')).toHaveCount(0);
  await expect(page.locator('.plan-view:visible .plan-stats')).not.toContainText('релевантность');
  await expect(page.locator('.plan-view:visible .event-card').first()).toContainText('Почему в плане');
  await expect(page.locator('.plan-view:visible .event-card').first()).toContainText(/\d+\+/);
  await expect(page.locator('.plan-view:visible .event-card').first()).toContainText('окончание примерно');
  await expect(page.locator('#source-line')).toContainText('Подготовленный');
  await expect(page.locator('#banner-stale')).toBeVisible();
  await expect(page.locator('.plan-view:visible .price-val').first()).toContainText('от');
  await expect(page.locator('.plans__note')).toContainText('не гарантируют');
});

test('explicit zero and nonzero actual prices remain valid and replan correctly', async ({ page }) => {
  await start(page);
  await buy(page);
  await page.locator('#purchase-price').fill('0');
  await page.locator('#purchase-confirm').click();
  await expect(page.locator('#purchase-dialog')).not.toBeVisible();
  let state = await (await page.request.get('/api/state')).json();
  expect(state.purchased[0].actualPrice).toBe(0);
  expect(state.remainingBalance).toBe(3200);
  await buy(page);
  await page.locator('#purchase-price').fill('900');
  await page.locator('#purchase-confirm').click();
  await expect(page.locator('#purchase-dialog')).not.toBeVisible();
  state = await (await page.request.get('/api/state')).json();
  expect(state.remainingBalance).toBe(2300);
  expect(state.purchased).toHaveLength(2);
});

test('fractional price is rejected instead of rounded', async ({ page }) => {
  await start(page);
  const requests = track(page, '/api/purchase');
  await buy(page);
  for (const value of ['400.5', '400.0000000000000001']) {
    await page.locator('#purchase-price').fill(value);
    await page.locator('#purchase-confirm').click();
    await expect(page.locator('#purchase-error')).toContainText('цел');
    await expect(page.locator('#purchase-price')).toHaveValue(value);
    expect(requests).toHaveLength(0);
  }
});

test('server purchase errors are visible inside the modal and input is preserved', async ({ page }) => {
  await start(page);
  await buy(page);
  await page.locator('#purchase-price').fill('3201');
  await page.locator('#purchase-confirm').click();
  await expect(page.locator('#purchase-error')).toContainText('превышает');
  await expect(page.locator('#purchase-error')).toBeInViewport();
  await expect(page.locator('#purchase-price')).toHaveValue('3201');
  await expect(page.locator('#purchase-dialog')).toBeVisible();
  const state = await (await page.request.get('/api/state')).json();
  expect(state.purchased).toHaveLength(0);
});

test('network purchase errors also stay inside the modal', async ({ page }) => {
  await start(page);
  await page.route('**/api/purchase', (route) => route.abort());
  await buy(page);
  await page.locator('#purchase-confirm').click();
  await expect(page.locator('#purchase-error')).toContainText('соединения');
  await expect(page.locator('#purchase-error')).toBeInViewport();
});

test('legacy distance constraints still explain an empty plan without exposing unfinished location controls', async ({ page }) => {
  await start(page);
  const response = await page.request.put('/api/profile', { data: profile({ maxDistanceKm: 10, latitude: 0, longitude: 0 }) });
  expect(response.ok()).toBeTruthy();
  await page.reload();
  await expect(page.locator('#plans-section')).toBeVisible();
  const state = await (await page.request.get('/api/state')).json();
  expect(state.profile.latitude).toBe(0);
  expect(state.profile.longitude).toBe(0);
  expect(state.diagnostics.eligibleSessions).toBe(0);
  const excluded = state.diagnostics.excludedBy['расстояние'];
  expect(excluded).toBeGreaterThan(0);
  await expect(page.locator('.plan-view:visible .plan-exclusions')).toContainText('расстояние — ' + excluded);
  await expect(page.locator('.plan-view:visible .plan-exclusions')).toContainText('первая причина');
});

test('deadline, integer balance and event limits are validated visibly without clamping', async ({ page }) => {
  await start(page);
  const requests = track(page, '/api/profile');
  await page.locator('#btn-edit-profile').click();
  await page.locator('#f-balance').fill('3200.5');
  await page.locator('#profile-form button[type=submit]').click();
  await expect(page.locator('#profile-error')).toContainText('цел');
  await expect(page.locator('#f-balance')).toHaveValue('3200.5');
  await page.locator('#f-balance').fill('3200');
  await page.locator('#f-deadline').fill('2099-12-31');
  await page.locator('#profile-form button[type=submit]').click();
  await expect(page.locator('#profile-error')).toContainText('90');
  await expect(page.locator('#profile-error')).toBeInViewport();
  await page.locator('#f-deadline').fill(profile().planningDeadline);
  await page.locator('#f-max-events').fill('8');
  await page.locator('#profile-form button[type=submit]').click();
  await expect(page.locator('#profile-error')).toContainText('4');
  await expect(page.locator('#f-max-events')).toHaveValue('8');
  expect(requests).toHaveLength(0);
});

test('card profile enforces inclusive age 14–22 and balance up to 5000', async ({ page }) => {
  await start(page);
  const requests = track(page, '/api/profile');
  await page.locator('#btn-edit-profile').click();
  await expect(page.locator('#f-age')).toHaveAttribute('min', '14');
  await expect(page.locator('#f-age')).toHaveAttribute('max', '22');
  await expect(page.locator('#f-balance')).toHaveAttribute('max', '5000');
  for (const age of ['13', '23']) {
    await page.locator('#f-age').fill(age);
    await page.locator('#profile-form button[type=submit]').click();
    await expect(page.locator('#profile-error')).toContainText('от 14 до 22');
  }
  await page.locator('#f-age').fill('18');
  await page.locator('#f-balance').fill('5001');
  await page.locator('#profile-form button[type=submit]').click();
  await expect(page.locator('#profile-error')).toContainText('до 5000');
  expect(requests).toHaveLength(0);
  for (const age of ['14', '22']) {
    await page.locator('#f-age').fill(age);
    await page.locator('#f-balance').fill('5000');
    await page.locator('#profile-form button[type=submit]').click();
    await expect(page.locator('#profile-form')).not.toBeVisible();
    const state = await (await page.request.get('/api/state')).json();
    expect(state.profile.age).toBe(Number(age));
    expect(state.profile.maxBalance).toBe(5000);
    await page.locator('#btn-edit-profile').click();
  }
});

test('server profile errors stay in the form with edits preserved', async ({ page }) => {
  await start(page);
  await page.locator('#btn-edit-profile').click();
  await page.route('**/api/profile', (route) => route.fulfill({ status: 400, json: { error: 'Новый баланс меньше уже записанных покупок' } }));
  await page.locator('#f-balance').fill('2500');
  await page.locator('#profile-form button[type=submit]').click();
  await expect(page.locator('#profile-error')).toContainText('меньше');
  await expect(page.locator('#profile-error')).toBeInViewport();
  await expect(page.locator('#f-balance')).toHaveValue('2500');
  await expect(page.locator('#profile-form')).toBeVisible();
});

test('401 on entry explains opening MAX and has no useless retry', async ({ page }) => {
  await start(page);
  await page.route('**/api/state', (route) => route.fulfill({ status: 401, json: { error: 'Подпись MAX не совпала' } }));
  await page.reload();
  await expect(page.locator('#auth-required')).toBeVisible();
  await expect(page.locator('#auth-required')).toContainText('MAX');
  await expect(page.locator('#auth-bot-link')).toHaveAttribute('href', 'https://max.ru/t99_hakaton_max_bot');
  await expect(page.locator('#profile-card')).not.toBeVisible();
  await expect(page.locator('#plans-section')).not.toBeVisible();
  await expect(page.locator('#btn-retry')).not.toBeVisible();
  await expect(page.locator('body')).not.toContainText('Подпись MAX не совпала');
});

test('session expiration during purchase exits the modal into MAX login guidance', async ({ page }) => {
  await start(page);
  await page.route('**/api/purchase', (route) => route.fulfill({ status: 401, json: { error: 'Данные запуска MAX устарели' } }));
  await buy(page);
  await page.locator('#purchase-confirm').click();
  await expect(page.locator('#purchase-dialog')).not.toBeVisible();
  await expect(page.locator('#auth-required')).toBeVisible();
  await expect(page.locator('#auth-required')).toContainText('заново');
  await expect(page.locator('#profile-card')).not.toBeVisible();
  await expect(page.locator('#plans-section')).not.toBeVisible();
  await expect(page.locator('#profile-summary')).toBeEmpty();
  await expect(page.locator('#plan-views')).toBeEmpty();
  await expect(page.locator('#purchase-event')).toBeEmpty();
  await expect(page.locator('#purchase-price')).toHaveValue('');
  await expect(page.locator('#f-balance')).toHaveValue('');
  await expect(page.locator('#balance-chip')).toBeEmpty();
  await expect(page.locator('#btn-retry')).not.toBeVisible();
});

test('unavailable reminders have a visible, accessible explanation', async ({ page }) => {
  await start(page);
  await expect(page.locator('#reminders-toggle')).toBeDisabled();
  await expect(page.locator('#reminders-hint')).toBeVisible();
  await expect(page.locator('#reminders-hint')).toContainText('MAX');
  await expect(page.locator('#reminders-toggle')).toHaveAttribute('aria-describedby', 'reminders-hint');
  await expect(page.locator('#reminders-control')).toHaveClass(/is-unavailable/);
});

test('clipboard failure does not claim success; confirmation requires a true result', async ({ page }) => {
  await start(page);
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
    document.execCommand = () => false;
  });
  await page.locator('#btn-share').click();
  await expect(page.locator('#toast')).toContainText('Не удалось');
  await expect(page.locator('.clipboard-copy')).toHaveCount(0);
  await page.evaluate(() => { document.execCommand = () => true; });
  await page.locator('#btn-share').click();
  await expect(page.locator('#toast')).toContainText('скопирован');
});

test('a valid form still saves all hard constraints and produces plans', async ({ page }) => {
  await start(page, false);
  await page.locator('#f-balance').fill('3200');
  await page.locator('#f-age').fill('18');
  await page.locator('#f-deadline').fill(profile().planningDeadline);
  await page.locator('#f-max-events').fill('4');
  for (let i = 0; i < 6; i++) await page.locator('#btn-add-window').click();
  const rows = page.locator('.avail-row');
  for (let i = 0; i < 7; i++) {
    await rows.nth(i).locator('.avail-weekday').selectOption(String(i));
    await rows.nth(i).locator('.avail-start').fill('09:00');
    await rows.nth(i).locator('.avail-end').fill('23:00');
  }
  await page.locator('#profile-form button[type=submit]').click();
  await expect(page.locator('#plans-section')).toBeVisible();
  await expect(page.locator('#profile-error')).not.toBeVisible();
  const state = await (await page.request.get('/api/state')).json();
  expect(state.profile.availability).toHaveLength(7);
  expect(state.profile.maxEvents).toBe(4);
  for (const plan of Object.values(state.plans)) {
    expect(plan.items.length).toBeGreaterThan(0);
    expect(plan.items.length).toBeLessThanOrEqual(4);
    expect(plan.total).toBeLessThanOrEqual(3200);
  }
  const layout = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }));
  expect(layout.scrollWidth).toBeLessThanOrEqual(layout.width);
});

// Bridge/launch payloads below are fixtures, not real MAX-client acceptance.
for (const source of ['bridge with unrelated anchor', 'wrapped fragment', 'direct fragment']) {
  test('launch header survives ' + source, async ({ page }) => {
    const launch = 'auth_date=123&user=%7B%22id%22%3A99%7D&hash=test-fixture';
    const bridgeData = source === 'bridge with unrelated anchor' ? launch : launch.replace('test-fixture', 'bridge-fixture');
    await page.addInitScript((initData) => { window.WebApp = { initData }; }, bridgeData);
    await page.route('https://st.max.ru/**', (route) => route.abort());
    const requests = [];
    page.on('request', (request) => {
      if (new URL(request.url()).pathname.startsWith('/api/')) requests.push(request);
    });
    const hash = source === 'wrapped fragment' ? new URLSearchParams({ tgWebAppData: launch }).toString()
      : source === 'direct fragment' ? launch : 'plan';
    await page.goto('/#' + hash);
    await expect(page.locator('#profile-form')).toBeVisible();
    expect(requests.length).toBeGreaterThan(0);
    for (const request of requests) expect(request.headers()['x-max-init-data']).toBe(launch);
  });
}

test('retrying an initial network/server failure reloads state', async ({ page }) => {
  await page.route('https://st.max.ru/**', (route) => route.abort());
  let calls = 0;
  await page.route('**/api/state', (route) => ++calls === 1
    ? route.fulfill({ status: 503, json: { error: 'Временно недоступно' } }) : route.continue());
  await page.goto('/');
  await expect(page.locator('#banner-error')).toBeVisible();
  await expect(page.locator('#profile-card')).not.toBeVisible();
  await page.locator('#btn-retry').click();
  await expect(page.locator('#profile-form')).toBeVisible();
  expect(calls).toBe(2);
  await expect(page.locator('#banner-error')).not.toBeVisible();
});

async function showReminderCapability(page) {
  const state = await (await page.request.get('/api/state')).json();
  await page.route('**/api/state', (route) => route.fulfill({ json: { ...state, remindersAvailable: true } }));
  await page.reload();
  await expect(page.locator('#reminders-toggle')).toBeEnabled();
  return state;
}

test('retry resends the selected-plan operation, not just GET state', async ({ page }) => {
  await start(page);
  await showReminderCapability(page);
  const requests = track(page, '/api/selected-plan');
  let calls = 0;
  await page.route('**/api/selected-plan', (route) => ++calls === 1
    ? route.fulfill({ status: 503, json: { error: 'Не удалось выбрать план' } }) : route.continue());
  await page.locator('.plan-view:visible .js-select-plan').click();
  await expect(page.locator('#banner-error')).toBeInViewport();
  await page.locator('#btn-retry').click();
  await expect(page.locator('#banner-error')).not.toBeVisible();
  expect(requests.map((request) => request.postDataJSON())).toEqual([{ mode: 'interest' }, { mode: 'interest' }]);
  const state = await (await page.request.get('/api/state')).json();
  expect(state.selectedPlan.mode).toBe('interest');
});

test('retry resends the failed reminders setting and preserves the intended value', async ({ page }) => {
  await start(page);
  const state = await showReminderCapability(page);
  const requests = track(page, '/api/reminders');
  let calls = 0;
  await page.route('**/api/reminders', (route) => ++calls === 1
    ? route.fulfill({ status: 503, json: { error: 'Не удалось включить напоминания' } })
    : route.fulfill({ json: { ...state, remindersAvailable: true, remindersEnabled: true } }));
  await page.locator('#reminders-control').click();
  await expect(page.locator('#banner-error')).toBeInViewport();
  await expect(page.locator('#reminders-toggle')).not.toBeChecked();
  await page.locator('#btn-retry').click();
  await expect(page.locator('#banner-error')).not.toBeVisible();
  await expect(page.locator('#reminders-toggle')).toBeChecked();
  expect(requests.map((request) => request.postDataJSON())).toEqual([{ enabled: true }, { enabled: true }]);
});

test('fresh simulated data keeps demo disclaimers and disabled ticket links', async ({ page }) => {
  await start(page);
  const state = await (await page.request.get('/api/state')).json();
  const stamp = new Date().toISOString();
  const plans = Object.fromEntries(Object.entries(state.plans).map(([mode, plan]) => [mode, {
    ...plan, items: plan.items.map((item) => ({ ...item, source: 'fixture', saleLink: null, fetchedAt: stamp })),
  }]));
  await page.route('**/api/state', (route) => route.fulfill({ json: {
    ...state, demo: true, plans,
    source: { kind: 'simulated', label: 'Учебный набор: вымышленные события', fetchedAt: stamp, stale: false },
  } }));
  await page.reload();
  await expect(page.locator('#banner-demo')).toContainText('смоделированы');
  await expect(page.locator('#demo-badge')).toBeVisible();
  await expect(page.locator('#banner-stale')).not.toBeVisible();
  await expect(page.locator('.plan-view:visible .event-card').first()).toContainText('не для покупки');
  await expect(page.locator('.plan-view:visible .btn-buy').first()).toBeDisabled();
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.locator('#btn-share').click();
  await expect(page.locator('#toast')).toContainText('скопирован');
  const shared = await page.evaluate(() => navigator.clipboard.readText());
  expect(shared).toContain('ДЕМО: вымышленные события, билеты недоступны');
});
