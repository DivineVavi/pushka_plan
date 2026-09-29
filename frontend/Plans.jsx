import React from 'react';
import {
  Button,
  CellHeader,
  Switch,
  Typography,
} from '@maxhub/max-ui';

const MODES = ['interest', 'more', 'spend'];

const MODE_NAMES = {
  interest: 'По интересам',
  more: 'Больше впечатлений',
  spend: 'Почти без остатка',
};

const MODE_DESCRIPTIONS = {
  interest: 'Максимум релевантных событий по вашим интересам.',
  more: 'Как можно больше впечатлений в рамках бюджета и времени.',
  spend: 'Потратить баланс почти без остатка, не жертвуя интересами.',
};

const PUBLIC_SOURCE_KINDS = ['culture-public', 'culture-public-prepared'];
const PRICE_FORMATTER = new Intl.NumberFormat('ru-RU');
const COUNT_FORMATTER = new Intl.NumberFormat('ru-RU');

function formatPrice(value) {
  return typeof value === 'number' && Number.isFinite(value)
    ? `${PRICE_FORMATTER.format(Math.round(value))} ₽`
    : '—';
}

function formatInTimeZone(value, options, timeZone) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';

  try {
    return new Intl.DateTimeFormat('ru-RU', {
      ...options,
      timeZone: timeZone || 'Europe/Moscow',
    }).format(date);
  } catch {
    try {
      return new Intl.DateTimeFormat('ru-RU', options).format(date);
    } catch {
      return '';
    }
  }
}

function dateParts(value, timeZone) {
  const day = formatInTimeZone(value, { day: 'numeric' }, timeZone) || '?';
  const month = formatInTimeZone(value, { month: 'short' }, timeZone).replace(/\.$/, '');
  return { day, month };
}

function isPublicSource(data) {
  return PUBLIC_SOURCE_KINDS.includes(data?.source?.kind);
}

function isPublicAfishaItem(data, item) {
  return isPublicSource(data)
    || item?.source === 'culture-public'
    || item?.source === 'culture-public-prepared';
}

function isDemo(data, item) {
  return Boolean(
    data?.demo
      || data?.source?.kind === 'simulated'
      || item?.source === 'fixture',
  );
}

function planLink(data, item) {
  if (isPublicAfishaItem(data, item)) return item?.sourceUrl || null;
  return item?.saleLink || null;
}

function displayText(value) {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}

function venueText(venue) {
  if (venue && typeof venue === 'object') {
    return [displayText(venue.name), displayText(venue.address)].filter(Boolean).join(' · ');
  }
  return displayText(venue);
}

function purchaseFor(data, item) {
  const sessionId = item?.sessionId || item?.id;
  const purchases = Array.isArray(data?.purchased) ? data.purchased : [];
  const found = purchases.find((purchase) => (
    purchase.sessionId === sessionId || purchase.id === sessionId
  ));
  if (found) return found;
  return item?.purchased ? {} : null;
}

function displayPrice(item, purchase) {
  if (purchase) {
    return formatPrice(purchase.actualPrice != null ? purchase.actualPrice : item.price);
  }
  const price = formatPrice(item.price);
  if (price === '—') return 'цена неизвестна';
  return item.exactPriceKnown ? price : `от ${price}`;
}

function displayPriceBasis(item, purchase) {
  if (purchase) {
    return purchase.actualPrice != null ? 'фактическая цена' : 'куплено';
  }
  return item.exactPriceKnown ? 'точная цена' : 'минимальная цена';
}

function PlanStat({ label, value, className = '' }) {
  return (
    <div className={`stat ${className}`.trim()}>
      <span className="stat__value">{value}</span>
      <span className="stat__label">{label}</span>
    </div>
  );
}

function PlanExclusions({ excludedBy }) {
  const reasons = Object.entries(excludedBy || {})
    .filter(([, count]) => Number.isInteger(count) && count > 0)
    .sort((left, right) => right[1] - left[1])
    .slice(0, 3);

  if (!reasons.length) return null;

  return (
    <div className="plan-exclusions">
      <p>Основные ограничения, отсеявшие сеансы:</p>
      <ul>
        {reasons.map(([label, count]) => (
          <li key={label}>{label} — {COUNT_FORMATTER.format(count)}</li>
        ))}
      </ul>
      <p>Для каждого сеанса учтена первая причина исключения.</p>
    </div>
  );
}

function emptyMessage(data) {
  const diagnostics = data?.diagnostics;
  if (diagnostics?.sourceSessions === 0) {
    const source = data?.source;
    if (source?.kind === 'unavailable' || source?.error) {
      return 'Каталог событий ещё не загружен или источник недоступен. Профиль сохранён — попробуйте позже.';
    }
    return 'На выбранные город и даты пока нет подходящих сеансов. Попробуйте изменить срок или город.';
  }
  return (typeof diagnostics?.message === 'string' && diagnostics.message)
    || 'Попробуйте расширить свободные даты, увеличить остаток, ослабить фильтры по категориям или снять ограничение по расстоянию.';
}

function PlanEmpty({ data, message, excludedBy, onEdit, busy }) {
  return (
    <div className="plan-empty">
      <div className="plan-empty__icon" aria-hidden="true">🔍</div>
      <h3>Подходящих событий не нашлось</h3>
      <p>{message || emptyMessage(data)}</p>
      <PlanExclusions excludedBy={excludedBy ?? data?.diagnostics?.excludedBy} />
      <Button
        type="button"
        variant="primary"
        size="small"
        className="btn btn--primary btn--sm js-edit-profile"
        onClick={onEdit}
        disabled={busy || typeof onEdit !== 'function'}
      >
        Настроить профиль
      </Button>
    </div>
  );
}

function CardFreshness({ data, item }) {
  if (isDemo(data, item)) {
    return <div className="event-card__freshness">Учебное событие · не для покупки</div>;
  }

  const timestamp = item.fetchedAt || data?.source?.fetchedAt;
  const formatted = formatInTimeZone(timestamp, {
    weekday: 'short',
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
  });
  const publicAfisha = isPublicAfishaItem(data, item);
  const parts = [
    formatted ? `Данные обновлены ${formatted}` : 'Свежесть карточки не указана',
    data?.source?.stale ? 'снимок источника устарел' : '',
    publicAfisha
      ? 'Предварительный план: проверьте время сеанса, возможность покупки и итоговую цену на странице события'
      : '',
  ].filter(Boolean);

  return <div className="event-card__freshness">{parts.join(' · ')}</div>;
}

function EventCard({ data, item, index, busy, onBuy, onOpenLink }) {
  const purchase = purchaseFor(data, item);
  const publicAfisha = isPublicAfishaItem(data, item);
  const demo = isDemo(data, item);
  const sourceLink = planLink(data, item);
  const linkAvailable = typeof sourceLink === 'string' && sourceLink.trim().length > 0;
  const startsAt = item.startsAt;
  const parts = dateParts(startsAt, item.timezone);
  const venue = venueText(item.venue);
  const sessionId = item.sessionId || item.id || '';
  const itemId = item.id ?? '';
  const reasons = Array.isArray(item.reasons)
    ? item.reasons.filter((reason) => typeof reason === 'string' && reason.trim())
    : [];
  const canOpenLink = !demo && linkAvailable && typeof onOpenLink === 'function';
  const canMarkBought = typeof onBuy === 'function';

  return (
    <article
      className={`event-card${purchase ? ' is-purchased' : ''}`}
      data-item-id={itemId}
      data-session-id={sessionId}
    >
      <div className="event-card__top">
        <div className="event-date" aria-hidden="true">
          <span className="event-date__day">{parts.day}</span>
          <span className="event-date__mon">{parts.month}</span>
        </div>
        <div className="event-card__head">
          <h3 className="event-card__title">
            <span className="event-index">{index + 1}</span>
            {displayText(item.title) || 'Событие без названия'}
          </h3>
          <div className="event-card__meta">
            {displayText(item.category) ? <span className="tag">{displayText(item.category)}</span> : null}
            {Number.isInteger(item.ageRestriction) && item.ageRestriction >= 0 ? (
              <span className="tag" aria-label="Возрастная маркировка события">
                {item.ageRestriction}+
              </span>
            ) : null}
            {startsAt ? (
              <span className="meta-item">
                {formatInTimeZone(startsAt, { hour: '2-digit', minute: '2-digit' }, item.timezone)}
              </span>
            ) : null}
            {item.endsAt ? (
              <span className="meta-item">
                {item.endEstimated ? 'окончание примерно ' : 'до '}
                {formatInTimeZone(item.endsAt, { hour: '2-digit', minute: '2-digit' }, item.timezone)}
              </span>
            ) : null}
          </div>
          {venue ? <div className="event-card__venue">📍 {venue}</div> : null}
        </div>
        <div className="event-card__price">
          <span className="price-val">{displayPrice(item, purchase)}</span>
          <span className="price-basis">{displayPriceBasis(item, purchase)}</span>
        </div>
      </div>

      {reasons.length ? (
        <div className="event-card__reasons">
          <span className="reasons-title">Почему в плане</span>
          <ul>
            {reasons.map((reason, reasonIndex) => <li key={`${reasonIndex}-${reason}`}>{reason}</li>)}
          </ul>
        </div>
      ) : null}

      <CardFreshness data={data} item={item} />

      <div className="event-card__foot">
        <div className="event-card__actions">
          {purchase ? (
            <span className="bought-badge">
              ✓ Куплено{purchase.actualPrice != null ? ` · ${formatPrice(purchase.actualPrice)}` : ''}
            </span>
          ) : (
            <>
              <Button
                type="button"
                variant="primary"
                size="small"
                className="btn btn--primary btn--sm btn-buy"
                innerClassNames={{ content: 'action-button__content' }}
                disabled={busy || !canOpenLink}
                title={demo
                  ? 'Учебные события не предназначены для покупки'
                  : linkAvailable
                    ? 'Сверьте сеанс, цену и наличие самостоятельно; билеты не гарантированы'
                    : 'Страница для проверки недоступна'}
                onClick={() => {
                  if (canOpenLink && !busy) onOpenLink(item);
                }}
              >
                {demo
                  ? 'Билеты недоступны в учебном сценарии'
                  : linkAvailable
                    ? publicAfisha
                      ? 'Проверить расписание и билеты на Культура.РФ'
                      : 'Проверить билеты у продавца'
                    : 'Ссылка для проверки недоступна'}
              </Button>
              <Button
                type="button"
                variant="secondary"
                size="small"
                className="btn btn--outline btn--sm btn-bought"
                disabled={busy || !canMarkBought}
                onClick={() => {
                  if (canMarkBought && !busy) onBuy(item);
                }}
              >
                {demo ? 'Симулировать покупку' : 'Купил'}
              </Button>
            </>
          )}
        </div>
      </div>
    </article>
  );
}

function PlanView({
  data,
  plan,
  planMode,
  busy,
  onEdit,
  onBuy,
  onOpenLink,
  onSelectPlan,
}) {
  if (!plan) {
    return (
      <div className="plan-empty">
        <div className="plan-empty__icon" aria-hidden="true">📭</div>
        <h3>{MODE_NAMES[planMode]} — недоступен</h3>
        <p>Этот вариант не был рассчитан сервером.</p>
      </div>
    );
  }

  const items = Array.isArray(plan.items) ? plan.items : [];
  const publicSource = isPublicSource(data) || items.some((item) => isPublicAfishaItem(data, item));
  const demoPlan = isDemo(data) || items.some((item) => isDemo(data, item));
  const purchasedCount = Array.isArray(data.purchased) ? data.purchased.length : 0;
  const isSelected = data.selectedPlan?.mode === planMode && !data.selectedPlan?.needsConfirmation;
  const requiresConfirmation = data.selectedPlan?.mode === planMode && data.selectedPlan?.needsConfirmation;
  const canSelect = data.remindersAvailable
    && items.some((item) => !purchaseFor(data, item));

  const totalLabel = publicSource
    ? 'плановая сумма от'
    : demoPlan
      ? 'учебная сумма'
      : purchasedCount
        ? 'новые билеты'
        : 'итого';
  const leftoverLabel = publicSource
    ? 'расчётный остаток до'
    : demoPlan
      ? 'учебный остаток'
      : 'остаток';

  return (
    <>
      <CellHeader className="plan-head" titleStyle="normal">
        <h2 className="plan-head__title">
          <Typography.Title variant="medium-strong">{MODE_NAMES[planMode]}</Typography.Title>
        </h2>
        <p className="plan-head__desc">
          <Typography.Body variant="small">{MODE_DESCRIPTIONS[planMode]}</Typography.Body>
        </p>
      </CellHeader>

      <div className="plan-stats">
        <PlanStat label="события" value={String(items.length)} />
        <PlanStat label={totalLabel} value={formatPrice(plan.total)} />
        <PlanStat label={leftoverLabel} value={formatPrice(plan.leftover)} className="stat--green" />
      </div>

      {!items.length ? (
        <PlanEmpty data={data} excludedBy={data.diagnostics?.excludedBy} onEdit={onEdit} busy={busy} />
      ) : (
        <>
          {canSelect ? (
            <div className="plan-selection">
              <Button
                type="button"
                variant="secondary"
                size="small"
                className="btn btn--outline btn--sm js-select-plan"
                data-mode={planMode}
                disabled={busy || typeof onSelectPlan !== 'function'}
                onClick={() => {
                  if (!busy && typeof onSelectPlan === 'function') onSelectPlan(planMode);
                }}
              >
                {requiresConfirmation
                  ? 'Подтвердить новый состав'
                  : isSelected
                    ? '✓ Выбран для напоминаний'
                    : 'Напоминать об этом плане'}
              </Button>
              {requiresConfirmation ? (
                <span role="status">План изменился — подтвердите новый состав</span>
              ) : null}
            </div>
          ) : null}
          <div className="plan-items">
            {items.map((item, index) => (
              <EventCard
                key={item.sessionId || item.id || index}
                data={data}
                item={item}
                index={index}
                busy={busy}
                onBuy={onBuy}
                onOpenLink={onOpenLink}
              />
            ))}
          </div>
        </>
      )}
    </>
  );
}

export default function Plans({
  data,
  mode,
  onModeChange,
  busy,
  onEdit,
  onBuy,
  onOpenLink,
  onSelectPlan,
  onReminders,
  onShare,
}) {
  const state = data && typeof data === 'object' ? data : {};
  const plans = state.plans || {};
  const available = MODES.some((planMode) => Boolean(plans[planMode]));
  const activeMode = MODES.includes(mode) ? mode : 'interest';
  const remindersAvailable = Boolean(state.remindersAvailable);
  const remainingBalance = state.remainingBalance;
  const isBusy = Boolean(busy);

  return (
    <section className="plans" id="plans-section" hidden={!available}>
      <div className="card card--tabs">
        <div className="tabs" role="tablist" id="tabs" aria-label="Варианты плана">
          {MODES.map((planMode) => (
            <Button
              key={planMode}
              type="button"
              role="tab"
              id={`tab-${planMode}`}
              data-plan={planMode}
              aria-selected={activeMode === planMode ? 'true' : 'false'}
              aria-controls={`plan-view-${planMode}`}
              className={activeMode === planMode ? 'is-active' : ''}
              tabIndex={activeMode === planMode ? 0 : -1}
              variant={activeMode === planMode ? 'secondary' : 'ghost'}
              size="small"
              innerClassNames={{ content: 'action-button__content' }}
              disabled={isBusy}
              onClick={() => {
                if (!isBusy && typeof onModeChange === 'function') onModeChange(planMode);
              }}
              onKeyDown={(event) => {
                let nextIndex = null;
                const currentIndex = MODES.indexOf(planMode);
                if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % MODES.length;
                if (event.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + MODES.length) % MODES.length;
                if (event.key === 'Home') nextIndex = 0;
                if (event.key === 'End') nextIndex = MODES.length - 1;
                if (nextIndex != null) {
                  event.preventDefault();
                  const nextMode = MODES[nextIndex];
                  document.getElementById(`tab-${nextMode}`)?.focus();
                  if (!isBusy && typeof onModeChange === 'function') onModeChange(nextMode);
                }
              }}
            >
              {MODE_NAMES[planMode]}
            </Button>
          ))}
        </div>
      </div>

      <div className="card plans__toolbar">
        <div className="reminders-control">
          <label
            className={`switch${remindersAvailable ? '' : ' is-unavailable'}`}
            id="reminders-control"
          >
            <Switch
              type="checkbox"
              id="reminders-toggle"
              aria-describedby="reminders-hint"
              checked={Boolean(state.remindersEnabled)}
              disabled={!remindersAvailable || isBusy}
              onChange={(event) => {
                if (!isBusy && remindersAvailable && typeof onReminders === 'function') {
                  onReminders(event.currentTarget.checked);
                }
              }}
            />
            <span className="switch__label">Напоминания о покупке и визите</span>
          </label>
          <p className="form-hint" id="reminders-hint" hidden={remindersAvailable}>
            Бот MAX не подключён: напоминания не отправляются. В браузерной песочнице эта функция недоступна.{' '}
            <a
              href="https://max.ru/t99_hakaton_max_bot"
              target="_blank"
              rel="noopener noreferrer"
            >
              Открыть бота в MAX
            </a>.
          </p>
        </div>
        <div className="plans__toolbar-right">
          <span
            className="balance-chip"
            id="balance-chip"
            hidden={remainingBalance == null}
            title="Остаток введён вручную — это не банковский баланс"
          >
            {remainingBalance == null ? '' : `Учтённый остаток: ${formatPrice(remainingBalance)}`}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="small"
            className="btn btn--ghost btn--sm"
            id="btn-share"
            disabled={isBusy || typeof onShare !== 'function'}
            onClick={() => {
              if (!isBusy && typeof onShare === 'function') onShare();
            }}
          >
            Поделиться
          </Button>
        </div>
      </div>

      <div id="plan-views">
      {available && MODES.map((planMode) => (
        <section
          key={planMode}
          className="card plan-view"
          id={`plan-view-${planMode}`}
          data-plan={planMode}
          role="tabpanel"
          aria-labelledby={`tab-${planMode}`}
          hidden={planMode !== activeMode}
        >
          <PlanView
            data={state}
            plan={plans[planMode]}
            planMode={planMode}
            busy={isBusy}
            onEdit={onEdit}
            onBuy={onBuy}
            onOpenLink={onOpenLink}
            onSelectPlan={onSelectPlan}
          />
        </section>
      ))}
      </div>

      <p className="plans__note">
        План предварительный: опубликованные даты и цены «от» не гарантируют билет и итоговую стоимость.
        Для событий Культура.РФ сначала проверьте расписание, возможность оплаты картой и билеты на странице источника.
        Баланс введён вручную и не является банковским балансом; покупку подтверждаете только вы.
      </p>
    </section>
  );
}
