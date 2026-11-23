/**
 * Чистые функции разбора ссылок и HTML карточек магазинов.
 * Не обращаются к chrome API, поэтому могут тестироваться в Node.
 */

import {
  isShortUrl,
  normalizeProductUrl,
  productIdFromUrl,
  skuFromUrl,
  storeFromUrl,
  storeIdFromUrl,
  titleFromUrl
} from './stores.js';

export {
  isProductUrl,
  isShortUrl,
  isStoreUrl,
  normalizeProductUrl,
  productIdFromUrl,
  skuFromUrl,
  storeFromUrl,
  storeIdFromUrl,
  storeMetaFromUrl,
  titleFromUrl,
  STORE_LIST,
  STORES
} from './stores.js';

/** Совместимость со старым API: ссылка именно на карточку Ozon. */
export function normalizeOzonUrl(input) {
  return storeIdFromUrl(input) === 'ozon' ? normalizeProductUrl(input) : null;
}

export function isOzonProductUrl(input) {
  return normalizeOzonUrl(input) !== null;
}

export function isOzonUrl(input) {
  return storeIdFromUrl(input) === 'ozon';
}

export function isOzonShortUrl(input) {
  return storeIdFromUrl(input) === 'ozon' && isShortUrl(input);
}

const ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0'
};

export function decodeEntities(value) {
  if (!value) return '';
  return String(value).replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, code) => {
    const lower = String(code).toLowerCase();
    if (lower[0] === '#') {
      const isHex = lower[1] === 'x';
      const num = parseInt(lower.slice(isHex ? 2 : 1), isHex ? 16 : 10);
      if (Number.isFinite(num) && num > 0 && num <= 0x10ffff) {
        try {
          return String.fromCodePoint(num);
        } catch {
          return whole;
        }
      }
      return whole;
    }
    return ENTITIES[lower] ?? whole;
  });
}

const roundPrice = (n) => Math.round(n * 100) / 100;

/** "20 230,50 ₽" -> 20230.5, "19.990" -> 19990. */
export function parsePriceValue(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? roundPrice(value) : null;
  }
  if (value == null) return null;

  const text = String(value).trim();
  if (!text) return null;
  // "от 1 000 ₽/мес" — это не цена товара.
  if (/\/\s*(мес|месяц)|в\s*месяц|рассрочк/i.test(text)) return null;

  let digits = text.replace(/[^\d.,]/g, '');
  if (!digits) return null;

  const lastComma = digits.lastIndexOf(',');
  const lastDot = digits.lastIndexOf('.');

  if (lastComma > -1 && lastDot > -1) {
    if (lastComma > lastDot) {
      digits = digits.replace(/\./g, '').replace(/,/g, '.');
    } else {
      digits = digits.replace(/,/g, '');
    }
  } else if (lastComma > -1) {
    const parts = digits.split(',');
    const fractional = parts[parts.length - 1];
    const grouped = parts.slice(1, -1).every((part) => part.length === 3);
    if (parts.length > 2 && grouped && fractional.length === 3) {
      digits = parts.join('');
    } else if (fractional.length === 3 && parts.length === 2) {
      digits = digits.replace(/,/g, '');
    } else {
      digits = digits.replace(/,/g, '.');
    }
  } else if (lastDot > -1) {
    const parts = digits.split('.');
    const grouped = parts.slice(1).every((part) => part.length === 3);
    if (parts.length > 1 && grouped) digits = parts.join('');
  }

  const number = Number.parseFloat(digits);
  if (!Number.isFinite(number) || number <= 0 || number > 100_000_000) return null;
  return roundPrice(number);
}

/** Вытаскивает все блоки JSON-LD из HTML. */
export function extractJsonLd(html) {
  const blocks = [];
  if (!html) return blocks;
  const re = /<script[^>]*\btype\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = re.exec(html))) {
    const raw = match[1].trim().replace(/^<!--|-->$/g, '').trim();
    if (!raw) continue;
    try {
      blocks.push(JSON.parse(raw));
    } catch {
      try {
        blocks.push(JSON.parse(decodeEntities(raw)));
      } catch {
        /* битый блок пропускаем */
      }
    }
  }
  return blocks;
}

function nodeTypes(node) {
  const type = node && node['@type'];
  if (!type) return [];
  return (Array.isArray(type) ? type : [type]).map((item) => String(item).toLowerCase());
}

function findProductNode(root) {
  const queue = [{ node: root, depth: 0 }];
  let seen = 0;
  let fallback = null;

  while (queue.length && seen < 4000) {
    const { node, depth } = queue.shift();
    seen++;
    if (!node || typeof node !== 'object' || depth > 8) continue;

    if (!Array.isArray(node)) {
      const types = nodeTypes(node);
      if (types.includes('product')) {
        const hasOffer = Boolean(node.offers);
        if (hasOffer) return node;
        fallback = fallback || node;
      }
      for (const key of Object.keys(node)) {
        const value = node[key];
        if (value && typeof value === 'object') queue.push({ node: value, depth: depth + 1 });
      }
    } else {
      for (const item of node) {
        if (item && typeof item === 'object') queue.push({ node: item, depth: depth + 1 });
      }
    }
  }

  return fallback;
}

function priceFromOffers(offers) {
  if (!offers) return null;
  const list = Array.isArray(offers) ? offers : [offers];
  const fields = ['price', 'lowPrice', 'highPrice', 'salePrice'];
  for (const offer of list) {
    if (!offer || typeof offer !== 'object') continue;
    for (const field of fields) {
      const price = parsePriceValue(offer[field]);
      if (price) return price;
    }
    if (offer.priceSpecification) {
      const price = priceFromOffers(offer.priceSpecification);
      if (price) return price;
    }
  }
  return null;
}

function availableFromOffers(offers) {
  if (!offers) return null;
  const list = Array.isArray(offers) ? offers : [offers];
  for (const offer of list) {
    if (!offer || typeof offer !== 'object') continue;
    const availability = String(offer.availability || offer.itemCondition || '').toLowerCase();
    if (!availability) continue;
    if (availability.includes('outofstock') || availability.includes('soldout')) return false;
    if (availability.includes('instock') || availability.includes('onlineonly') || availability.includes('preorder')) {
      return true;
    }
  }
  return null;
}

function firstImage(image) {
  if (!image) return null;
  if (typeof image === 'string') return image;
  if (Array.isArray(image)) {
    const found = image.find((item) => typeof item === 'string' || (item && typeof item.url === 'string'));
    if (!found) return null;
    return typeof found === 'string' ? found : found.url;
  }
  if (typeof image === 'object' && typeof image.url === 'string') return image.url;
  return null;
}

/** Убирает магазинные хвосты из заголовка. */
export function cleanTitle(value, storeId) {
  if (!value) return null;
  let text = decodeEntities(String(value)).replace(/\s+/g, ' ').trim();
  text = text
    .replace(/\s*[|—–-]\s*(купить|заказать|интернет-магазин|ozon|wildberries|золотое яблоко|лэтуаль).*$/i, '')
    .replace(/\s*купить по (низкой |низким )?цен[еаы]м?.*$/i, '')
    .replace(/\s*купить со скидкой.*$/i, '')
    .replace(/\s*по цене [\d\s\u00a0.,]+₽.*$/i, '')
    .replace(/\s*[—–]\s*купить.*$/i, '')
    .replace(/^(нет в наличии|в наличии)\s+/i, '')
    .replace(/^купить\s+/i, '')
    .trim();
  if (storeId === 'wb') text = text.replace(/\s*[|—–]\s*wildberries.*$/i, '').trim();
  return text || null;
}

function parseAttributes(tag) {
  const attrs = {};
  const re = /([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  let match;
  while ((match = re.exec(tag))) {
    attrs[match[1].toLowerCase()] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? '');
  }
  return attrs;
}

function getMetaContent(html, names) {
  if (!html) return null;
  const wanted = new Set(names.map((name) => name.toLowerCase()));
  const re = /<meta\b[^>]*>/gi;
  let match;
  while ((match = re.exec(html))) {
    const attrs = parseAttributes(match[0]);
    const key = (attrs.property || attrs.name || attrs.itemprop || '').toLowerCase();
    if (key && wanted.has(key) && attrs.content) return attrs.content;
  }
  return null;
}

function getTitleTag(html) {
  const match = html && html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? decodeEntities(match[1]).replace(/\s+/g, ' ').trim() : null;
}

/** Признак страницы-заглушки антибота. */
export function isBlockedPage(html) {
  if (!html) return true;
  const head = html.slice(0, 250_000).toLowerCase();
  if (head.includes('<title>доступ ограничен')) return true;
  if (head.includes('доступ к сайту ограничен')) return true;
  if (head.includes('доступ ограничен') && head.includes('ozon')) return true;
  if (head.includes('подтвердите, что вы не робот')) return true;
  if (head.includes('antibot challenge')) return true;
  if (head.includes('/blocked?') && head.includes('ozon')) return true;
  if (head.includes('cf-browser-verification')) return true;
  if (head.includes('checking device')) return true;
  if (head.includes('ddos-guard')) return true;
  return false;
}

/**
 * Разбирает ответ WB card.wb.ru. Цены в API хранятся в копейках.
 * @returns {{title:?string,price:?number,currency:string,inStock:boolean,sku:?string,store:string}|null}
 */
export function parseWbApi(payload) {
  const data = payload && (payload.data || payload);
  const products = data && (data.products || data.list);
  const product = Array.isArray(products) ? products.find((entry) => entry && (entry.id || entry.nmId)) : null;
  if (!product) return null;

  const sizes = Array.isArray(product.sizes) ? product.sizes : [];
  let price = null;

  for (const size of sizes) {
    const values = size && size.price ? [size.price.product, size.price.total, size.price.basic] : [];
    const raw = values.find((entry) => Number.isFinite(entry) && entry > 0);
    if (Number.isFinite(raw)) {
      price = roundPrice(raw / 100);
      break;
    }
  }

  if (price == null) {
    const raw = [product.salePriceU, product.priceU].find((entry) => Number.isFinite(entry) && entry > 0);
    if (Number.isFinite(raw)) price = roundPrice(raw / 100);
  }

  const name = String(product.name || '').trim();
  const brand = String(product.brand || '').trim();
  let title = name;
  if (brand && name && !name.toLowerCase().startsWith(brand.toLowerCase())) title = `${brand} ${name}`;
  if (!title) title = brand || null;

  const quantity = Number(product.totalQuantity ?? product.quantity);
  const inStock = Number.isFinite(quantity) ? quantity > 0 : price != null;

  return {
    title,
    price,
    currency: 'RUB',
    inStock,
    sku: String(product.id || product.nmId || '') || null,
    store: 'wb'
  };
}

/**
 * Разбирает HTML карточки: JSON-LD -> meta -> встроенные JSON-поля -> slug.
 * @returns {{url:string,id:string,sku:?string,store:?string,title:string,image:?string,price:?number,currency:string,inStock:boolean}}
 */
export function parseProductFromHtml(html, pageUrl) {
  const storeId = storeIdFromUrl(pageUrl);
  const url = normalizeProductUrl(pageUrl) || String(pageUrl || '');
  const result = {
    url,
    id: productIdFromUrl(url),
    sku: skuFromUrl(url),
    store: storeId,
    title: null,
    image: null,
    price: null,
    currency: 'RUB',
    inStock: true
  };

  for (const block of extractJsonLd(html)) {
    const product = findProductNode(block);
    if (!product) continue;

    if (!result.title) result.title = cleanTitle(product.name, storeId);
    if (!result.image) result.image = firstImage(product.image);
    if (result.price == null) result.price = priceFromOffers(product.offers);

    const available = availableFromOffers(product.offers);
    if (available !== null) result.inStock = available;
    if (result.price != null) break;
  }

  if (!result.title) result.title = cleanTitle(getMetaContent(html, ['og:title', 'twitter:title']), storeId);
  if (!result.image) result.image = getMetaContent(html, ['og:image', 'twitter:image', 'image']);
  if (result.price == null) {
    result.price = parsePriceValue(
      getMetaContent(html, ['product:price:amount', 'og:price:amount', 'twitter:data1', 'price'])
    );
  }

  if (result.price == null) {
    const patterns = [
      /"cardPrice"\s*:\s*\{[^{}]*?"price"\s*:\s*"?([\d\s\u00a0.,]+)"?/i,
      /"cardPrice"\s*:\s*"?([\d\s\u00a0.,]+)"?/i,
      /"currentPrice"\s*:\s*\{[^{}]*?"price"\s*:\s*"?([\d\s\u00a0.,]+)"?/i,
      /"price"\s*:\s*"?(\d[\d\s\u00a0]{2,})\s*₽"?/i
    ];
    for (const re of patterns) {
      const match = html && html.match(re);
      const price = match ? parsePriceValue(match[1]) : null;
      if (price) {
        result.price = price;
        break;
      }
    }
  }

  if (result.price == null && storeId === 'wb') {
    const match = html && (html.match(/"salePriceU"\s*:\s*(\d{4,})/i) || html.match(/"priceU"\s*:\s*(\d{4,})/i));
    if (match) result.price = roundPrice(Number(match[1]) / 100);
  }

  if (!result.title) result.title = cleanTitle(getTitleTag(html), storeId);
  if (!result.title) result.title = titleFromUrl(url);

  const live = html && html.slice(0, 400_000);
  if (live && /data-widget\s*=\s*["']webOutOfStock["']/i.test(live)) {
    result.inStock = false;
  }

  result.price = result.price == null ? null : roundPrice(result.price);
  return result;
}

export const __internal = { findProductNode, priceFromOffers, getMetaContent };
