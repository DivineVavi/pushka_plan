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

async function stateOf(page) {
  return (await page.request.get('/api/state')).json();
}

async function showReminderCapability(page, changes = {}) {
  const state = await stateOf(page);
  const fixture = { ...state, remindersAvailable: true, ...changes };
  await page.route('**/api/state', (route) => route.fulfill({ json: fixture }));
  await page.reload();
  await expect(page.locator('#plans-section')).toBeVisible();
  return fixture;
}

function track(page, path) {
  const requests = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === path && request.method() !== 'GET') requests.push(request);
  });
  return requests;
}

async function expectNoHorizontalOverflow(page) {
  const layout = await page.evaluate(() => ({
    viewport: window.innerWidth,
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
  }));
  expect(layout.document, `document overflowed at ${layout.viewport}px`).toBeLessThanOrEqual(layout.viewport);
  expect(layout.body, `body overflowed at ${layout.viewport}px`).toBeLessThanOrEqual(layout.viewport);
}

async function expectInsideViewport(locator, width) {
  const bounds = await locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { left: rect.left, right: rect.right };
  });
  expect(bounds.left).toBeGreaterThanOrEqual(0);
  expect(bounds.right).toBeLessThanOrEqual(width + 1);
}

function contrastRatio(foreground, background) {
  const luminance = (color) => {
    const channels = color.match(/[\d.]+/g).slice(0, 3).map((value) => {
      const channel = Number(value) / 255;
      return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    });
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  };
  const values = [luminance(foreground), luminance(background)].sort((left, right) => right - left);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

test('MAX UI provider and library Button, Input, and Switch components are rendered', async ({ page }) => {
  await start(page);

  const maxUiRoot = page.locator('#root [class*="MaxUI_"]');
  expect(await maxUiRoot.count()).toBeGreaterThan(0);
  await expect(page.locator('#root .app-shell')).toBeAttached();

  const buttons = page.locator('#root [class*="Button_"]');
  const switches = page.locator('#reminders-control [class*="Switch_"]');
  expect(await buttons.count()).toBeGreaterThan(0);
  expect(await switches.count()).toBeGreaterThan(0);

  await page.locator('#btn-edit-profile').click();
  await expect(page.locator('#f-balance')).toBeVisible();
  const inputs = page.locator('#profile-form [class*="Input_"]');
  expect(await inputs.count()).toBeGreaterThan(0);
});

test('dark mode updates computed app colors and keeps purchase dialog surfaces dark', async ({ page }) => {
  await start(page);
  await page.emulateMedia({ colorScheme: 'light' });

  const palette = () => page.evaluate(() => {
    const card = document.querySelector('#profile-card');
    const shell = document.querySelector('.app-shell');
    return {
      background: getComputedStyle(shell).backgroundColor,
      color: getComputedStyle(shell).color,
      cardBackground: getComputedStyle(card).backgroundColor,
    };
  });
  await expect(page.locator('.app-shell')).toHaveClass(/MaxUI_colorScheme_light/);
  const light = await palette();

  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('.app-shell')).toHaveClass(/MaxUI_colorScheme_dark/);
  const dark = await palette();
  expect(dark.background).not.toBe(light.background);
  expect(dark.color).not.toBe(light.color);
  expect(dark.cardBackground).not.toBe(light.cardBackground);

  await page.locator('.plan-view:visible .btn-bought').first().click();
  await expect(page.locator('#purchase-dialog')).toBeVisible();
  const dialogSurfaces = await page.evaluate(() => [
    getComputedStyle(document.querySelector('#purchase-dialog')).backgroundColor,
    getComputedStyle(document.querySelector('#purchase-price')).backgroundColor,
  ]);
  const hasLightSurface = (color) => {
    const channels = color.match(/[\d.]+/g)?.map(Number) || [];
    if (channels.length < 3 || (channels.length > 3 && channels[3] < 0.5)) return false;
    const [red, green, blue] = channels;
    const linear = (channel) => {
      const normalized = channel / 255;
      return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
    };
    const luminance = 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue);
    return luminance >= 0.82;
  };
  for (const surface of dialogSurfaces) expect(hasLightSurface(surface), `${surface} is a light dialog surface`).toBe(false);

  await page.locator('#purchase-cancel').click();
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('.app-shell')).toHaveClass(/MaxUI_colorScheme_light/);
  expect(await palette()).toEqual(light);
});

test('320px viewport keeps the form, availability, source warnings, event cards, and purchase dialog in bounds', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 760 });
  await start(page, false);
  await expect(page.locator('#profile-form')).toBeVisible();
  await expect(page.locator('.avail-row')).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await expectInsideViewport(page.locator('#profile-form'), 320);
  await expectInsideViewport(page.locator('.avail-row'), 320);

  const response = await page.request.put('/api/profile', { data: profile() });
  expect(response.ok()).toBeTruthy();
  await page.reload();
  await expect(page.locator('#plans-section')).toBeVisible();
  await expect(page.locator('#banner-stale')).toBeVisible();
  await expect(page.locator('#banner-stale')).toContainText('устарели');
  await expect(page.locator('#source-line')).toBeVisible();
  await expect(page.locator('#source-line')).toContainText('устарели');
  await expect(page.locator('.plan-view:visible .event-card').first()).toBeVisible();
  await expect(page.locator('.plan-view:visible .event-card').first().locator('.event-card__freshness')).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await expectInsideViewport(page.locator('.plan-view:visible .event-card').first(), 320);

  await page.locator('.plan-view:visible .btn-bought').first().click();
  await expect(page.locator('#purchase-dialog')).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await expectInsideViewport(page.locator('#purchase-dialog'), 320);
});

test('mode tabs support arrows, Home, End, and ARIA without selecting a reminder plan', async ({ page }) => {
  await start(page);
  await showReminderCapability(page);
  const selectedPlanRequests = track(page, '/api/selected-plan');
  const tablist = page.getByRole('tablist', { name: 'Варианты плана' });
  const interest = page.getByRole('tab', { name: 'По интересам' });
  const more = page.getByRole('tab', { name: 'Больше впечатлений' });
  const spend = page.getByRole('tab', { name: 'Почти без остатка' });

  await expect(tablist).toBeVisible();
  await expect(interest).toHaveAttribute('aria-selected', 'true');
  await expect(interest).toHaveAttribute('tabindex', '0');
  await expect(page.locator('#plan-view-interest')).toHaveAttribute('aria-labelledby', 'tab-interest');

  await interest.focus();
  await page.keyboard.press('ArrowRight');
  await expect(more).toBeFocused();
  await expect(more).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#plan-view-more')).toBeVisible();
  await page.keyboard.press('ArrowRight');
  await expect(spend).toBeFocused();
  await expect(spend).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowRight');
  await expect(interest).toBeFocused();
  await expect(interest).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('End');
  await expect(spend).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(more).toBeFocused();
  await page.keyboard.press('Home');
  await expect(interest).toBeFocused();
  await expect(interest).toHaveAttribute('tabindex', '0');
  await expect(more).toHaveAttribute('tabindex', '-1');

  expect(selectedPlanRequests).toHaveLength(0);
});

test('changed reminder selection requires its explicit confirmation button', async ({ page }) => {
  await start(page);
  const fixture = await showReminderCapability(page, {
    selectedPlan: { mode: 'interest', needsConfirmation: true },
  });
  const selectedPlanRequests = track(page, '/api/selected-plan');
  await page.route('**/api/selected-plan', (route) => route.fulfill({
    json: { ...fixture, selectedPlan: { mode: 'interest', needsConfirmation: false } },
  }));

  await expect(page.locator('#plan-view-interest [role="status"]')).toContainText('подтвердите новый состав');
  await expect(page.locator('#plan-view-interest .js-select-plan')).toHaveText('Подтвердить новый состав');
  await page.locator('#tab-more').click();
  await page.locator('#tab-interest').click();
  expect(selectedPlanRequests).toHaveLength(0);
  await expect(page.locator('#plan-view-interest .js-select-plan')).toHaveText('Подтвердить новый состав');

  await page.locator('#plan-view-interest .js-select-plan').click();
  await expect.poll(() => selectedPlanRequests.length).toBe(1);
  expect(selectedPlanRequests[0].postDataJSON()).toEqual({ mode: 'interest' });
  await expect(page.locator('#plan-view-interest .js-select-plan')).toContainText('Выбран для напоминаний');
});

test('MAX Bridge openLink and shareMaxContent use local fixtures instead of opening external sites', async ({ page }) => {
  await page.addInitScript(() => {
    window.__maxBridgeCalls = [];
    window.WebApp = {
      initData: '',
      ready() { window.__maxBridgeCalls.push({ method: 'ready' }); },
      openLink(url) { window.__maxBridgeCalls.push({ method: 'openLink', url }); },
      async shareMaxContent(payload) { window.__maxBridgeCalls.push({ method: 'shareMaxContent', payload }); },
    };
  });
  await start(page);
  const state = await stateOf(page);
  const sourceUrl = state.plans.interest.items[0].sourceUrl;
  let popups = 0;
  page.on('popup', () => { popups += 1; });
  let externalRequests = 0;
  await page.route('https://www.culture.ru/**', (route) => {
    externalRequests += 1;
    return route.abort();
  });

  await page.locator('.plan-view:visible .btn-buy').first().click();
  await expect.poll(() => page.evaluate(() => window.__maxBridgeCalls.some((call) => call.method === 'openLink'))).toBe(true);
  await page.locator('#btn-share').click();
  await expect.poll(() => page.evaluate(() => window.__maxBridgeCalls.some((call) => call.method === 'shareMaxContent'))).toBe(true);

  const calls = await page.evaluate(() => window.__maxBridgeCalls);
  expect(calls.find((call) => call.method === 'openLink').url).toBe(sourceUrl);
  const share = calls.find((call) => call.method === 'shareMaxContent');
  expect(share.payload.text).toContain('План «По интересам»');
  expect(popups).toBe(0);
  expect(externalRequests).toBe(0);
});

test('rejected clipboard write and fallback do not claim a successful share', async ({ page }) => {
  await start(page);
  await page.evaluate(() => {
    window.__clipboardAttempts = { write: 0, fallback: 0 };
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async () => {
          window.__clipboardAttempts.write += 1;
          throw new Error('clipboard denied by fixture');
        },
      },
    });
    document.execCommand = () => {
      window.__clipboardAttempts.fallback += 1;
      throw new Error('legacy copy denied by fixture');
    };
  });

  await page.locator('#btn-share').click();
  await expect(page.locator('#toast')).toContainText('Не удалось скопировать');
  expect(await page.evaluate(() => window.__clipboardAttempts)).toEqual({ write: 1, fallback: 1 });
  await expect(page.locator('.clipboard-copy')).toHaveCount(0);
  await expect(page.locator('#toast')).not.toContainText('скопирован в буфер');
});

test('form saves exclusions, weights, and a concrete free date; canceling edits preserves the saved profile', async ({ page }) => {
  await start(page, false);
  const dates = await page.evaluate(() => {
    const format = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    const offset = (days) => {
      const date = new Date();
      date.setHours(12, 0, 0, 0);
      date.setDate(date.getDate() + days);
      return format(date);
    };
    return { available: offset(10), edited: offset(12), deadline: offset(45) };
  });

  await page.locator('#f-balance').fill('3200');
  await page.locator('#f-age').fill('18');
  await page.locator('#f-max-events').fill('3');
  await page.locator('#f-deadline').fill(dates.deadline);
  const availability = page.locator('.avail-row').first();
  await availability.locator('input[type="radio"][value="date"]').check();
  await availability.locator('.avail-date').fill(dates.available);
  await availability.locator('.avail-start').fill('17:30');
  await availability.locator('.avail-end').fill('20:30');
  await page.locator('.weight-row[data-category="Концерты"] [data-v="2"]').click();
  await page.locator('.chip input[value="Кино"]').check();
  await page.locator('#profile-form button[type="submit"]').click();
  await expect(page.locator('#profile-form')).not.toBeVisible();

  const saved = await stateOf(page);
  expect(saved.profile.excludedCategories).toContain('Кино');
  expect(saved.profile.categoryWeights['Концерты']).toBe(2);
  expect(saved.profile.availability).toEqual([{ date: dates.available, start: '17:30', end: '20:30' }]);
  expect(saved.profile.maxEvents).toBe(3);

  await page.locator('#btn-edit-profile').click();
  await page.locator('#f-balance').fill('2999');
  await page.locator('.weight-row[data-category="Концерты"] [data-v="4"]').click();
  await page.locator('.chip input[value="Кино"]').uncheck();
  await page.locator('.avail-row').first().locator('.avail-date').fill(dates.edited);
  await page.locator('#btn-cancel-profile').click();
  await expect(page.locator('#profile-form')).not.toBeVisible();

  const afterCancel = await stateOf(page);
  expect(afterCancel.profile).toEqual(saved.profile);
  await expect(page.locator('#profile-summary')).toContainText('3 200');
});

test('location controls are absent while valid saved distance, coordinates, and travel buffer survive editing', async ({ page }) => {
  await start(page, false);
  const original = profile({
    travelBufferMinutes: 45,
    maxDistanceKm: 12.5,
    latitude: 55.7558,
    longitude: 37.6173,
  });
  const response = await page.request.put('/api/profile', { data: original });
  expect(response.ok()).toBeTruthy();
  await page.reload();
  await expect(page.locator('#profile-card')).toBeVisible();
  await expect(page.locator('#profile-summary')).not.toContainText('Радиус');

  await page.locator('#btn-edit-profile').click();
  await expect(page.locator('#f-locale')).toBeVisible();
  await expect(page.locator('#profile-form')).not.toContainText(/Запас на дорогу|Радиус|Широта|Долгота|расстояния/);
  for (const id of ['#f-buffer', '#f-distance', '#f-lat', '#f-lng']) {
    await expect(page.locator(id)).toHaveCount(0);
  }
  await expect(page.locator('#profile-form .form-advanced')).toHaveCount(0);

  await page.locator('#f-balance').fill('3100');
  await page.locator('#profile-form button[type="submit"]').click();
  await expect(page.locator('#profile-form')).not.toBeVisible();
  const saved = await stateOf(page);
  expect(saved.profile.maxBalance).toBe(3100);
  expect(saved.profile.travelBufferMinutes).toBe(45);
  expect(saved.profile.maxDistanceKm).toBe(12.5);
  expect(saved.profile.latitude).toBe(55.7558);
  expect(saved.profile.longitude).toBe(37.6173);
  await expect(page.locator('#profile-summary')).not.toContainText('Радиус');
});

test('active tabs, weights, availability radios, and exclusions meet 4.5:1 contrast in both schemes', async ({ page }) => {
  await start(page);
  await page.locator('#btn-edit-profile').click();
  await page.locator('.avail-row').first().locator('input[type="radio"][value="date"]').check();
  await page.locator('.chip input[value="Кино"]').check();

  const activeStates = [
    ['.tabs button[aria-selected="true"]', 'selected plan tab'],
    ['.weight-row[data-category="Спектакли"] .weight-opt.is-active', 'selected interest weight'],
    ['.pill-radio input[type="radio"][value="date"]:checked + span', 'selected availability kind'],
    ['.chip input[value="Кино"]:checked + span', 'selected excluded category'],
  ];
  for (const scheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: scheme });
    await expect(page.locator('.app-shell')).toHaveClass(new RegExp(`MaxUI_colorScheme_${scheme}`));
    for (const [selector, label] of activeStates) {
      const contrast = await page.locator(selector).evaluate((element) => ({
        foreground: getComputedStyle(element).color,
        background: getComputedStyle(element).backgroundColor,
      }));
      expect(
        contrastRatio(contrast.foreground, contrast.background),
        `${label} in ${scheme} mode: ${contrast.foreground} on ${contrast.background}`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  }
});
