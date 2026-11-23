/**
 * Поддерживаемые магазины: адреса, шаблоны ссылок и метаданные для интерфейса.
 * Чистый модуль без chrome API — используется service worker'ом и страницами расширения.
 */

function hostMatches(hostname, host) {
  const clean = String(hostname || '')
    .toLowerCase()
    .replace(/^www\./, '')
    .replace(/^m\./, '');
  return clean === host || clean.endsWith('.' + host);
}

function skuFromPath(path, pattern) {
  const match = String(path || '').match(pattern);
  return match ? match[1] : null;
}

/**
 * Порядок важен: первый магазин, чей хост совпал, считается целевым.
 * field `needsTab` — страницу нельзя надёжно разобрать фоновым запросом.
 */
export const STORES = Object.freeze({
  ozon: {
    id: 'ozon',
    label: 'Ozon',
    badge: 'Ozon',
    color: '#005bff',
    site: 'https://www.ozon.ru',
    host: 'ozon.ru',
    needsTab: false,
    isProductPath: (path) => /^\/product\/[^/]+/i.test(path),
    skuFromPath: (path) => skuFromPath(path, /-(\d{4,})\/?$/) || skuFromPath(path, /^\/product\/(\d{4,})\/?$/i),
    normalize: (url) => `https://www.ozon.ru${url.pathname.replace(/\/+$/, '')}/`
  },
  wb: {
    id: 'wb',
    label: 'Wildberries',
    badge: 'WB',
    color: '#cb11ab',
    site: 'https://www.wildberries.ru',
    host: 'wildberries.ru',
    needsTab: true,
    isProductPath: (path) => /^\/catalog\/\d{4,}\/detail\.aspx\/?$/i.test(path),
    skuFromPath: (path) => skuFromPath(path, /^\/catalog\/(\d{4,})\/detail\.aspx\/?$/i),
    normalize: (url) => `https://www.wildberries.ru/catalog/${skuFromPath(url.pathname, /(\d{4,})/)}/detail.aspx`
  },
  goldapple: {
    id: 'goldapple',
    label: 'Золотое яблоко',
    badge: 'ЗЯ',
    color: '#f4b400',
    site: 'https://goldapple.ru',
    host: 'goldapple.ru',
    needsTab: true,
    isProductPath: (path) => /^\/\d{6,}(?:-[^/]+)?\/?$/i.test(path),
    skuFromPath: (path) => skuFromPath(path, /^\/(\d{6,})(?:-[^/]+)?\/?$/i),
    normalize: (url) => `https://goldapple.ru${url.pathname.replace(/\/+$/, '')}`
  },
  letu: {
    id: 'letu',
    label: 'Летуаль',
    badge: 'ЛЭТУ',
    color: '#e4002b',
    site: 'https://www.letu.ru',
    host: 'letu.ru',
    needsTab: true,
    isProductPath: (path) => /^\/product\/[^/]+\/\d{4,}\/?$/i.test(path),
    skuFromPath: (path) => skuFromPath(path, /^\/product\/[^/]+\/(\d{4,})\/?$/i),
    normalize: (url) => `https://www.letu.ru${url.pathname.replace(/\/+$/, '')}`
  }
});

export const STORE_LIST = Object.freeze(Object.values(STORES));

/** Если протокол не указан, достраивает адрес по хосту или по пути. */
function toUrl(input) {
  if (!input || typeof input !== 'string') return null;
  let raw = input.trim();
  if (!raw) return null;

  if (raw.startsWith('//')) raw = 'https:' + raw;
  if (!/^https?:\/\//i.test(raw)) {
    if (/^(www\.|m\.)?(ozon\.ru|wildberries\.ru|goldapple\.ru|letu\.ru)\//i.test(raw)) {
      raw = 'https://' + raw;
    } else if (raw.startsWith('/')) {
      if (/^\/catalog\/\d+\/detail\.aspx/i.test(raw)) raw = 'https://www.wildberries.ru' + raw;
      else if (/^\/product\/[^/]+\/\d+\/?$/i.test(raw)) raw = 'https://www.letu.ru' + raw;
      else if (/^\/\d{6,}(?:-[^/]+)?\/?$/i.test(raw)) raw = 'https://goldapple.ru' + raw;
      else raw = 'https://www.ozon.ru' + raw;
    } else {
      raw = 'https://www.ozon.ru/' + raw.replace(/^\/+/, '');
    }
  }

  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

/** Магазин по ссылке (без проверки, что это карточка товара). */
export function storeFromUrl(input) {
  const url = input instanceof URL ? input : toUrl(input);
  if (!url) return null;
  return STORE_LIST.find((store) => hostMatches(url.hostname, store.host)) || null;
}

export function storeIdFromUrl(input) {
  const store = storeFromUrl(input);
  return store ? store.id : null;
}

/** Ссылка принадлежит одному из поддерживаемых магазинов. */
export function isStoreUrl(input) {
  return storeFromUrl(input) !== null;
}

/** Нормализует ссылку на карточку товара. Возвращает null, если это не карточка. */
export function normalizeProductUrl(input) {
  const url = input instanceof URL ? input : toUrl(input);
  if (!url) return null;
  const store = storeFromUrl(url);
  if (!store) return null;
  if (!store.isProductPath(url.pathname)) return null;
  if (!store.skuFromPath(url.pathname)) return null;
  return store.normalize(url);
}

export function isProductUrl(input) {
  return normalizeProductUrl(input) !== null;
}

/** Короткая ссылка Ozon вида https://ozon.ru/t/AbCdEf. */
export function isShortUrl(input) {
  try {
    const url = toUrl(input);
    return Boolean(url && storeIdFromUrl(url) === 'ozon' && /^\/t\/[^/]+\/?$/i.test(url.pathname));
  } catch {
    return false;
  }
}

/** Артикул товара в терминах магазина. */
export function skuFromUrl(input) {
  const url = input instanceof URL ? input : toUrl(input);
  if (!url) return null;
  const store = storeFromUrl(url);
  if (!store || !store.isProductPath(url.pathname)) return null;
  return store.skuFromPath(url.pathname) || null;
}

function fnv1a(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

/** Стабильный идентификатор товара: <магазин>-<артикул>. */
export function productIdFromUrl(input) {
  const store = storeIdFromUrl(input);
  const sku = skuFromUrl(input);
  if (store && sku) return `${store}-${sku}`;
  const normalized = (store && normalizeProductUrl(input)) || String(input || '');
  try {
    const path = new URL(normalized).pathname;
    return 'url-' + fnv1a(path || normalized);
  } catch {
    return 'url-' + fnv1a(normalized);
  }
}

function decodeSafe(text) {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/** Человеческое название из slug, пока страница не отдала настоящее. */
export function titleFromUrl(input) {
  const store = storeFromUrl(input);
  const normalized = normalizeProductUrl(input) || String(input || '');
  let path = '';
  try {
    path = new URL(normalized).pathname;
  } catch {
    path = normalized;
  }

  let slug = '';
  if (store && store.id === 'letu') {
    slug = path.split('/').filter(Boolean).slice(-2, -1)[0] || '';
  } else if (store && store.id === 'wb') {
    slug = '';
  } else {
    slug = path.split('/').filter(Boolean).pop() || '';
  }

  let text = decodeSafe(slug)
    .replace(/^\d{6,}-/, '')
    .replace(/-?\d{5,}$/, '')
    .replace(/[-_]+/g, ' ')
    .trim();

  if (!text) return store ? `Товар ${store.label}` : 'Товар';
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Метаданные магазина для бейджей в интерфейсе. */
export function storeMetaFromUrl(input) {
  return storeFromUrl(input);
}
