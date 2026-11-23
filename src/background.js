/**
 * Service worker: хранилище, периодические проверки, уведомления.
 */

import {
  DEFAULT_SETTINGS,
  sanitizeSettings,
  getSettings,
  saveSettings,
  getItems,
  saveItems,
  createItem,
  applyPrice,
  computeStats,
  formatPrice,
  truncate,
  normalizeItemStore
} from './lib/shared.js';
import {
  STORES,
  normalizeProductUrl,
  storeFromUrl,
  storeIdFromUrl,
  isShortUrl,
  productIdFromUrl,
  skuFromUrl,
  parseProductFromHtml,
  parseWbApi,
  isBlockedPage,
  titleFromUrl
} from './lib/parse.js';
import { analyzeInci, normalizeComposition } from './lib/inci.js';

const REFRESH_ALARM = 'ozon-price-refresh';
const FETCH_TIMEOUT_MS = 25_000;
const TAB_TIMEOUT_MS = 45_000;
const BETWEEN_ITEMS_MS = 1200;
const MAX_IMPORT_HISTORY = 10000;

let mutex = Promise.resolve();
let refreshing = false;
/** @type {Map<number, {resolve: Function, reject: Function, timer: number}>} */
const tabWaiters = new Map();

function locked(task) {
  const run = mutex.then(task, task);
  mutex = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class BlockedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BlockedError';
    this.blocked = true;
  }
}

function isBlockedFailure(error) {
  if (!error) return false;
  if (error.blocked || error instanceof BlockedError) return true;
  return /too many redirects|access denied|captcha|antibot|403|429/i.test(String(error.message || ''));
}

async function ensureDefaults() {
  const data = await chrome.storage.local.get(['settings', 'items']);
  const patch = {};
  if (!data.settings) patch.settings = { ...DEFAULT_SETTINGS };
  else patch.settings = sanitizeSettings(data.settings);
  if (!Array.isArray(data.items)) {
    patch.items = [];
  } else {
    let changed = false;
    const migrated = data.items.map((item) => {
      const next = normalizeItemStore(item);
      if (next !== item) changed = true;
      return next;
    });
    if (changed) patch.items = migrated;
  }
  if (Object.keys(patch).length) await chrome.storage.local.set(patch);
}

async function scheduleAlarm() {
  const settings = await getSettings();
  await chrome.alarms.clear(REFRESH_ALARM);
  chrome.alarms.create(REFRESH_ALARM, {
    delayInMinutes: 1,
    periodInMinutes: Math.max(15, settings.intervalMinutes)
  });
}

async function updateBadge() {
  try {
    const items = await getItems();
    const reached = items.filter(
      (item) => item && item.targetPrice && Number.isFinite(item.price) && item.price <= item.targetPrice
    ).length;
    await chrome.action.setBadgeBackgroundColor({ color: reached ? '#12b76a' : '#005bff' });
    await chrome.action.setBadgeText({ text: reached ? String(reached) : '' });
    await chrome.action.setTitle({
      title: `Price Tracker — ${items.length} ${items.length === 1 ? 'товар' : 'товаров'}${
        reached ? `, цель достигнута: ${reached}` : ''
      }`
    });
  } catch {
    /* вкладка могла быть закрыта */
  }
}

function broadcast(message) {
  try {
    const promise = chrome.runtime.sendMessage(message);
    if (promise && typeof promise.catch === 'function') promise.catch(() => undefined);
  } catch {
    /* нет слушателей — это нормально */
  }
}

async function fetchProductHtml(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      credentials: 'include',
      cache: 'no-store',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.6'
      }
    });
    const html = await response.text();
    return { status: response.status, html, finalUrl: response.url || url };
  } finally {
    clearTimeout(timer);
  }
}

async function resolveShortUrl(url) {
  try {
    const response = await fetch(url, {
      credentials: 'include',
      redirect: 'follow',
      cache: 'no-store',
      headers: { 'Accept-Language': 'ru-RU,ru;q=0.9' }
    });
    const finalUrl = response.url;
    return normalizeProductUrl(finalUrl);
  } catch {
    return null;
  }
}

async function commitProduct(itemId, product, source) {
  const settings = await getSettings();
  const result = await locked(async () => {
    const items = await getItems();
    const index = items.findIndex((item) => item.id === itemId);
    if (index < 0) return null;
    const before = items[index];
    const after = applyPrice(before, product, source, Date.now(), settings.historyLimit);
    if (product.composition) {
      const composition = normalizeComposition(product.composition);
      if (composition) {
        after.composition = composition;
        after.compositionAt = Date.now();
      }
    }
    items[index] = after;
    await saveItems(items);
    return { before, after };
  });

  if (!result) return null;
  await updateBadge();
  if (result.after.price !== result.before.price) {
    await maybeNotify(result.before, result.after, settings);
  }
  return result.after;
}

async function maybeNotify(before, after, settings) {
  if (!settings.notifyOnDrop) return;
  const previous = Number.isFinite(before.price) ? before.price : null;
  const current = after.price;
  if (!previous || !current || current >= previous) return;
  if (after.notifiedPrice === current) return;

  const dropPercent = ((previous - current) / previous) * 100;
  const hitTarget = Boolean(after.targetPrice) && current <= after.targetPrice && previous > after.targetPrice;
  const shouldNotify = (hitTarget && settings.notifyTarget) || dropPercent + 1e-9 >= settings.notifyPercent;
  if (!shouldNotify) return;

  const title = hitTarget ? '🎯 Целевая цена достигнута' : '📉 Цена снизилась';
  const message = `${truncate(after.title, 70)}\n${formatPrice(previous)} → ${formatPrice(current)} (−${Math.round(
    dropPercent
  )}%)${after.targetPrice ? `\nЦель: ${formatPrice(after.targetPrice)}` : ''}`;

  try {
    await chrome.notifications.create(`price-${after.id}`, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title,
      message,
      contextMessage: 'Price Tracker',
      priority: 2
    });
    await locked(async () => {
      const items = await getItems();
      const index = items.findIndex((item) => item.id === after.id);
      if (index >= 0) {
        items[index] = { ...items[index], notifiedPrice: current };
        await saveItems(items);
      }
    });
  } catch {
    /* уведомления могут быть запрещены системой */
  }
}

async function markCheckError(itemId, blocked, message) {
  await locked(async () => {
    const items = await getItems();
    const index = items.findIndex((item) => item.id === itemId);
    if (index < 0) return;
    items[index] = {
      ...items[index],
      status: blocked ? 'blocked' : 'error',
      error: String(message || 'Не удалось обновить цену'),
      lastAttemptAt: Date.now()
    };
    await saveItems(items);
  });
}

function storeLabelOf(url) {
  const store = storeFromUrl(url);
  return store ? store.label : 'Магазин';
}

/** Цена из публичного API Wildberries (в ответе копейки). */
async function fetchWbProduct(item) {
  const sku = item.sku || skuFromUrl(item.url);
  if (!sku) throw new Error('Не удалось определить артикул Wildberries');

  const api =
    'https://card.wb.ru/cards/v2/detail?appType=1&curr=rub&dest=-1257786&spp=30&nm=' + encodeURIComponent(sku);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(api, {
      cache: 'no-store',
      credentials: 'omit',
      signal: controller.signal,
      headers: { Accept: 'application/json' }
    });
    if (response.status === 403 || response.status === 429) {
      throw new BlockedError(`Wildberries ответил кодом ${response.status}`);
    }
    if (!response.ok) throw new Error(`Wildberries ответил кодом ${response.status}`);
    const product = parseWbApi(await response.json());
    if (!product || product.price == null) throw new Error('Wildberries не отдал цену');
    return {
      ...product,
      url: item.url,
      id: item.id,
      sku: product.sku || sku,
      store: 'wb'
    };
  } finally {
    clearTimeout(timer);
  }
}

async function refreshViaFetch(item) {
  const label = storeLabelOf(item.url);
  const { status, html, finalUrl } = await fetchProductHtml(item.url);
  if (status === 403 || status === 429) throw new BlockedError(`${label} ответил кодом ${status}`);
  if (status >= 400) throw new Error(`${label} ответил кодом ${status}`);
  if (isBlockedPage(html)) throw new BlockedError(`${label} показал страницу проверки`);

  const product = parseProductFromHtml(html, finalUrl || item.url);
  if (product.price == null) throw new Error('Не удалось найти цену на странице');
  return product;
}

async function refreshItem(itemId) {
  const items = await getItems();
  const item = items.find((entry) => entry.id === itemId);
  if (!item) return { ok: false, error: 'Товар не найден' };

  const settings = await getSettings();
  const storeId = storeIdFromUrl(item.url) || item.store || 'ozon';
  const store = STORES[storeId] || STORES.ozon;

  const commit = async (product, source) => {
    const updated = await commitProduct(item.id, product, source);
    return updated ? { ok: true, item: updated, via: source } : { ok: false, error: 'Товар был удалён' };
  };

  const tryTab = async () => {
    if (!settings.tabFallback) {
      const message = store.needsTab
        ? `Для «${store.label}» включите «Обновлять через вкладку» в настройках. Или просто откройте карточку товара — цена обновится автоматически.`
        : `${store.label} ограничил фоновый запрос. Откройте карточку товара — цена обновится автоматически.`;
      await markCheckError(item.id, true, message);
      return { ok: false, error: message, blocked: true };
    }

    try {
      const updated = await refreshViaTab(item);
      return updated ? { ok: true, item: updated, via: 'tab' } : { ok: false, error: 'Товар был удалён' };
    } catch (tabError) {
      const tabBlocked = isBlockedFailure(tabError);
      await markCheckError(item.id, tabBlocked, tabError.message);
      return { ok: false, error: tabError.message, blocked: tabBlocked };
    }
  };

  try {
    if (storeId === 'wb') {
      try {
        return await commit(await fetchWbProduct(item), 'fetch');
      } catch {
        // API может быть недоступен из расширения — достаём цену со страницы.
        return await tryTab();
      }
    }

    if (store.needsTab) {
      return await tryTab();
    }

    return await commit(await refreshViaFetch(item), 'fetch');
  } catch (error) {
    const blocked = isBlockedFailure(error);
    if (blocked) return await tryTab();

    const message =
      error.name === 'AbortError'
        ? `Превышено время ожидания ответа (${store.label})`
        : error.message || 'Не удалось обновить цену';
    await markCheckError(item.id, false, message);
    return { ok: false, error: message, blocked: false };
  }
}

function refreshViaTab(item) {
  return chrome.tabs.create({ url: item.url, active: false }).then((tab) => {
    if (!tab.id) throw new Error('Не удалось открыть вкладку');

    // muted не входит в createProperties: приглушаем вкладку отдельным вызовом.
    try {
      chrome.tabs.update(tab.id, { muted: true }, () => void chrome.runtime.lastError);
    } catch {
      /* старые версии браузера могут не поддерживать muted */
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        tabWaiters.delete(tab.id);
        reject(new Error('Страница не отдала цену за 45 секунд'));
      }, TAB_TIMEOUT_MS);

      tabWaiters.set(tab.id, {
        resolve: (updated) => {
          clearTimeout(timer);
          tabWaiters.delete(tab.id);
          resolve(updated);
        },
        reject: (error) => {
          clearTimeout(timer);
          tabWaiters.delete(tab.id);
          reject(error);
        },
        timer
      });
    }).finally(() => {
      chrome.tabs.remove(tab.id).catch(() => undefined);
    });
  });
}

async function refreshAll({ force = false } = {}) {
  if (refreshing) return { ok: false, error: 'Обновление уже идёт' };
  refreshing = true;

  try {
    const settings = await getSettings();
    const items = await getItems();
    const total = items.length;
    let done = 0;
    let updated = 0;
    let failed = 0;

    for (const item of items) {
      const lastAttempt = item.lastAttemptAt || item.lastCheckAt || 0;
      const tooFresh = Date.now() - lastAttempt < settings.intervalMinutes * 60_000 * 0.5;
      if (!force && tooFresh) {
        done++;
        broadcast({ type: 'REFRESH_PROGRESS', done, total, itemId: item.id, skipped: true });
        continue;
      }

      broadcast({ type: 'REFRESH_PROGRESS', done, total, itemId: item.id });
      const result = await refreshItem(item.id);
      if (result.ok) updated++;
      else failed++;
      done++;
      broadcast({ type: 'REFRESH_PROGRESS', done, total, itemId: item.id, ok: result.ok });
      await sleep(BETWEEN_ITEMS_MS);
    }

    await updateBadge();
    return { ok: true, total, updated, failed };
  } finally {
    refreshing = false;
    broadcast({ type: 'REFRESH_PROGRESS', done: 1, total: 1, finished: true });
  }
}

function normalizeTarget(targetPrice) {
  if (targetPrice === null || targetPrice === undefined || targetPrice === '') return null;
  const number = Number(String(targetPrice).replace(',', '.').replace(/\s/g, ''));
  if (!Number.isFinite(number) || number <= 0) return null;
  return Math.round(number * 100) / 100;
}

async function addProduct(product, targetPrice) {
  const url = normalizeProductUrl(product && product.url);
  if (!url) throw new Error('Это не ссылка на карточку товара');

  const settings = await getSettings();
  const target = normalizeTarget(targetPrice);
  const id = product.id || productIdFromUrl(url);
  const composition = normalizeComposition(product.composition);

  const item = await locked(async () => {
    const items = await getItems();
    const index = items.findIndex((entry) => entry.id === id || entry.url === url);

    if (index >= 0) {
      let merged = { ...items[index] };
      if (product.title) merged.title = String(product.title).trim();
      if (product.image) merged.image = product.image;
      if (target !== null) merged.targetPrice = target;
      if (product.price != null) {
        merged = applyPrice(merged, { ...product, url }, 'page', Date.now(), settings.historyLimit);
      } else {
        merged.status = merged.price ? 'ok' : 'pending';
        merged.error = null;
        merged.lastAttemptAt = Date.now();
      }
      if (composition) {
        merged.composition = composition;
        merged.compositionAt = Date.now();
      }
      items[index] = merged;
      await saveItems(items);
      return merged;
    }

    const created = createItem(
      {
        ...product,
        url,
        id,
        title: product.title || titleFromUrl(url),
        targetPrice: target,
        composition
      },
      settings
    );
    items.unshift(created);
    await saveItems(items);
    return created;
  });

  await updateBadge();
  return item;
}

async function addUrl(rawUrl, targetPrice) {
  const direct = normalizeProductUrl(rawUrl);
  let url = direct;
  if (!url && isShortUrl(rawUrl)) url = await resolveShortUrl(String(rawUrl).trim());
  if (!url) {
    return {
      ok: false,
      error: 'Не удалось распознать ссылку. Поддерживаются Ozon, Wildberries, Золотое яблоко и Летуаль.'
    };
  }

  const product = parseProductFromHtml('', url);
  const item = await addProduct(
    {
      url,
      id: product.id,
      title: titleFromUrl(url),
      price: null
    },
    targetPrice
  );

  // Первую цену подтягиваем в фоне, чтобы попап не ждал сеть.
  refreshItem(item.id).catch(() => undefined);

  return { ok: true, item };
}

async function setTarget(itemId, targetPrice) {
  const target = normalizeTarget(targetPrice);
  const items = await locked(async () => {
    const current = await getItems();
    const index = current.findIndex((item) => item.id === itemId);
    if (index < 0) return null;
    current[index] = { ...current[index], targetPrice: target };
    await saveItems(current);
    return current;
  });
  if (!items) return { ok: false, error: 'Товар не найден' };
  await updateBadge();
  return { ok: true, item: items.find((item) => item.id === itemId) };
}

async function removeItem(itemId) {
  const removed = await locked(async () => {
    const items = await getItems();
    const next = items.filter((item) => item.id !== itemId);
    if (next.length === items.length) return false;
    await saveItems(next);
    return true;
  });
  await updateBadge();
  return { ok: removed };
}

async function clearHistory(itemId) {
  await locked(async () => {
    const items = await getItems();
    const index = items.findIndex((item) => item.id === itemId);
    if (index < 0) return;
    const item = items[index];
    items[index] = {
      ...item,
      history:
        Number.isFinite(item.price) && item.price > 0
          ? [{ t: Date.now(), p: item.price, s: item.inStock ? 1 : 0 }]
          : []
    };
    await saveItems(items);
  });
  return { ok: true };
}

async function clearAll() {
  await locked(async () => {
    await saveItems([]);
  });
  await updateBadge();
  return { ok: true };
}

function normalizeImportedItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const url = normalizeProductUrl(raw.url);
  if (!url) return null;

  const base = createItem(
    {
      url,
      title: raw.title || titleFromUrl(url),
      image: raw.image || null,
      targetPrice: raw.targetPrice,
      price: raw.price
    },
    DEFAULT_SETTINGS
  );

  const history = Array.isArray(raw.history)
    ? raw.history
        .filter((point) => point && Number.isFinite(point.t) && Number.isFinite(point.p) && point.p > 0)
        .map((point) => ({
          t: Number(point.t),
          p: Math.round(Number(point.p) * 100) / 100,
          s: point.s === 0 || point.s === false ? 0 : 1
        }))
        .sort((a, b) => a.t - b.t)
        .slice(-MAX_IMPORT_HISTORY)
    : [];

  const last = history[history.length - 1];
  return {
    ...base,
    id: raw.id && /^[a-z0-9-]+$/i.test(raw.id) ? raw.id : base.id,
    title: String(raw.title || base.title).slice(0, 300),
    image: typeof raw.image === 'string' ? raw.image : null,
    price: last ? last.p : Number.isFinite(raw.price) ? raw.price : null,
    targetPrice: normalizeTarget(raw.targetPrice),
    addedAt: Number.isFinite(raw.addedAt) ? raw.addedAt : last ? last.t : base.addedAt,
    updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : last ? last.t : base.updatedAt,
    lastCheckAt: Number.isFinite(raw.lastCheckAt) ? raw.lastCheckAt : last ? last.t : null,
    lastAttemptAt: Number.isFinite(raw.lastAttemptAt) ? raw.lastAttemptAt : Date.now(),
    status: last ? 'ok' : 'pending',
    error: null,
    source: 'import',
    notifiedPrice: Number.isFinite(raw.notifiedPrice) ? raw.notifiedPrice : null,
    composition: normalizeComposition(raw.composition),
    compositionAt: Number.isFinite(raw.compositionAt) ? raw.compositionAt : null,
    history
  };
}

async function importData(payload, mode = 'merge') {
  const incoming = Array.isArray(payload) ? payload : payload && Array.isArray(payload.items) ? payload.items : null;
  if (!incoming) return { ok: false, error: 'В файле нет списка товаров' };

  const imported = incoming.map(normalizeImportedItem).filter(Boolean);
  if (!imported.length) return { ok: false, error: 'Не удалось прочитать ни одного товара' };

  const settingsPatch = payload && payload.settings ? payload.settings : null;
  if (settingsPatch) await saveSettings(settingsPatch);

  await locked(async () => {
    if (mode === 'replace') {
      await saveItems(imported);
      return;
    }

    const items = await getItems();
    const byId = new Map(items.map((item) => [item.id, item]));

    for (const candidate of imported) {
      const existing = byId.get(candidate.id);
      if (!existing) {
        byId.set(candidate.id, candidate);
        continue;
      }

      const mergedHistory = [...(existing.history || []), ...(candidate.history || [])]
        .filter((point) => point && Number.isFinite(point.t) && Number.isFinite(point.p))
        .sort((a, b) => a.t - b.t)
        .reduce((acc, point) => {
          const last = acc[acc.length - 1];
          if (!last || last.t !== point.t || last.p !== point.p) acc.push(point);
          return acc;
        }, [])
        .slice(-MAX_IMPORT_HISTORY);

      const last = mergedHistory[mergedHistory.length - 1];
      byId.set(candidate.id, {
        ...existing,
        title: existing.title || candidate.title,
        image: existing.image || candidate.image,
        targetPrice: existing.targetPrice ?? candidate.targetPrice,
        price: last ? last.p : existing.price,
        addedAt: Math.min(existing.addedAt || candidate.addedAt, candidate.addedAt || existing.addedAt),
        updatedAt: Math.max(existing.updatedAt || 0, candidate.updatedAt || 0),
        lastCheckAt: Math.max(existing.lastCheckAt || 0, candidate.lastCheckAt || 0) || null,
        composition: existing.composition || candidate.composition || null,
        compositionAt: Math.max(existing.compositionAt || 0, candidate.compositionAt || 0) || null,
        history: mergedHistory
      });
    }

    await saveItems([...byId.values()]);
  });

  await updateBadge();
  return { ok: true, imported: imported.length };
}

async function exportData() {
  const [items, settings] = await Promise.all([getItems(), getSettings()]);
  return {
    ok: true,
    app: 'price-tracker',
    version: 2,
    exportedAt: new Date().toISOString(),
    settings,
    items
  };
}

async function getState(mode = 'full') {
  const [items, settings] = await Promise.all([getItems(), getSettings()]);
  const shaped = items.map((item) => ({
    ...item,
    history: mode === 'lite' ? (item.history || []).slice(-80) : item.history || [],
    stats: computeStats(item)
  }));
  return { ok: true, items: shaped, settings, refreshing };
}

async function handlePageProduct(product, sender) {
  if (!product || typeof product !== 'object') return { ok: false, error: 'Нет данных о товаре' };
  const url = normalizeProductUrl(product.url);
  const waiter = sender && sender.tab && sender.tab.id != null ? tabWaiters.get(sender.tab.id) : null;

  if (!url) {
    if (waiter) waiter.reject(new Error('Это не страница товара'));
    return { ok: false, error: 'Некорректная ссылка' };
  }

  const id = productIdFromUrl(url);
  const items = await getItems();
  const existing = items.find((item) => item.id === id) || null;
  const tracked = Boolean(existing);
  const incomingComposition = normalizeComposition(product.composition);
  const composition = incomingComposition || (existing && existing.composition) || null;
  const analysis = composition ? analyzeInci(composition) : null;
  let updated = null;

  if (tracked && product.price != null) {
    updated = await commitProduct(
      id,
      {
        ...product,
        url,
        ...(incomingComposition ? { composition: incomingComposition } : {})
      },
      'page'
    );
  } else if (tracked) {
    await locked(async () => {
      const current = await getItems();
      const index = current.findIndex((item) => item.id === id);
      if (index < 0) return;
      current[index] = {
        ...current[index],
        store: storeIdFromUrl(url) || current[index].store || 'ozon',
        title: product.title || current[index].title,
        image: product.image || current[index].image,
        ...(incomingComposition
          ? { composition: incomingComposition, compositionAt: Date.now() }
          : {}),
        lastAttemptAt: Date.now(),
        status: current[index].price ? 'ok' : 'pending',
        error: null
      };
      await saveItems(current);
    });
    updated = (await getItems()).find((item) => item.id === id) || null;
  }

  if (waiter) {
    if (product.price == null) {
      waiter.reject(new Error('На странице не нашлась цена — возможно, товар снят с продажи'));
    } else if (updated) {
      waiter.resolve(updated);
    } else {
      waiter.reject(new Error('Товар не найден в списке'));
    }
  }

  return {
    ok: true,
    tracked,
    item: updated ? { ...updated, stats: computeStats(updated) } : null,
    analysis
  };
}

async function openDashboard(itemId) {
  const base = chrome.runtime.getURL('src/dashboard.html');
  const url = itemId ? `${base}#item=${encodeURIComponent(itemId)}` : base;
  await chrome.tabs.create({ url });
  return { ok: true };
}

const handlers = {
  GET_STATE: (message) => getState(message.mode),
  GET_SETTINGS: async () => ({ ok: true, settings: await getSettings() }),
  SET_SETTINGS: async (message) => {
    const settings = await saveSettings(message.settings);
    await scheduleAlarm();
    return { ok: true, settings };
  },
  ADD_PRODUCT: async (message) => {
    const item = await addProduct(message.product || {}, message.targetPrice);
    if (item && item.price == null) refreshItem(item.id).catch(() => undefined);
    return { ok: true, item: item ? { ...item, stats: computeStats(item) } : null };
  },
  ADD_URL: (message) => addUrl(message.url, message.targetPrice),
  REMOVE_ITEM: (message) => removeItem(message.id),
  SET_TARGET: (message) => setTarget(message.id, message.targetPrice),
  REFRESH_ITEM: async (message) => {
    const result = await refreshItem(message.id);
    return { ...result, state: await getState('lite') };
  },
  REFRESH_ALL: async (message) => {
    const result = await refreshAll({ force: Boolean(message.force) });
    return { ...result, state: await getState('lite') };
  },
  CLEAR_HISTORY: (message) => clearHistory(message.id),
  CLEAR_ALL: () => clearAll(),
  EXPORT_DATA: () => exportData(),
  IMPORT_DATA: (message) => importData(message.data, message.mode),
  OPEN_DASHBOARD: (message) => openDashboard(message.id),
  PAGE_PRODUCT: (message, sender) => handlePageProduct(message.product, sender)
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== 'object' || typeof message.type !== 'string') return false;
  if (!sender.tab && message.type === 'PAGE_PRODUCT') return false;

  const handler = handlers[message.type];
  if (!handler) return false;

  Promise.resolve()
    .then(() => handler(message, sender))
    .then((result) => sendResponse(result || { ok: true }))
    .catch((error) =>
      sendResponse({
        ok: false,
        error: String((error && error.message) || error || 'Неизвестная ошибка')
      })
    );

  return true;
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === REFRESH_ALARM) {
    refreshAll({ force: false }).catch(() => undefined);
  }
});

chrome.notifications.onClicked.addListener(async (notificationId) => {
  if (!notificationId.startsWith('price-')) return;
  const id = notificationId.slice('price-'.length);
  try {
    const items = await getItems();
    const item = items.find((entry) => entry.id === id);
    if (item) await chrome.tabs.create({ url: item.url });
    await chrome.notifications.clear(notificationId);
  } catch {
    /* ignore */
  }
});

chrome.runtime.onInstalled.addListener(async (details) => {
  try {
    await ensureDefaults();
    await scheduleAlarm();
    await updateBadge();
    if (details.reason === 'install') {
      await chrome.tabs.create({ url: chrome.runtime.getURL('src/dashboard.html') + '#welcome=1' });
    }
  } catch {
    /* ignore */
  }
});

chrome.runtime.onStartup.addListener(async () => {
  try {
    await ensureDefaults();
    await scheduleAlarm();
    await updateBadge();
  } catch {
    /* ignore */
  }
});

ensureDefaults()
  .then(updateBadge)
  .catch(() => undefined);
