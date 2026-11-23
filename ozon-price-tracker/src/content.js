/* Price Tracker — плашка на карточке товара (изолированный мир). */
(() => {
  if (window.__priceTrackerInjected || window.__ozonPriceTrackerInjected) return;
  window.__priceTrackerInjected = true;
  window.__ozonPriceTrackerInjected = true;

  const RETRY_DELAYS = [700, 1200, 2000, 3000, 4500, 6000, 8000, 10000, 12000, 15000, 15000];
  const state = {
    product: null,
    item: null,
    tracked: false,
    hidden: false,
    attempts: 0,
    retryTimer: null,
    host: null,
    shadow: null,
    pollTimer: null,
    url: location.href,
    toastTimer: null,
    metaSent: false,
    composition: null,
    compositionScans: 0,
    compositionTried: false,
    analysis: null,
    inciOpen: false
  };

  const STORE_DEFS = [
    {
      id: 'ozon',
      label: 'Ozon',
      short: 'O',
      color: '#005bff',
      host: 'ozon.ru',
      isProduct: (path) => /^\/product\/[^/]+/i.test(path)
    },
    {
      id: 'wb',
      label: 'Wildberries',
      short: 'WB',
      color: '#cb11ab',
      host: 'wildberries.ru',
      isProduct: (path) => /^\/catalog\/\d{4,}\/detail\.aspx\/?$/i.test(path)
    },
    {
      id: 'goldapple',
      label: 'Золотое яблоко',
      short: 'ЗЯ',
      color: '#c99a12',
      host: 'goldapple.ru',
      isProduct: (path) => /^\/\d{6,}(?:-[^/]+)?\/?$/i.test(path)
    },
    {
      id: 'letu',
      label: 'Летуаль',
      short: 'ЛЭ',
      color: '#e4002b',
      host: 'letu.ru',
      isProduct: (path) => /^\/product\/[^/]+\/\d{4,}\/?$/i.test(path)
    }
  ];

  function hostMatches(hostname, host) {
    const clean = String(hostname || '')
      .toLowerCase()
      .replace(/^www\./, '')
      .replace(/^m\./, '');
    return clean === host || clean.endsWith('.' + host);
  }

  function storeDef(input = location.href) {
    let url;
    try {
      url = new URL(input, location.origin);
    } catch {
      return null;
    }
    const def = STORE_DEFS.find((store) => hostMatches(url.hostname, store.host));
    if (!def || !def.isProduct(url.pathname)) return null;
    return def;
  }

  function normalizeStoreUrl(def, input = location.href) {
    const url = new URL(input, location.origin);
    const path = url.pathname.replace(/\/+$/, '');
    if (def.id === 'ozon') return 'https://www.ozon.ru' + path + '/';
    if (def.id === 'wb') {
      const match = path.match(/^\/catalog\/(\d{4,})\/detail\.aspx$/i);
      return match ? `https://www.wildberries.ru/catalog/${match[1]}/detail.aspx` : null;
    }
    if (def.id === 'goldapple') return 'https://goldapple.ru' + path;
    if (def.id === 'letu') return 'https://www.letu.ru' + path;
    return null;
  }

  const PANEL_CSS = `
    :host { all: initial; }
    .card {
      width: 304px;
      color: #e9effb;
      background: linear-gradient(165deg, rgba(15,25,44,.98), rgba(8,14,27,.98));
      border: 1px solid rgba(116,160,255,.2);
      border-radius: 14px;
      box-shadow: 0 18px 50px rgba(0,0,0,.55), inset 0 1px 0 rgba(255,255,255,.04);
      font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
      overflow: hidden;
      backdrop-filter: blur(14px);
      -webkit-font-smoothing: antialiased;
    }
    * { box-sizing: border-box; }
    .head {
      display: flex; align-items: center; justify-content: space-between;
      padding: 10px 10px 10px 12px;
      border-bottom: 1px solid rgba(255,255,255,.06);
    }
    .brand { display: flex; align-items: center; gap: 9px; min-width: 0; }
    .logo {
      flex: none; min-width: 27px; height: 27px; padding: 0 4px; border-radius: 8px;
      background: linear-gradient(140deg, #005bff 10%, #22d3a5 100%);
      color: #fff; font-weight: 800; font-size: 12px;
      display: flex; align-items: center; justify-content: center;
      box-shadow: 0 4px 12px rgba(0,0,0,.28);
    }
    .brand b { display: block; font-size: 12.5px; font-weight: 700; letter-spacing: .1px; color: #f2f6ff; }
    .brand small { display: block; font-size: 10.5px; color: #8ea0bd; margin-top: 1px; }
    .close {
      appearance: none; border: 0; background: transparent; color: #7f90ac;
      font-size: 20px; line-height: 1; width: 28px; height: 28px; border-radius: 7px; cursor: pointer;
      display: flex; align-items: center; justify-content: center; padding: 0;
    }
    .close:hover { background: rgba(255,255,255,.08); color: #fff; }
    .body { padding: 12px; }
    .price-line { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .price { font-size: 24px; font-weight: 800; letter-spacing: -.5px; color: #fff; }
    .chip {
      font-size: 11px; font-weight: 700; border-radius: 999px; padding: 2px 7px;
    }
    .chip.good { background: rgba(34,211,165,.14); color: #34dba9; }
    .chip.bad { background: rgba(255,107,107,.14); color: #ff8a8a; }
    .chip.warn { background: rgba(245,158,11,.16); color: #fbbf24; }
    .chip.neutral { background: rgba(148,163,184,.16); color: #cbd5e1; }
    .sub { margin-top: 5px; font-size: 11.5px; color: #8ea0bd; }
    .sub b { color: #c9d7ef; font-weight: 600; }
    .title { margin-top: 7px; font-size: 11.5px; color: #9fb0ca; max-height: 34px; overflow: hidden; }
    .cta {
      margin-top: 11px; width: 100%; appearance: none; border: 0; cursor: pointer;
      color: #fff; font: 600 13px/1 inherit; font-family: inherit;
      background: linear-gradient(135deg, #005bff, #2f7bff);
      border-radius: 10px; padding: 11px 12px;
      box-shadow: 0 8px 20px rgba(0,91,255,.32);
      transition: filter .15s ease, transform .1s ease;
    }
    .cta:hover { filter: brightness(1.08); }
    .cta:active { transform: translateY(1px); }
    .cta[disabled] { opacity: .55; cursor: default; filter: none; box-shadow: none; }
    .row { display: flex; gap: 7px; margin-top: 11px; }
    .ghost {
      flex: 1; appearance: none; cursor: pointer; font: 600 12px/1 inherit; font-family: inherit;
      color: #cdd9ee; background: rgba(255,255,255,.055);
      border: 1px solid rgba(255,255,255,.08); border-radius: 9px; padding: 9px 8px;
    }
    .ghost:hover { background: rgba(255,255,255,.1); color: #fff; }
    .ghost.danger { flex: 0 0 auto; color: #ff9b9b; border-color: rgba(255,107,107,.18); }
    .ghost.danger:hover { background: rgba(255,107,107,.12); color: #ffb3b3; }
    .inci { margin-top: 10px; padding-top: 9px; border-top: 1px solid rgba(255,255,255,.07); }
    .inci-head {
      display: flex; align-items: center; gap: 7px; width: 100%;
      appearance: none; border: 0; background: transparent; padding: 0;
      color: inherit; font: inherit; text-align: left; cursor: pointer;
    }
    .inci-head:hover .inci-sum { color: #dfe8f7; }
    .inci-sum { flex: 1; min-width: 0; font-size: 11px; color: #93a4c1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .inci-caret { flex: none; color: #7183a1; font-size: 11px; }
    .inci-list {
      margin-top: 8px; max-height: 186px; overflow: auto; padding-right: 4px;
      display: flex; flex-direction: column; gap: 7px;
    }
    .inci-list::-webkit-scrollbar { width: 6px; }
    .inci-list::-webkit-scrollbar-thumb { background: rgba(148,163,184,.28); border-radius: 999px; }
    .inci-item { font-size: 11px; line-height: 1.35; }
    .inci-name { color: #e2eaf8; font-weight: 600; }
    .inci-tag {
      display: inline-block; margin-left: 5px; padding: 1px 5px; border-radius: 999px;
      font-size: 9.5px; font-weight: 700; vertical-align: 1px;
    }
    .inci-tag.bad { background: rgba(255,107,107,.15); color: #ff9b9b; }
    .inci-tag.warn { background: rgba(245,158,11,.16); color: #fbbf24; }
    .inci-tag.good { background: rgba(34,211,165,.14); color: #34dba9; }
    .inci-tag.neutral { background: rgba(148,163,184,.14); color: #b8c4d8; }
    .inci-note { margin-top: 2px; color: #8b9bb6; font-size: 10.5px; line-height: 1.4; }
    .inci-foot { margin-top: 8px; font-size: 10px; color: #66768f; }
    .inci-scan { margin-top: 10px; width: 100%; }
    .toast {
      margin: 0 12px 12px; padding: 8px 10px; border-radius: 8px;
      background: rgba(34,211,165,.12); border: 1px solid rgba(34,211,165,.25);
      color: #57e6bb; font-size: 11.5px; font-weight: 600;
    }
    .toast[hidden] { display: none; }
    .toast.error { background: rgba(255,107,107,.12); border-color: rgba(255,107,107,.28); color: #ffa1a1; }
    .foot { padding: 0 12px 12px; font-size: 10.5px; color: #64748b; }
  `;

  function parsePrice(text) {
    if (!text) return null;
    const source = String(text);
    if (/\/\s*мес|в\s*месяц|рассрочк|доставк|за\s*1\s*шт/i.test(source)) return null;
    let digits = source.replace(/[^\d.,]/g, '');
    if (!digits) return null;

    const lastComma = digits.lastIndexOf(',');
    const lastDot = digits.lastIndexOf('.');
    if (lastComma > -1 && lastDot > -1) {
      digits = lastComma > lastDot ? digits.replace(/\./g, '').replace(/,/g, '.') : digits.replace(/,/g, '');
    } else if (lastComma > -1) {
      const parts = digits.split(',');
      digits = parts.length === 2 && parts[1].length !== 3 ? digits.replace(/,/g, '.') : digits.replace(/,/g, '');
    } else if (lastDot > -1) {
      const parts = digits.split('.');
      if (parts.length > 1 && parts.slice(1).every((part) => part.length === 3)) digits = parts.join('');
    }

    const number = Number.parseFloat(digits);
    if (!Number.isFinite(number) || number <= 0 || number > 100_000_000) return null;
    return Math.round(number * 100) / 100;
  }

  function decodeEntities(text) {
    if (!text) return '';
    return String(text).replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, code) => {
      const lower = String(code).toLowerCase();
      if (lower[0] === '#') {
        const isHex = lower[1] === 'x';
        const num = parseInt(lower.slice(isHex ? 2 : 1), isHex ? 16 : 10);
        try {
          return Number.isFinite(num) ? String.fromCodePoint(num) : whole;
        } catch {
          return whole;
        }
      }
      const map = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };
      return map[lower] ?? whole;
    });
  }

  function cleanTitle(value, storeId) {
    if (!value) return null;
    let text = decodeEntities(String(value)).replace(/\s+/g, ' ').trim();
    text = text
      .replace(/\s*[|—–-]\s*(купить|заказать|интернет-магазин|ozon|wildberries|золотое яблоко|лэтуаль).*$/i, '')
      .replace(/\s*купить по (низкой |низким )?цен[еаы]м?.*$/i, '')
      .replace(/\s*купить со скидкой.*$/i, '')
      .replace(/\s*по цене [\d\s\u00a0.,]+₽.*$/i, '')
      .replace(/\s*[—–,]\s*купить.*$/i, '')
      .replace(/^(нет в наличии|в наличии)\s+/i, '')
      .replace(/^купить\s+/i, '')
      .trim();
    if (storeId === 'wb') text = text.replace(/\s*[|—–]\s*wildberries.*$/i, '').trim();
    return text || null;
  }

  function findProductNode(root) {
    const queue = [{ node: root, depth: 0 }];
    let fallback = null;
    let seen = 0;
    while (queue.length && seen < 2500) {
      const { node, depth } = queue.shift();
      seen++;
      if (!node || typeof node !== 'object' || depth > 8) continue;
      if (Array.isArray(node)) {
        for (const item of node) if (item && typeof item === 'object') queue.push({ node: item, depth: depth + 1 });
        continue;
      }
      const type = node['@type'];
      const types = (Array.isArray(type) ? type : [type]).map((entry) => String(entry).toLowerCase());
      if (types.includes('product')) {
        if (node.offers) return node;
        fallback = fallback || node;
      }
      for (const key of Object.keys(node)) {
        const value = node[key];
        if (value && typeof value === 'object') queue.push({ node: value, depth: depth + 1 });
      }
    }
    return fallback;
  }

  function priceFromOffers(offers) {
    if (!offers) return null;
    const list = Array.isArray(offers) ? offers : [offers];
    for (const offer of list) {
      if (!offer || typeof offer !== 'object') continue;
      for (const field of ['price', 'lowPrice', 'salePrice']) {
        const price = parsePrice(offer[field]);
        if (price) return price;
      }
    }
    return null;
  }

  function fromJsonLd() {
    let result = null;
    const scripts = document.querySelectorAll('script[type="application/ld+json"]');
    for (const script of scripts) {
      let data;
      try {
        data = JSON.parse(script.textContent || '');
      } catch {
        continue;
      }
      const product = findProductNode(data);
      if (!product) continue;
      const price = priceFromOffers(product.offers);
      const availability = JSON.stringify(product.offers || '').toLowerCase();
      result = {
        title: cleanTitle(product.name, null),
        image: Array.isArray(product.image) ? product.image[0] : product.image || null,
        price,
        description:
          typeof product.description === 'string'
            ? product.description
            : typeof product.description === 'object' && product.description
              ? String(product.description.value || '')
              : null,
        inStock: availability.includes('outofstock') || availability.includes('soldout') ? false : true
      };
      if (price != null) break;
    }
    return result;
  }

  function isStruck(element) {
    let node = element;
    for (let i = 0; i < 4 && node; i++, node = node.parentElement) {
      if (node.tagName === 'DEL' || node.tagName === 'S') return true;
      try {
        const style = getComputedStyle(node);
        if (style && style.textDecorationLine && style.textDecorationLine.includes('line-through')) return true;
      } catch {
        /* ignore */
      }
    }
    return false;
  }

  const PRICE_TEXT = /^[\d\s\u00a0\u202f.,]+\s*(₽|руб\.?)$/i;

  function leafPrices(scope) {
    const found = [];
    if (!scope) return found;
    const nodes = scope.querySelectorAll('span, div, p, b, strong, ins, a');
    for (const element of nodes) {
      if (element.children.length > 2) continue;
      const text = (element.textContent || '').replace(/\s+/g, ' ').trim();
      if (!text || text.length > 28 || !PRICE_TEXT.test(text)) continue;
      if (isStruck(element)) continue;
      const price = parsePrice(text);
      if (price) found.push(price);
      if (found.length >= 24) break;
    }
    return found;
  }

  /** Цена рядом с заголовком товара — универсальный путь для незнакомой вёрстки. */
  function priceNearHeading() {
    const heading = document.querySelector('h1');
    if (!heading) return null;
    let scope = heading.parentElement;
    for (let depth = 0; depth < 6 && scope && scope !== document.body; depth++, scope = scope.parentElement) {
      const prices = leafPrices(scope);
      if (prices.length) {
        // В карточке обычно сначала старая цена (зачёркнутая и уже отфильтрована),
        // затем текущая. Берём минимальную, чтобы не поймать «цена без скидки».
        prices.sort((a, b) => a - b);
        return prices[0];
      }
    }
    return null;
  }

  function ozonPrice() {
    const roots = [
      document.querySelector('[data-widget="webPrice"]'),
      document.querySelector('[data-widget="webSale"]'),
      document.querySelector('[data-widget="webAddToCart"]')
    ].filter(Boolean);

    if (!roots.length) {
      const heading = document.querySelector('[data-widget="webProductHeading"]');
      if (heading && heading.parentElement) roots.push(heading.parentElement);
    }

    for (const root of roots) {
      const prices = leafPrices(root);
      if (prices.length) {
        prices.sort((a, b) => a - b);
        return prices[0];
      }
    }
    return priceNearHeading();
  }

  function wbPrice() {
    const selectors = [
      'ins.price-block__final-price',
      '[class*="priceBlockFinalPrice"]',
      '[class*="price-block__final-price"]',
      '[class*="finalPrice"]',
      'ins'
    ];
    for (const selector of selectors) {
      const prices = [];
      for (const element of document.querySelectorAll(selector)) {
        if (isStruck(element)) continue;
        const price = parsePrice((element.textContent || '').replace(/\s+/g, ' ').trim());
        if (price) prices.push(price);
      }
      if (prices.length) {
        prices.sort((a, b) => a - b);
        return prices[0];
      }
    }
    return priceNearHeading();
  }

  function letuPrice() {
    for (const element of document.querySelectorAll('[data-at-price]')) {
      const price = parsePrice(element.getAttribute('data-at-price'));
      if (price) return price;
    }
    const current = document.querySelector('.price-block__price-current');
    if (current) {
      const price = parsePrice(current.textContent);
      if (price) return price;
    }
    return priceNearHeading();
  }

  function metaContent(names) {
    for (const name of names) {
      const element =
        document.querySelector(`meta[property="${name}"]`) ||
        document.querySelector(`meta[name="${name}"]`) ||
        document.querySelector(`meta[itemprop="${name}"]`);
      if (element && element.content) return element.content;
    }
    return null;
  }

  function pickTitle(storeId) {
    const heading = document.querySelector('h1');
    const h1 = cleanTitle(heading && heading.textContent, storeId);
    const og = cleanTitle(metaContent(['og:title', 'twitter:title']), storeId);
    const doc = cleanTitle(document.title, storeId);
    if (storeId === 'goldapple') return doc || og || h1;
    if (storeId === 'wb') return h1 || og || doc;
    return h1 || og || doc;
  }

  function detectInStock(storeId, price) {
    if (storeId === 'ozon') {
      if (document.querySelector('[data-widget="webOutOfStock"]')) return false;
      return price != null;
    }
    const mainText = ((document.body && document.body.innerText) || '').slice(0, 3500).toLowerCase();
    if (/снят с продажи|нет в наличии|нет в продаже|товар закончился|распродано/.test(mainText)) return false;
    return price != null;
  }

  function storePrice(storeId, jsonLd) {
    if (storeId === 'ozon') return jsonLd.price != null ? jsonLd.price : ozonPrice();
    if (storeId === 'wb') return wbPrice() ?? jsonLd.price;
    if (storeId === 'letu') return letuPrice() ?? jsonLd.price;
    return priceNearHeading() ?? jsonLd.price;
  }

  function extractProduct() {
    const def = storeDef();
    if (!def) return null;
    const url = normalizeStoreUrl(def);
    if (!url) return null;

    const jsonLd = fromJsonLd() || {};
    const price = storePrice(def.id, jsonLd);

    const title = pickTitle(def.id) || cleanTitle(jsonLd.title, def.id) || null;

    const jsonLdImage =
      jsonLd.image && typeof jsonLd.image === 'object'
        ? jsonLd.image.url || (Array.isArray(jsonLd.image) ? jsonLd.image[0] : null)
        : jsonLd.image;
    let image = metaContent(['og:image', 'twitter:image']) || jsonLdImage || null;
    if (image && typeof image === 'object') image = image.url || null;
    if (image) {
      try {
        image = new URL(image, location.origin).href;
      } catch {
        /* ignore */
      }
    }

    return {
      url,
      store: def.id,
      title: title || null,
      image,
      price: price != null ? price : null,
      currency: 'RUB',
      inStock: detectInStock(def.id, price)
    };
  }

  /* ------------------------------ состав (INCI) ------------------------------ */

  const INCI_HINT = /(?:aqua|water|parfum|fragrance|glycerin|glycerol|alcohol|sodium|acid|extract|oil|butter|wax|glycol|silicone|dimethicone|tocopherol|chloride|ingredients|inci)/i;
  const COMPOSITION_LABEL = /(?:^|[\s\n])(?:состав(?:\s+товара)?|ингредиенты|ingredients|inci)\s*[:\-—]\s*/i;
  const COMPOSITION_STOP = /\b(?:способ применения|меры предосторожности|противопоказания|инструкция по применению|производитель|изготовитель|импорт[её]р|срок годности|условия хранения|страна производства|объ[её]м|вес нетто|бренд|артикул|отзывы|доставка|беречь от детей|состав на)\b/i;
  const COMPOSITION_SELECTORS = [
    '[data-widget="webDescription"]',
    '[data-widget="webCharacteristics"]',
    '[data-widget="webShortCharacteristics"]',
    '.product-details__description',
    '#product-description',
    '.product-params',
    '.collapsible__content',
    '[data-testid*="composition" i]',
    '[class*="composition" i]',
    '.product-detail-info__right-wrap',
    '.product-detail-info-item__content',
    '[itemprop="description"]'
  ];
  const NON_CONTENT_SCOPE = 'header, footer, nav, aside, script, style, [data-price-tracker]';

  function compositionFromText(raw) {
    if (!raw) return null;
    let text = String(raw)
      .replace(/\u00a0/g, ' ')
      .replace(/\r/g, '\n')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{2,}/g, '\n')
      .trim();
    if (text.length < 25 || text.length > 6000) return null;
    if (!INCI_HINT.test(text)) return null;

    const label = text.match(COMPOSITION_LABEL);
    if (label) {
      text = text.slice(label.index + label[0].length).trim();
    } else if (!/^(?:aqua|water|вода)\b/i.test(text)) {
      return null;
    }

    const stop = text.match(COMPOSITION_STOP);
    if (stop && stop.index > 20) text = text.slice(0, stop.index).trim();

    text = text.replace(/^[\s:;,.•·\-–—]+/, '').replace(/[\s,;]+$/, '');
    if (text.length < 25) return null;

    const commas = (text.match(/,/g) || []).length;
    if (commas < 2) return null;

    const sample = text.slice(0, 400);
    const latin = (sample.match(/[A-Za-z]/g) || []).length;
    if (latin / sample.length < 0.35 && !/(?:вода|масло|кислота|экстракт|глицерин)/i.test(sample)) {
      return null;
    }

    return text.slice(0, 20000);
  }

  function compositionCandidates() {
    const found = [];
    const push = (text) => {
      const value = compositionFromText(text);
      if (!value) return;
      const commas = (value.match(/,/g) || []).length;
      found.push({ value, score: commas });
    };

    for (const selector of COMPOSITION_SELECTORS) {
      let nodes;
      try {
        nodes = document.querySelectorAll(selector);
      } catch {
        continue;
      }
      let count = 0;
      for (const node of nodes) {
        if (count++ > 6) break;
        if (node.closest(NON_CONTENT_SCOPE)) continue;
        push(node.innerText || node.textContent);
      }
    }

    const jsonLd = fromJsonLd();
    if (jsonLd && jsonLd.description) push(jsonLd.description);
    push(metaContent(['description', 'og:description']));

    // Универсальный поиск: небольшие блоки с подписью «Состав» или началом INCI-списка.
    const nodes = document.querySelectorAll('div, span, p, li, dd, td, section, article');
    let inspected = 0;
    for (const node of nodes) {
      if (inspected++ > 6000) break;
      if (node.children.length > 12) continue;
      if (node.closest(NON_CONTENT_SCOPE)) continue;
      const text = (node.textContent || '').replace(/\s+/g, ' ').trim();
      if (text.length < 30 || text.length > 6000) continue;
      if (!/(?:состав|ингредиенты|ingredients|inci|aqua|water)/i.test(text)) continue;
      push(text);
      if (found.length >= 12) break;
    }

    found.sort((a, b) => b.score - a.score);
    return found.map((entry) => entry.value);
  }

  function expandCompositionTab() {
    const nodes = document.querySelectorAll(
      '.product-detail-info-item__title, [role="tab"], button, summary, [class*="accordion" i] *'
    );
    for (const node of nodes) {
      const text = (node.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
      if (!/^(?:состав(?:\s+товара)?|ингредиенты|ingredients)$/.test(text)) continue;
      if (node.getAttribute('aria-expanded') === 'true') continue;
      if (node.closest(NON_CONTENT_SCOPE)) continue;
      try {
        node.click();
        return true;
      } catch {
        /* ignore */
      }
    }
    return false;
  }

  async function extractComposition(options = {}) {
    const candidates = compositionCandidates();
    if (candidates.length) return candidates[0];
    if (!options.expand) return null;
    if (!expandCompositionTab()) return null;
    await new Promise((resolve) => setTimeout(resolve, 900));
    const after = compositionCandidates();
    return after.length ? after[0] : null;
  }

  function send(message) {
    return new Promise((resolve) => {
      try {
        if (!chrome.runtime || !chrome.runtime.id) {
          resolve(null);
          return;
        }
        chrome.runtime.sendMessage(message, (response) => {
          if (chrome.runtime.lastError) {
            resolve(null);
            return;
          }
          resolve(response || null);
        });
      } catch {
        resolve(null);
      }
    });
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  const priceFormatter = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 });
  const formatPrice = (value) => (Number.isFinite(value) ? `${priceFormatter.format(value)} ₽` : '—');
  const formatPercent = (value) => {
    if (!Number.isFinite(value)) return '';
    const rounded = Math.abs(value) >= 10 ? Math.round(value) : Math.round(value * 10) / 10;
    return `${rounded > 0 ? '+' : rounded < 0 ? '−' : ''}${Math.abs(rounded).toString().replace('.', ',')}%`;
  };
  const plural = (count, one, few, many) => {
    const abs = Math.abs(count) % 100;
    const last = abs % 10;
    if (abs > 10 && abs < 20) return many;
    if (last === 1) return one;
    if (last >= 2 && last <= 4) return few;
    return many;
  };
  const truncate = (text, max = 90) => {
    const value = String(text || '').replace(/\s+/g, ' ').trim();
    return value.length > max ? value.slice(0, max - 1) + '…' : value;
  };

  function ensurePanel() {
    if (state.host && state.host.isConnected && state.shadow) return state.shadow;
    const host = document.createElement('div');
    host.setAttribute('data-price-tracker', '');
    host.style.cssText = 'all: initial; position: fixed; left: 16px; bottom: 16px; z-index: 2147483647;';
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `<style>${PANEL_CSS}</style><div class="card"></div>`;
    (document.body || document.documentElement).appendChild(host);
    shadow.addEventListener('click', onPanelClick);
    state.host = host;
    state.shadow = shadow;
    return shadow;
  }

  function showToast(text, isError = false) {
    if (!state.shadow) return;
    const toast = state.shadow.querySelector('.toast');
    if (!toast) return;
    toast.textContent = text;
    toast.classList.toggle('error', isError);
    toast.hidden = false;
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => {
      toast.hidden = true;
    }, 3200);
  }

  const INCI_LEVEL_LABELS = { good: 'спокойный', neutral: 'есть нюансы', warn: 'есть риски', bad: 'много рисков' };
  const INCI_LEVEL_CLASS = { good: 'good', neutral: 'neutral', warn: 'warn', bad: 'bad' };
  const INCI_TAG_LABELS = {
    allergen: 'аллерген',
    irritant: 'раздражитель',
    comedogenic: 'комедогенный',
    phototoxic: 'фототоксичность',
    fragrance: 'отдушка',
    alcohol: 'спирт',
    sulfate: 'сульфат',
    controversial: 'спорный',
    preservative: 'консервант',
    botanical: 'экстракт',
    protein: 'протеин',
    conditioner: 'кондиционирует',
    antiperspirant: 'антиперспирант',
    dye: 'краситель',
    fluoride: 'фторид'
  };
  const INCI_WARN_TAGS = ['irritant', 'comedogenic', 'phototoxic', 'fragrance', 'alcohol', 'sulfate'];

  function pageMentionsComposition() {
    const text = ((document.body && document.body.innerText) || '').slice(0, 120000);
    return /(?:^|[\n\r])\s*(?:состав(?:\s+товара)?|ингредиенты|ingredients|inci)\b/i.test(text);
  }

  function inciSummary(analysis) {
    const counts = (analysis && analysis.counts) || {};
    const parts = [];
    if (counts.allergen) {
      parts.push(`${counts.allergen} ${plural(counts.allergen, 'аллерген', 'аллергена', 'аллергенов')}`);
    }
    if (counts.irritant) {
      parts.push(`${counts.irritant} ${plural(counts.irritant, 'раздражитель', 'раздражителя', 'раздражителей')}`);
    }
    if (counts.comedogenic) {
      parts.push(`${counts.comedogenic} ${plural(counts.comedogenic, 'комедогенный', 'комедогенных', 'комедогенных')}`);
    }
    if (!parts.length) {
      const total = analysis && analysis.total ? analysis.total : 0;
      return total ? `${total} ${plural(total, 'компонент', 'компонента', 'компонентов')}` : 'состав найден';
    }
    return parts.join(' · ');
  }

  function renderInci() {
    const analysis = state.analysis;
    const def = storeDef();

    if (!analysis || !analysis.ok) {
      if (state.compositionHint == null) state.compositionHint = pageMentionsComposition();
      const relevant = def && (def.id === 'letu' || def.id === 'goldapple');
      if (!relevant && !state.compositionHint) return '';
      return `<button class="ghost inci-scan" data-act="inci-scan">${
        state.compositionTried ? 'Разобрать состав заново' : 'Разобрать состав'
      }</button>`;
    }

    const verdict = analysis.verdict || {};
    const level = INCI_LEVEL_CLASS[verdict.level] || 'neutral';
    const label = INCI_LEVEL_LABELS[verdict.level] || INCI_LEVEL_LABELS.neutral;

    let list = '';
    if (state.inciOpen) {
      const items = (analysis.ingredients || []).slice(0, 80).map((ingredient) => {
        const tags = (ingredient.tags || [])
          .filter((tag) => INCI_TAG_LABELS[tag])
          .map((tag) => {
            const severity = tag === 'allergen' ? 'bad' : INCI_WARN_TAGS.includes(tag) ? 'warn' : 'neutral';
            return `<span class="inci-tag ${severity}">${escapeHtml(INCI_TAG_LABELS[tag])}</span>`;
          })
          .join('');
        const note = ingredient.note ? `<div class="inci-note">${escapeHtml(ingredient.note)}</div>` : '';
        return `<div class="inci-item"><span class="inci-name">${escapeHtml(ingredient.name)}</span>${tags}${note}</div>`;
      });
      list = `<div class="inci-list">${items.join('')}</div>
        <div class="inci-foot">${escapeHtml(
          verdict.text || ''
        )} Это справочная оценка, а не медицинская рекомендация.</div>`;
    }

    return `<div class="inci">
      <button class="inci-head" data-act="inci-toggle" aria-expanded="${state.inciOpen ? 'true' : 'false'}">
        <span class="chip ${level}">Состав: ${escapeHtml(label)}</span>
        <span class="inci-sum" title="${escapeHtml(inciSummary(analysis))}">${escapeHtml(inciSummary(analysis))}</span>
        <span class="inci-caret">${state.inciOpen ? '▴' : '▾'}</span>
      </button>
      ${list}
    </div>`;
  }

  function renderPanel() {
    if (state.hidden || !state.product || !state.product.price) {
      teardownPanel();
      return;
    }
    const shadow = ensurePanel();
    const card = shadow.querySelector('.card');
    if (!card) return;

    const def = storeDef() || STORE_DEFS[0];
    const stats = state.item && state.item.stats ? state.item.stats : null;
    const price = state.product.price;
    const first = stats && Number.isFinite(stats.first) ? stats.first : null;
    const delta = first ? ((price - first) / first) * 100 : null;
    const tracked = state.tracked;
    const min = stats && Number.isFinite(stats.min) ? stats.min : null;
    const points = stats && stats.points ? stats.points : 0;

    const subtitle = tracked
      ? min != null
        ? `Минимум: <b>${escapeHtml(formatPrice(min))}</b> · ${points} ${plural(points, 'точка', 'точки', 'точек')}`
        : 'Ждём первую цену'
      : 'Добавьте товар и следите за снижением';

    const deltaChip =
      tracked && delta != null && Math.abs(delta) >= 0.1
        ? `<span class="chip ${delta < 0 ? 'good' : 'bad'}">${escapeHtml(formatPercent(delta))}</span>`
        : '';

    card.innerHTML = `
      <div class="head">
        <div class="brand">
          <span class="logo" style="background:linear-gradient(140deg, ${def.color} 10%, rgba(255,255,255,.22) 130%)">${escapeHtml(
            def.short
          )}</span>
          <span>
            <b>Price Tracker</b>
            <small>${escapeHtml(def.label)} · ${tracked ? 'отслеживается' : 'история цен'}</small>
          </span>
        </div>
        <button class="close" data-act="hide" title="Скрыть">×</button>
      </div>
      <div class="body">
        <div class="price-line">
          <span class="price">${escapeHtml(formatPrice(price))}</span>
          ${deltaChip}
        </div>
        <div class="sub">${subtitle}</div>
        ${
          tracked
            ? `<div class="row">
                 <button class="ghost" data-act="open">История цен</button>
                 <button class="ghost danger" data-act="remove">Убрать</button>
               </div>`
            : `<button class="cta" data-act="track">Отслеживать цену</button>
               <div class="title">${escapeHtml(truncate(state.product.title, 90))}</div>`
        }
        ${renderInci()}
      </div>
      <div class="toast" hidden></div>
      <div class="foot">Данные хранятся только в вашем браузере</div>
    `;
  }

  function teardownPanel() {
    if (state.host) {
      state.host.remove();
      state.host = null;
      state.shadow = null;
    }
  }

  async function onPanelClick(event) {
    const target = event.target && event.target.closest ? event.target.closest('[data-act]') : null;
    if (!target) return;
    const action = target.getAttribute('data-act');

    if (action === 'hide') {
      state.hidden = true;
      teardownPanel();
      return;
    }

    if (action === 'inci-toggle') {
      state.inciOpen = !state.inciOpen;
      renderPanel();
      return;
    }

    if (action === 'inci-scan') {
      if (!state.product) return;
      target.disabled = true;
      target.textContent = 'Ищем состав…';
      state.compositionTried = true;
      const composition = await extractComposition({ expand: true });
      if (!composition) {
        renderPanel();
        showToast('Состав не найден на странице', true);
        return;
      }
      state.composition = composition;
      state.product = { ...state.product, composition };
      const response = await send({ type: 'PAGE_PRODUCT', product: state.product });
      if (response) {
        if (response.analysis) state.analysis = response.analysis;
        if (response.tracked && response.item) {
          state.tracked = true;
          state.item = response.item;
        }
      }
      state.inciOpen = true;
      renderPanel();
      showToast('Состав разобран');
      return;
    }

    if (action === 'track') {
      target.disabled = true;
      target.textContent = 'Добавляем…';
      const response = await send({ type: 'ADD_PRODUCT', product: state.product });
      if (response && response.ok) {
        state.tracked = true;
        state.item = response.item || null;
        renderPanel();
        showToast('Товар добавлен в отслеживание');
        setTimeout(() => {
          if (state.shadow) {
            const toast = state.shadow.querySelector('.toast');
            if (toast) toast.hidden = true;
          }
        }, 2600);
      } else {
        target.disabled = false;
        target.textContent = 'Отслеживать цену';
        showToast((response && response.error) || 'Не удалось добавить товар', true);
      }
      return;
    }

    if (action === 'open') {
      if (state.item) await send({ type: 'OPEN_DASHBOARD', id: state.item.id });
      return;
    }

    if (action === 'remove') {
      if (!state.item) return;
      const response = await send({ type: 'REMOVE_ITEM', id: state.item.id });
      if (response && response.ok) {
        state.tracked = false;
        state.item = null;
        renderPanel();
      }
    }
  }

  async function init() {
    if (!storeDef()) {
      teardownPanel();
      return;
    }

    state.attempts++;
    const product = extractProduct();
    if (product && !state.composition && state.compositionScans < 3) {
      state.compositionScans++;
      const composition = await extractComposition();
      if (composition) state.composition = composition;
    }
    if (product && state.composition && !product.composition) {
      product.composition = state.composition;
    }
    if (!product || product.price == null) {
      if (state.attempts <= RETRY_DELAYS.length) {
        scheduleRetry();
        return;
      }
      // Фоновая вкладка ждёт ответа: сообщаем метаданные, чтобы не тянуть таймаут.
      if (product && !state.metaSent) {
        state.metaSent = true;
        const response = await send({ type: 'PAGE_PRODUCT', product });
        if (response) {
          if (response.analysis) state.analysis = response.analysis;
          if (response.tracked && response.item) {
            state.tracked = true;
            state.item = response.item;
          }
        }
      }
      return;
    }

    state.product = product;
    state.metaSent = true;
    const response = await send({ type: 'PAGE_PRODUCT', product });
    if (response && response.analysis) state.analysis = response.analysis;
    if (response && response.tracked && response.item) {
      state.tracked = true;
      state.item = response.item;
    } else {
      state.tracked = false;
      state.item = null;
    }
    if (state.hidden) return;
    renderPanel();
  }

  function scheduleRetry() {
    clearTimeout(state.retryTimer);
    const delay = RETRY_DELAYS[Math.min(state.attempts - 1, RETRY_DELAYS.length - 1)] || 1500;
    state.retryTimer = setTimeout(init, delay);
  }

  async function checkPriceChange() {
    if (!storeDef()) return;
    const product = extractProduct();
    if (!product || product.price == null) return;
    if (state.composition && !product.composition) product.composition = state.composition;

    const changed =
      !state.product ||
      product.price !== state.product.price ||
      product.inStock !== state.product.inStock ||
      product.title !== state.product.title;

    if (!changed) return;
    state.product = product;
    const response = await send({ type: 'PAGE_PRODUCT', product });
    if (response && response.analysis) state.analysis = response.analysis;
    if (response && response.tracked && response.item) {
      state.tracked = true;
      state.item = response.item;
    }
    renderPanel();
  }

  function restart() {
    clearTimeout(state.retryTimer);
    state.attempts = 0;
    state.hidden = false;
    state.product = null;
    state.item = null;
    state.tracked = false;
    state.metaSent = false;
    state.composition = null;
    state.compositionScans = 0;
    state.compositionTried = false;
    state.compositionHint = null;
    state.analysis = null;
    state.inciOpen = false;
    teardownPanel();
    init();
  }

  // Переходы внутри SPA: магазины меняют URL без перезагрузки документа.
  setInterval(() => {
    if (location.href !== state.url) {
      state.url = location.href;
      restart();
    }
  }, 1000);

  // Цена может обновиться после подгрузки виджетов или смены варианта товара.
  setInterval(checkPriceChange, 12_000);

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || typeof message !== 'object') return false;
    if (message.type === 'EXTRACT_NOW') {
      sendResponse({ ok: true, product: extractProduct() });
      return false;
    }
    return false;
  });

  window.addEventListener('pageshow', () => {
    if (!state.host && storeDef()) init();
  });

  init().catch(() => undefined);
})();
