import { Fragment, useId, useRef, useState } from 'react';
import { Button, Input } from '@maxhub/max-ui';

const WEEKDAYS = [
  'Понедельник',
  'Вторник',
  'Среда',
  'Четверг',
  'Пятница',
  'Суббота',
  'Воскресенье',
];

function localDateString(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function dateLimits() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const latest = new Date(today);
  latest.setDate(latest.getDate() + 90);
  return { today: localDateString(today), latest: localDateString(latest) };
}

function defaultDeadline() {
  const deadline = new Date();
  deadline.setHours(0, 0, 0, 0);
  deadline.setDate(deadline.getDate() + 30);
  return localDateString(deadline);
}

function inputValue(value) {
  return value == null ? '' : String(value);
}

function isWeight(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 1 && number <= 5;
}

function savedNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }
  return null;
}

// These settings have no web controls; keep valid stored values when the visible profile is edited.
function preservedProfileFields(profile) {
  const savedBuffer = savedNumber(profile?.travelBufferMinutes);
  const savedDistance = savedNumber(profile?.maxDistanceKm);
  const savedLatitude = savedNumber(profile?.latitude);
  const savedLongitude = savedNumber(profile?.longitude);
  const hasValidLocation = savedDistance !== null && savedDistance > 0 && savedDistance <= 500
    && savedLatitude !== null && savedLatitude >= -90 && savedLatitude <= 90
    && savedLongitude !== null && savedLongitude >= -180 && savedLongitude <= 180;

  return {
    travelBufferMinutes: Number.isInteger(savedBuffer) && savedBuffer >= 0 && savedBuffer <= 240
      ? savedBuffer
      : 30,
    ...(hasValidLocation ? {
      maxDistanceKm: savedDistance,
      latitude: savedLatitude,
      longitude: savedLongitude,
    } : {}),
  };
}

function makeInitialForm(data, nextRowId) {
  const profile = data?.profile || {};
  const locales = Array.isArray(data?.locales) ? data.locales : [];
  const categories = Array.isArray(data?.categories) ? data.categories : [];
  const hasLocaleOptions = locales.length > 0;
  const savedLocale = inputValue(profile.localeId);
  const localeId = hasLocaleOptions
    ? (locales.includes(savedLocale) ? savedLocale : inputValue(locales[0]))
    : savedLocale;
  const savedAvailability = Array.isArray(profile.availability) && profile.availability.length
    ? profile.availability
    : [{ weekday: 6, start: '10:00', end: '22:00' }];

  return {
    balance: inputValue(profile.maxBalance),
    localeId,
    localeText: savedLocale,
    deadline: inputValue(profile.planningDeadline).slice(0, 10) || defaultDeadline(),
    age: inputValue(profile.age),
    maxEvents: profile.maxEvents == null ? '3' : inputValue(profile.maxEvents),
    availability: savedAvailability.map((rule) => ({
      id: nextRowId(),
      kind: rule?.date ? 'date' : 'weekday',
      weekday: Number.isInteger(Number(rule?.weekday)) && Number(rule.weekday) >= 0 && Number(rule.weekday) <= 6
        ? String(Number(rule.weekday))
        : '6',
      date: inputValue(rule?.date).slice(0, 10),
      start: inputValue(rule?.start) || '10:00',
      end: inputValue(rule?.end) || '22:00',
    })),
    categoryWeights: Object.fromEntries(categories.map((category) => [
      category,
      isWeight(profile.categoryWeights?.[category]) ? Number(profile.categoryWeights[category]) : 3,
    ])),
    excludedCategories: Array.isArray(profile.excludedCategories) ? profile.excludedCategories : [],
  };
}

function inputErrorProps(error, field, rowId) {
  const matches = error?.field === field && (rowId == null || error.rowId === rowId);
  return {
    'aria-invalid': matches ? 'true' : undefined,
    'aria-describedby': matches ? 'profile-error' : undefined,
  };
}

function validationError(message, field, rowId) {
  const error = new Error(message);
  error.field = field;
  error.rowId = rowId;
  return error;
}

function readNumber(rawValue, label, min, max, { integer = true, optional = false, field } = {}) {
  const raw = rawValue.trim();
  if (optional && raw === '') return null;
  const number = Number(raw);
  const whole = Number.isInteger(number) && /^\d+(?:\.0+)?$/.test(raw);
  if (
    raw === '' ||
    !Number.isFinite(number) ||
    (integer && !whole) ||
    number < min ||
    number > max
  ) {
    const error = new Error(`Введите ${label}: ${integer ? 'целое число' : 'число'} от ${min} до ${max}.`);
    if (field) error.field = field;
    throw error;
  }
  return number;
}

function isIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(year, month - 1, day);
  return parsed.getFullYear() === year && parsed.getMonth() === month - 1 && parsed.getDate() === day;
}

export default function ProfileForm({ data, busy = false, onSave, onCancel }) {
  const idPrefix = useId();
  const rowSequence = useRef(0);
  const [form, setForm] = useState(() => makeInitialForm(data, () => `window-${rowSequence.current++}`));
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const formRef = useRef(null);
  const errorRef = useRef(null);
  const availabilityRef = useRef(null);
  const addWindowRef = useRef(null);
  const rowRefs = useRef(new Map());

  const locales = Array.isArray(data?.locales) ? data.locales : [];
  const categories = Array.isArray(data?.categories) ? data.categories : [];
  const hasLocaleOptions = locales.length > 0;
  const limits = dateLimits();
  const availabilityMax = form.deadline && form.deadline <= limits.latest
    ? form.deadline
    : limits.latest;
  const isBusy = Boolean(busy || saving);
  const inlineErrorFields = ['balance', 'locale', 'deadline', 'age', 'maxEvents', 'availability'];
  const errorIsInline = Boolean(error?.field && (
    inlineErrorFields.includes(error.field) || error.field.startsWith('window-')
  ));

  function renderError(field, rowId) {
    if (field && (error?.field !== field || (rowId != null && error.rowId !== rowId))) return null;
    return (
      <p id="profile-error" ref={errorRef} className="form-error" role="alert" tabIndex={-1} hidden={!error}>
        {error?.message || ''}
      </p>
    );
  }

  function updateForm(update) {
    setError(null);
    setForm((previous) => typeof update === 'function' ? update(previous) : { ...previous, ...update });
  }

  function setField(name, value) {
    updateForm((previous) => ({ ...previous, [name]: value }));
  }

  function setAvailabilityField(rowId, field, value) {
    updateForm((previous) => ({
      ...previous,
      availability: previous.availability.map((row) => row.id === rowId ? { ...row, [field]: value } : row),
    }));
  }

  function resolveErrorTarget(nextError) {
    if (!nextError?.field) return errorRef.current;
    if (nextError.field === 'availability') return availabilityRef.current;
    if (nextError.field === 'add-window') return addWindowRef.current;
    if (nextError.field.startsWith('window-')) {
      const row = rowRefs.current.get(nextError.rowId);
      if (!row) return availabilityRef.current;
      const selector = {
        'window-weekday': '.avail-weekday',
        'window-date': '.avail-date',
        'window-start': '.avail-start',
        'window-end': '.avail-end',
      }[nextError.field];
      return selector ? row.querySelector(selector) : row;
    }
    const ids = {
      balance: 'f-balance',
      locale: hasLocaleOptions ? 'f-locale' : 'f-locale-text',
      deadline: 'f-deadline',
      age: 'f-age',
      maxEvents: 'f-max-events',
    };
    return ids[nextError.field] ? formRef.current?.querySelector(`#${ids[nextError.field]}`) : errorRef.current;
  }

  function showError(nextError) {
    if (nextError?.status === 401) return;
    const message = nextError?.message || 'Не удалось сохранить профиль. Попробуйте ещё раз.';
    const normalized = {
      message,
      field: nextError?.field,
      rowId: nextError?.rowId,
    };
    setError(normalized);
    window.requestAnimationFrame(() => {
      const target = resolveErrorTarget(normalized);
      if (target?.focus) {
        target.focus({ preventScroll: true });
        target.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
      } else if (errorRef.current) {
        errorRef.current.focus({ preventScroll: true });
        errorRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    });
  }

  function collectProfile() {
    const balance = readNumber(form.balance, 'остаток на карте', 0, 5000, { field: 'balance' });
    const deadline = form.deadline;
    if (!isIsoDate(deadline) || deadline < limits.today || deadline > limits.latest) {
      throw validationError('Укажите срок от сегодня до следующих 90 дней.', 'deadline');
    }

    const locale = (hasLocaleOptions ? form.localeId : form.localeText).trim();
    if (!locale || locale.length > 100) {
      throw validationError('Укажите город (не больше 100 символов).', 'locale');
    }

    if (!form.availability.length || form.availability.length > 40) {
      throw validationError('Укажите от 1 до 40 свободных окон.', 'availability');
    }

    const availability = form.availability.map((row) => {
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(row.start) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(row.end) || row.start >= row.end) {
        throw validationError(
          'Укажите время начала и конца окна: конец должен быть позже начала в тот же день.',
          !/^([01]\d|2[0-3]):[0-5]\d$/.test(row.start) ? 'window-start' : 'window-end',
          row.id,
        );
      }
      if (row.kind === 'date') {
        if (!isIsoDate(row.date) || row.date < limits.today || row.date > deadline) {
          throw validationError('Укажите свободную дату от сегодня до срока планирования.', 'window-date', row.id);
        }
        return { date: row.date, start: row.start, end: row.end };
      }
      return { weekday: Number(row.weekday), start: row.start, end: row.end };
    });

    const categoryWeights = Object.fromEntries(categories.map((category) => [
      category,
      isWeight(form.categoryWeights[category]) ? form.categoryWeights[category] : 3,
    ]));
    const excludedCategories = form.excludedCategories.filter((category) => categories.includes(category));

    const profile = {
      maxBalance: balance,
      localeId: locale,
      planningDeadline: deadline,
      availability,
      categoryWeights,
      excludedCategories,
      maxEvents: readNumber(form.maxEvents, 'количество событий', 1, 4, { field: 'maxEvents' }),
      age: readNumber(form.age, 'возраст', 14, 22, { field: 'age' }),
      ...preservedProfileFields(data?.profile),
    };
    return profile;
  }

  async function handleSubmit(event) {
    event.preventDefault();
    if (isBusy) return;
    setError(null);

    let profile;
    try {
      profile = collectProfile();
    } catch (validationFailure) {
      showError(validationFailure);
      return;
    }

    setSaving(true);
    try {
      await onSave(profile);
    } catch (saveFailure) {
      if (saveFailure?.status !== 401) showError(saveFailure);
    } finally {
      setSaving(false);
    }
  }

  function addWindow() {
    if (isBusy || form.availability.length >= 40) return;
    const id = `window-${rowSequence.current++}`;
    updateForm((previous) => ({
      ...previous,
      availability: [...previous.availability, {
        id,
        kind: 'weekday',
        weekday: '6',
        date: '',
        start: '10:00',
        end: '22:00',
      }],
    }));
  }

  function removeWindow(rowId) {
    updateForm((previous) => ({
      ...previous,
      availability: previous.availability.filter((row) => row.id !== rowId),
    }));
  }

  return (
    <form id="profile-form" ref={formRef} className="profile-form" noValidate onSubmit={handleSubmit}>
      <p className="form-intro" id="form-intro">
        Введите вручную остаток на карте, город, срок и свободное время — мы подберём сочетание событий по вашим интересам.
      </p>

      <section aria-label="Основные ограничения">
        <div className="form-grid">
          <div className="field">
            <label className="field__label" htmlFor="f-balance">Остаток на карте, ₽ <em>(вводится вручную)</em></label>
            <Input
              id="f-balance"
              type="number"
              min="0"
              max="5000"
              step="1"
              inputMode="numeric"
              placeholder="Например, 3200"
              required
              disabled={isBusy}
              value={form.balance}
              onChange={(event) => setField('balance', event.target.value)}
              {...inputErrorProps(error, 'balance')}
            />
            {renderError('balance')}
          </div>

          <div className="field">
            <label className="field__label" htmlFor={hasLocaleOptions ? 'f-locale' : 'f-locale-text'}>Город</label>
            <div hidden={!hasLocaleOptions}>
              <select
                id="f-locale"
                hidden={!hasLocaleOptions}
                value={form.localeId}
                disabled={isBusy}
                onChange={(event) => setField('localeId', event.target.value)}
                aria-label="Город"
                {...inputErrorProps(error, 'locale')}
              >
                {locales.map((locale) => <option key={locale} value={locale}>{locale}</option>)}
              </select>
            </div>
            <div hidden={hasLocaleOptions}>
              <Input
                id="f-locale-text"
                hidden={hasLocaleOptions}
                type="text"
                placeholder="Например, Москва"
                maxLength={100}
                disabled={isBusy}
                value={form.localeText}
                onChange={(event) => setField('localeText', event.target.value)}
                {...inputErrorProps(error, 'locale')}
              />
            </div>
            {renderError('locale')}
          </div>

          <div className="field">
            <label className="field__label" htmlFor="f-deadline">Успеть до</label>
            <Input
              id="f-deadline"
              type="date"
              min={limits.today}
              max={limits.latest}
              required
              disabled={isBusy}
              value={form.deadline}
              onChange={(event) => setField('deadline', event.target.value)}
              {...inputErrorProps(error, 'deadline')}
            />
            {renderError('deadline')}
          </div>

          <div className="field">
            <label className="field__label" htmlFor="f-age">Возраст</label>
            <Input
              id="f-age"
              type="number"
              min="14"
              max="22"
              step="1"
              inputMode="numeric"
              placeholder="18"
              required
              disabled={isBusy}
              value={form.age}
              onChange={(event) => setField('age', event.target.value)}
              {...inputErrorProps(error, 'age')}
            />
            {renderError('age')}
          </div>

          <div className="field">
            <label className="field__label" htmlFor="f-max-events">Максимум событий в плане</label>
            <Input
              id="f-max-events"
              type="number"
              min="1"
              max="4"
              step="1"
              inputMode="numeric"
              required
              disabled={isBusy}
              value={form.maxEvents}
              onChange={(event) => setField('maxEvents', event.target.value)}
              {...inputErrorProps(error, 'maxEvents')}
            />
            {renderError('maxEvents')}
          </div>

        </div>
      </section>

      <fieldset className="form-group">
        <legend>Свободное время</legend>
        <p className="form-hint">Добавьте окна, когда вы можете пойти на событие: конкретные даты или повторяющиеся дни недели.</p>
        <div
          className="avail-rows"
          id="availability-rows"
          ref={availabilityRef}
          tabIndex={-1}
          aria-invalid={error?.field === 'availability' ? 'true' : undefined}
          aria-describedby={error?.field === 'availability' ? 'profile-error' : undefined}
        >
          {form.availability.map((row, index) => {
            const rowNumber = index + 1;
            const radioName = `${idPrefix}-availability-${row.id}`;
            const rowErrorProps = (field) => inputErrorProps(error, field, row.id);
            return (
              <Fragment key={row.id}>
              <fieldset
                className="avail-row"
                ref={(node) => {
                  if (node) rowRefs.current.set(row.id, node);
                  else rowRefs.current.delete(row.id);
                }}
              >
                <legend>Окно {rowNumber}</legend>
                <div className="avail-row__type">
                  <label className="pill-radio">
                    <input
                      type="radio"
                      name={radioName}
                      value="weekday"
                      checked={row.kind === 'weekday'}
                      disabled={isBusy}
                      onChange={() => setAvailabilityField(row.id, 'kind', 'weekday')}
                    />
                    <span>День недели</span>
                  </label>
                  <label className="pill-radio">
                    <input
                      type="radio"
                      name={radioName}
                      value="date"
                      checked={row.kind === 'date'}
                      disabled={isBusy}
                      onChange={() => setAvailabilityField(row.id, 'kind', 'date')}
                    />
                    <span>Конкретная дата</span>
                  </label>
                </div>
                <div className="avail-row__fields">
                  {row.kind === 'weekday' ? (
                    <select
                      className="avail-weekday"
                      value={row.weekday}
                      disabled={isBusy}
                      onChange={(event) => setAvailabilityField(row.id, 'weekday', event.target.value)}
                      aria-label={`День недели, окно ${rowNumber}`}
                      {...rowErrorProps('window-weekday')}
                    >
                      {WEEKDAYS.map((weekday, weekdayIndex) => (
                        <option key={weekdayIndex} value={weekdayIndex}>{weekday}</option>
                      ))}
                    </select>
                  ) : (
                    <Input
                      type="date"
                      id={`${idPrefix}-${row.id}-date`}
                      min={limits.today}
                      max={availabilityMax}
                      value={row.date}
                      disabled={isBusy}
                      onChange={(event) => setAvailabilityField(row.id, 'date', event.target.value)}
                      aria-label={`Конкретная дата, окно ${rowNumber}`}
                      innerClassNames={{ input: 'avail-date' }}
                      {...rowErrorProps('window-date')}
                    />
                  )}
                  <Input
                    type="time"
                    id={`${idPrefix}-${row.id}-start`}
                    value={row.start}
                    disabled={isBusy}
                    onChange={(event) => setAvailabilityField(row.id, 'start', event.target.value)}
                    aria-label={`Время начала, окно ${rowNumber}`}
                    innerClassNames={{ input: 'avail-start' }}
                    {...rowErrorProps('window-start')}
                  />
                  <span className="avail-sep" aria-hidden="true">–</span>
                  <Input
                    type="time"
                    id={`${idPrefix}-${row.id}-end`}
                    value={row.end}
                    disabled={isBusy}
                    onChange={(event) => setAvailabilityField(row.id, 'end', event.target.value)}
                    aria-label={`Время окончания, окно ${rowNumber}`}
                    innerClassNames={{ input: 'avail-end' }}
                    {...rowErrorProps('window-end')}
                  />
                  <Button
                    type="button"
                    className="avail-remove"
                    variant="ghost"
                    size="small"
                    title="Удалить окно"
                    aria-label={`Удалить окно ${rowNumber}`}
                    disabled={isBusy}
                    onClick={() => removeWindow(row.id)}
                  >
                    ×
                  </Button>
                </div>
              </fieldset>
              {error?.rowId === row.id && error.field?.startsWith('window-') ? renderError(error.field, row.id) : null}
              </Fragment>
            );
          })}
        </div>
        {renderError('availability')}
        <Button
          id="btn-add-window"
          ref={addWindowRef}
          type="button"
          className="btn btn--ghost btn--sm"
          variant="ghost"
          size="small"
          disabled={isBusy || form.availability.length >= 40}
          onClick={addWindow}
        >
          ＋ Добавить окно
        </Button>
      </fieldset>

      <fieldset className="form-group" id="weights-group" hidden={!categories.length}>
        <legend>Интересы</legend>
        <p className="form-hint">Отметьте важность каждой категории: 1 — совсем не интересует, 5 — главный интерес.</p>
        <div id="category-weights">
          {categories.map((category) => {
            const selected = form.categoryWeights[category] ?? 3;
            return (
              <div className="weight-row" data-category={category} key={category}>
                <span className="weight-row__name">{category}</span>
                <div className="weight-row__opts" role="group" aria-label={`Важность категории «${category}»`}>
                  {[1, 2, 3, 4, 5].map((weight) => (
                    <Button
                      type="button"
                      className={`weight-opt${selected === weight ? ' is-active' : ''}`}
                      variant={selected === weight ? 'primary' : 'secondary'}
                      size="small"
                      key={weight}
                      data-v={weight}
                      aria-label={`${category} — ${weight}`}
                      aria-pressed={selected === weight}
                      disabled={isBusy}
                      onClick={() => updateForm((previous) => ({
                        ...previous,
                        categoryWeights: { ...previous.categoryWeights, [category]: weight },
                      }))}
                    >
                      {weight}
                    </Button>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </fieldset>

      <fieldset className="form-group" id="excluded-group" hidden={!categories.length}>
        <legend>Исключить категории</legend>
        <p className="form-hint">События отмеченных категорий не попадут в план.</p>
        <div className="chips" id="excluded-categories">
          {categories.map((category) => (
            <label className="chip" key={category}>
              <input
                type="checkbox"
                value={category}
                checked={form.excludedCategories.includes(category)}
                disabled={isBusy}
                onChange={(event) => updateForm((previous) => ({
                  ...previous,
                  excludedCategories: event.target.checked
                    ? [...previous.excludedCategories, category]
                    : previous.excludedCategories.filter((item) => item !== category),
                }))}
              />
              <span>{category}</span>
            </label>
          ))}
        </div>
      </fieldset>

      {!errorIsInline && renderError()}
      <div className="form-actions">
        <Button
          type="submit"
          className="btn btn--primary"
          innerClassNames={{ content: 'action-button__content' }}
          variant="primary"
          size="medium"
          loading={isBusy}
          disabled={isBusy}
        >
          Сохранить и рассчитать планы
        </Button>
        <Button
          id="btn-cancel-profile"
          type="button"
          className="btn btn--ghost"
          variant="ghost"
          size="medium"
          hidden={!data?.profile}
          disabled={isBusy}
          onClick={onCancel}
        >
          Отмена
        </Button>
      </div>
    </form>
  );
}
