/**
 * Общие функции хранилища, модели данных и форматирования.
 * Используется service worker'ом, popup и панелью истории.
 */

import {
  parsePriceValue,
  productIdFromUrl,
  skuFromUrl,
  titleFromUrl,
  normalizeProductUrl,
  storeIdFromUrl
} from './parse.js';

export const DEFAULT_SETTINGS = Object.freeze({
  intervalMinutes: 360,
  notifyOnDrop: true,
  notifyPercent: 3,
  notifyTarget: true,
  tabFallback: true,
  historyLimit: 4000
});

export const INTERVAL_OPTIONS = [
  { value: 15, label: 'каждые 15 минут' },
  { value: 30, label: 'каждые 30 минут' },
  { value: 60, label: 'каждый час' },
  { value: 180, label: 'каждые 3 часа' },
  { value: 360, label: 'каждые 6 часов' },
  { value: 720, label: 'каждые 12 часов' },
  { value: 1440, label: 'раз в день' }
];

export function sanitizeSettings(input) {
  const source = input && typeof input === 'object' ? input : {};
  const interval = Number(source.intervalMinutes);
  const percent = Number(source.notifyPercent);
  const limit = Number(source.historyLimit);

  return {
    intervalMinutes: Number.isFinite(interval) ? Math.min(10080, Math.max(15, Math.round(interval))) : DEFAULT_SETTINGS.intervalMinutes,
    notifyOnDrop: source.notifyOnDrop !== undefined ? Boolean(source.notifyOnDrop) : DEFAULT_SETTINGS.notifyOnDrop,
    notifyPercent: Number.isFinite(percent) ? Math.min(90, Math.max(0.5, percent)) : DEFAULT_SETTINGS.notifyPercent,
    notifyTarget: source.notifyTarget !== undefined ? Boolean(source.notifyTarget) : DEFAULT_SETTINGS.notifyTarget,
    tabFallback: source.tabFallback !== undefined ? Boolean(source.tabFallback) : DEFAULT_SETTINGS.tabFallback,
    historyLimit: Number.isFinite(limit) ? Math.min(10000, Math.max(200, Math.round(limit))) : DEFAULT_SETTINGS.historyLimit
  };
}

export async function getSettings() {
  const data = await chrome.storage.local.get('settings');
  return sanitizeSettings(data.settings);
}

export async function saveSettings(patch) {
  const current = await getSettings();
  const next = sanitizeSettings({ ...current, ...(patch || {}) });
  await chrome.storage.local.set({ settings: next });
  return next;
}

export async function getItems() {
  const data = await chrome.storage.local.get('items');
  return Array.isArray(data.items) ? data.items : [];
}

export async function saveItems(items) {
  await chrome.storage.local.set({ items: Array.isArray(items) ? items : [] });
}

/** Добавляет поле store старым записям и чинит id, если он потерялся. */
export function normalizeItemStore(item) {
  if (!item || typeof item !== 'object') return item;
  const store = storeIdFromUrl(item.url) || item.store || 'ozon';
  const id = item.id || productIdFromUrl(item.url);
  if (item.store === store && item.id === id) return item;
  return { ...item, store, id };
}

export function findItem(items, idOrUrl) {
  if (!Array.isArray(items)) return null;
  const direct = items.find((item) => item && (item.id === idOrUrl || item.url === idOrUrl));
  if (direct) return direct;
  try {
    const id = productIdFromUrl(idOrUrl);
    return items.find((item) => item && item.id === id) || null;
  } catch {
    return null;
  }
}

export function createItem(product, settings = DEFAULT_SETTINGS) {
  const url = normalizeProductUrl(product.url);
  if (!url) throw new Error('Некорректная ссылка на карточку товара');
  const now = Date.now();
  const price = parsePriceValue(product.price);
  const target = Number(product.targetPrice);
  const inStock = product.inStock !== false;

  return {
    id: product.id || productIdFromUrl(url),
    store: product.store || storeIdFromUrl(url) || 'ozon',
    url,
    sku: product.sku || skuFromUrl(url),
    title: String(product.title || '').trim() || titleFromUrl(url),
    image: product.image || null,
    price: price ?? null,
    currency: product.currency || 'RUB',
    inStock,
    targetPrice: Number.isFinite(target) && target > 0 ? Math.round(target * 100) / 100 : null,
    addedAt: now,
    updatedAt: now,
    lastCheckAt: price ? now : null,
    lastAttemptAt: now,
    status: price ? 'ok' : 'pending',
    error: null,
    source: product.source || 'page',
    notifiedPrice: null,
    composition:
      typeof product.composition === 'string' && product.composition.trim()
        ? product.composition.trim().slice(0, 20000)
        : null,
    compositionAt:
      typeof product.composition === 'string' && product.composition.trim() ? now : null,
    history: price ? [{ t: now, p: price, s: inStock ? 1 : 0 }] : []
  };
}

const MAX_HISTORY_SAFETY = 12000;

/** Добавляет точку истории, если цена/наличие изменились. Не мутирует исходный объект. */
export function applyPrice(item, product, source = 'fetch', at = Date.now(), historyLimit = DEFAULT_SETTINGS.historyLimit) {
  if (!item) return item;
  const price = parsePriceValue(product && product.price);
  if (price == null) return item;

  const inStock = product.inStock !== false;
  const limit = Math.min(MAX_HISTORY_SAFETY, Math.max(200, Number(historyLimit) || DEFAULT_SETTINGS.historyLimit));
  const history = Array.isArray(item.history) ? item.history.slice(-limit) : [];
  const last = history[history.length - 1];

  if (!last) {
    history.push({ t: at, p: price, s: inStock ? 1 : 0 });
  } else if (last.p !== price) {
    history.push({ t: at, p: price, s: inStock ? 1 : 0 });
  } else if (Boolean(last.s) !== inStock) {
    history.push({ t: at, p: price, s: inStock ? 1 : 0 });
  }

  while (history.length > limit) history.shift();

  return {
    ...item,
    title: product.title ? String(product.title).trim() : item.title,
    image: product.image || item.image,
    price,
    currency: product.currency || item.currency || 'RUB',
    inStock,
    updatedAt: at,
    lastCheckAt: at,
    lastAttemptAt: at,
    status: 'ok',
    error: null,
    source,
    history
  };
}

/** Свежая цена и предыдущая отличающаяся цена. */
export function priceSnapshot(item) {
  const history = Array.isArray(item && item.history) ? item.history.filter((point) => Number.isFinite(point.p)) : [];
  const last = history[history.length - 1] || null;
  let previous = null;
  for (let i = history.length - 2; i >= 0; i--) {
    if (history[i].p !== (last ? last.p : null)) {
      previous = history[i];
      break;
    }
  }
  const current = Number.isFinite(item && item.price) ? item.price : last ? last.p : null;
  const first = history[0] || null;
  return {
    current,
    previous: previous ? previous.p : null,
    first: first ? first.p : null,
    lastAt: last ? last.t : null,
    previousAt: previous ? previous.t : null,
    points: history.length
  };
}

/**
 * Статистика по точкам. Если points не передан — берётся вся история.
 * Средняя цена взвешена по времени, а не по количеству изменений.
 */
export function computeStats(item, points, now = Date.now()) {
  const source = Array.isArray(points)
    ? points
    : Array.isArray(item && item.history)
      ? item.history
      : [];
  const history = source
    .filter((point) => point && Number.isFinite(point.p) && point.p > 0)
    .slice()
    .sort((a, b) => a.t - b.t);

  if (!history.length) {
    return {
      min: null,
      max: null,
      avg: null,
      first: null,
      last: null,
      change: null,
      changePct: null,
      minAt: null,
      maxAt: null,
      firstAt: null,
      lastAt: null,
      points: 0,
      days: 0
    };
  }

  let min = history[0];
  let max = history[0];
  for (const point of history) {
    if (point.p < min.p) min = point;
    if (point.p > max.p) max = point;
  }

  let weighted = 0;
  let weight = 0;
  for (let i = 0; i < history.length; i++) {
    const from = history[i].t;
    const to = i + 1 < history.length ? Math.min(history[i + 1].t, now) : now;
    const span = Math.max(0, to - from);
    weighted += history[i].p * span;
    weight += span;
  }

  const first = history[0];
  const last = history[history.length - 1];
  const change = last.p - first.p;
  const changePct = first.p ? (change / first.p) * 100 : null;
  const avg = weight > 0 ? weighted / weight : last.p;

  return {
    min: min.p,
    max: max.p,
    avg: Math.round(avg * 100) / 100,
    first: first.p,
    last: last.p,
    change,
    changePct,
    minAt: min.t,
    maxAt: max.t,
    firstAt: first.t,
    lastAt: last.t,
    points: history.length,
    days: Math.max(1, Math.round((Math.max(now, last.t) - first.t) / 86_400_000))
  };
}

export function statsForRange(item, rangeDays, now = Date.now()) {
  const history = Array.isArray(item && item.history) ? item.history : [];
  if (!history.length) return computeStats(item, [], now);
  if (rangeDays === 'all') return computeStats(item, history, now);

  const from = now - rangeDays * 86_400_000;
  const inRange = history.filter((point) => point.t >= from);
  const before = history.filter((point) => point.t < from).pop();
  const points = before ? [{ ...before, t: from }, ...inRange] : inRange;
  return computeStats(item, points, now);
}

const priceFormatter = new Intl.NumberFormat('ru-RU', {
  minimumFractionDigits: 0,
  maximumFractionDigits: 2
});
const integerFormatter = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });

export function formatNumber(value) {
  if (!Number.isFinite(value)) return '—';
  return priceFormatter.format(value);
}

export function formatInteger(value) {
  if (!Number.isFinite(value)) return '—';
  return integerFormatter.format(value);
}

export function formatPrice(value, currency = 'RUB') {
  if (!Number.isFinite(value)) return '—';
  const suffix = currency === 'RUB' || !currency ? '₽' : currency;
  return `${priceFormatter.format(value)} ${suffix}`;
}

export function formatPriceShort(value) {
  if (!Number.isFinite(value)) return '—';
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace('.', ',').replace(',0', '')} млн ₽`;
  if (value >= 100_000) return `${Math.round(value / 1000)} тыс. ₽`;
  return `${integerFormatter.format(value)} ₽`;
}

export function formatPercent(value, withSign = true) {
  if (!Number.isFinite(value)) return '—';
  const rounded = Math.abs(value) >= 10 ? Math.round(value) : Math.round(value * 10) / 10;
  const sign = withSign && rounded > 0 ? '+' : rounded < 0 ? '−' : '';
  return `${sign}${Math.abs(rounded).toString().replace('.', ',')}%`;
}

export function formatDelta(value) {
  if (!Number.isFinite(value) || value === 0) return '0 ₽';
  const sign = value > 0 ? '+' : '−';
  return `${sign}${priceFormatter.format(Math.abs(value))} ₽`;
}

const MONTHS = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const MONTHS_FULL = [
  'января',
  'февраля',
  'марта',
  'апреля',
  'мая',
  'июня',
  'июля',
  'августа',
  'сентября',
  'октября',
  'ноября',
  'декабря'
];

export function formatDate(timestamp, monthStyle = 'short') {
  if (!Number.isFinite(timestamp)) return '—';
  const date = new Date(timestamp);
  const months = monthStyle === 'full' ? MONTHS_FULL : MONTHS;
  return `${date.getDate()} ${months[date.getMonth()]} ${date.getFullYear()}`;
}

export function formatDateTime(timestamp) {
  if (!Number.isFinite(timestamp)) return '—';
  const date = new Date(timestamp);
  const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  return `${formatDate(timestamp)}, ${time}`;
}

export function formatAxisDate(timestamp, spanMs) {
  const date = new Date(timestamp);
  if (spanMs <= 2 * 86_400_000) {
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  }
  if (spanMs <= 300 * 86_400_000) {
    return `${String(date.getDate()).padStart(2, '0')}.${String(date.getMonth() + 1).padStart(2, '0')}`;
  }
  return `${MONTHS[date.getMonth()]} ${String(date.getFullYear()).slice(2)}`;
}

export function formatRelative(timestamp) {
  if (!Number.isFinite(timestamp)) return '—';
  const diff = Date.now() - timestamp;
  if (diff < 0) return 'только что';
  if (diff < 60_000) return 'только что';
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `${minutes} мин назад`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ч назад`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} дн назад`;
  return formatDate(timestamp);
}

export function plural(count, one, few, many) {
  const abs = Math.abs(count) % 100;
  const last = abs % 10;
  if (abs > 10 && abs < 20) return many;
  if (last === 1) return one;
  if (last >= 2 && last <= 4) return few;
  return many;
}

export function truncate(text, max = 80) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}
