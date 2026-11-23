import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isBlockedPage,
  isOzonProductUrl,
  isOzonShortUrl,
  normalizeOzonUrl,
  normalizeProductUrl,
  isProductUrl,
  parsePriceValue,
  parseProductFromHtml,
  parseWbApi,
  productIdFromUrl,
  titleFromUrl,
  skuFromUrl,
  storeIdFromUrl
} from '../src/lib/parse.js';

import {
  applyPrice,
  computeStats,
  createItem,
  normalizeItemStore,
  priceSnapshot,
  sanitizeSettings,
  statsForRange
} from '../src/lib/shared.js';

const PRODUCT_URL = 'https://www.ozon.ru/product/poco-smartfon-poco-x7-pro-5g-1234567890/?at=abc';

const HTML_JSON_LD = `<!doctype html>
<html><head>
  <title>Смартфон POCO X7 Pro — купить по низкой цене | OZON</title>
  <script type="application/ld+json">
    {
      "@context": "https://schema.org",
      "@type": "Product",
      "name": "Смартфон POCO X7 Pro 5G 8/256 ГБ",
      "image": ["https://cdn1.ozone.ru/s3/product.jpg"],
      "offers": {
        "@type": "Offer",
        "price": "20230",
        "priceCurrency": "RUB",
        "availability": "https://schema.org/InStock"
      }
    }
  </script>
  <meta property="og:title" content="Запасной заголовок" />
  <meta property="og:image" content="https://cdn1.ozone.ru/s3/og.jpg" />
</head><body>ok</body></html>`;

const HTML_GRAPH = `<html><head>
<script type="application/ld+json">
  {"@context":"https://schema.org","@graph":[
    {"@type":"BreadcrumbList","itemListElement":[]},
    {"@type":"Product","name":"Наушники","offers":[{"@type":"Offer","price":"3 499,50","availability":"https://schema.org/OutOfStock"}]}
  ]}
</script></head><body>ok</body></html>`;

const HTML_META = `<html><head>
<script type="application/ld+json">{"@type":"Product","name":"Товар без цены"}</script>
<meta property="product:price:amount" content="1 999" />
</head><body>ok</body></html>`;

const HTML_EMBEDDED = `<html><head><title>Товар</title></head><body>
<script>window.__NUXT__={"cardPrice":{"price":"12 345"},"other":1};</script>
</body></html>`;

test('normalizeOzonUrl принимает ссылки на карточки и отбрасывает остальное', () => {
  assert.equal(
    normalizeOzonUrl(PRODUCT_URL),
    'https://www.ozon.ru/product/poco-smartfon-poco-x7-pro-5g-1234567890/'
  );
  assert.equal(
    normalizeOzonUrl('/product/test-123456/'),
    'https://www.ozon.ru/product/test-123456/'
  );
  assert.equal(
    normalizeOzonUrl('ozon.ru/product/test-123456'),
    'https://www.ozon.ru/product/test-123456/'
  );
  assert.equal(normalizeOzonUrl('https://www.ozon.ru/category/telefony/'), null);
  assert.equal(normalizeOzonUrl('https://example.com/product/123456/'), null);
  assert.equal(normalizeOzonUrl('https://ozon.ru/t/AbCdEf'), null);
  assert.equal(normalizeOzonUrl(''), null);
});

test('короткие ссылки и признаки карточки', () => {
  assert.equal(isOzonShortUrl('https://ozon.ru/t/AbCdEf12'), true);
  assert.equal(isOzonShortUrl('https://www.ozon.ru/product/test-123456/'), false);
  assert.equal(isOzonProductUrl(PRODUCT_URL), true);
  assert.equal(isOzonProductUrl('https://www.ozon.ru/'), false);
});

test('идентификатор и артикул берутся из конца ссылки', () => {
  assert.equal(productIdFromUrl(PRODUCT_URL), 'ozon-1234567890');
  assert.equal(skuFromUrl(PRODUCT_URL), '1234567890');
  const slugOnly = 'https://www.ozon.ru/product/bez-cifr/';
  assert.match(productIdFromUrl(slugOnly), /^url-[a-z0-9]+$/);
  assert.equal(productIdFromUrl(PRODUCT_URL), productIdFromUrl(PRODUCT_URL.replace('?at=abc', '')));
});

test('название из slug читаемое', () => {
  assert.equal(
    titleFromUrl('https://www.ozon.ru/product/poco-smartfon-poco-x7-pro-5g-1234567890/'),
    'Poco smartfon poco x7 pro 5g'
  );
});

test('parsePriceValue понимает пробелы, запятые и тысячи', () => {
  assert.equal(parsePriceValue('20 230 ₽'), 20230);
  assert.equal(parsePriceValue('20\u00a0230\u00a0₽'), 20230);
  assert.equal(parsePriceValue('1 234,56 ₽'), 1234.56);
  assert.equal(parsePriceValue('12 990'), 12990);
  assert.equal(parsePriceValue('19.990'), 19990);
  assert.equal(parsePriceValue('1.234.567'), 1234567);
  assert.equal(parsePriceValue(20230), 20230);
  assert.equal(parsePriceValue('1 000 ₽/мес'), null);
  assert.equal(parsePriceValue('рассрочка 6 месяцев'), null);
  assert.equal(parsePriceValue('₽'), null);
  assert.equal(parsePriceValue('0'), null);
  assert.equal(parsePriceValue(null), null);
});

test('JSON-LD карточки: цена, название, картинка, наличие', () => {
  const product = parseProductFromHtml(HTML_JSON_LD, PRODUCT_URL);
  assert.equal(product.id, 'ozon-1234567890');
  assert.equal(product.url, 'https://www.ozon.ru/product/poco-smartfon-poco-x7-pro-5g-1234567890/');
  assert.equal(product.price, 20230);
  assert.equal(product.title, 'Смартфон POCO X7 Pro 5G 8/256 ГБ');
  assert.equal(product.image, 'https://cdn1.ozone.ru/s3/product.jpg');
  assert.equal(product.inStock, true);
  assert.equal(product.currency, 'RUB');
});

test('JSON-LD @graph и массив offers', () => {
  const product = parseProductFromHtml(HTML_GRAPH, 'https://www.ozon.ru/product/naushniki-555555/');
  assert.equal(product.price, 3499.5);
  assert.equal(product.title, 'Наушники');
  assert.equal(product.inStock, false);
});

test('запасной путь: meta-тег с ценой', () => {
  const product = parseProductFromHtml(HTML_META, 'https://www.ozon.ru/product/tovar-777777/');
  assert.equal(product.price, 1999);
  assert.equal(product.title, 'Товар без цены');
});

test('запасной путь: cardPrice из встроенного JSON', () => {
  const product = parseProductFromHtml(HTML_EMBEDDED, 'https://www.ozon.ru/product/tovar-888888/');
  assert.equal(product.price, 12345);
});

test('страница без цены всё равно отдаёт название из slug', () => {
  const product = parseProductFromHtml('', 'https://www.ozon.ru/product/kofemashina-999999/');
  assert.equal(product.price, null);
  assert.equal(product.title, 'Kofemashina');
  assert.equal(product.id, 'ozon-999999');
});

test('детект страницы-заглушки антибота', () => {
  assert.equal(isBlockedPage('<html><head><title>Доступ ограничен</title></head></html>'), true);
  assert.equal(isBlockedPage('<html><body>Antibot Challenge</body></html>'), true);
  assert.equal(isBlockedPage(HTML_JSON_LD), false);
  assert.equal(isBlockedPage(''), true);
});

test('applyPrice не дублирует одинаковые цены и добавляет изменения', () => {
  const item = {
    id: 'ozon-1',
    title: 'Товар',
    image: null,
    price: 100,
    inStock: true,
    history: [{ t: 1, p: 100, s: 1 }]
  };

  const same = applyPrice(item, { price: 100, title: 'Товар' }, 'fetch', 1000, 4000);
  assert.equal(same.history.length, 1);
  assert.equal(same.lastCheckAt, 1000);

  const lower = applyPrice(same, { price: 90 }, 'fetch', 2000, 4000);
  assert.equal(lower.price, 90);
  assert.equal(lower.history.length, 2);
  assert.deepEqual(lower.history[1], { t: 2000, p: 90, s: 1 });

  const stock = applyPrice(lower, { price: 90, inStock: false }, 'fetch', 3000, 4000);
  assert.equal(stock.history.length, 3);
  assert.equal(stock.history[2].s, 0);

  const limited = applyPrice(stock, { price: 80 }, 'fetch', 4000, 200);
  assert.equal(limited.price, 80);
});

test('computeStats: минимум, максимум и средняя по времени', () => {
  const day = 86_400_000;
  const item = {
    history: [
      { t: 0, p: 100, s: 1 },
      { t: 10 * day, p: 200, s: 1 },
      { t: 15 * day, p: 150, s: 1 }
    ]
  };
  const stats = computeStats(item, undefined, 20 * day);
  assert.equal(stats.min, 100);
  assert.equal(stats.max, 200);
  assert.equal(stats.first, 100);
  assert.equal(stats.last, 150);
  assert.equal(stats.change, 50);
  assert.equal(stats.changePct, 50);
  assert.equal(stats.points, 3);
  // 100 * 10 дней + 200 * 5 дней + 150 * 5 дней = 2750 / 20 = 137.5
  assert.equal(stats.avg, 137.5);
});

test('statsForRange отсекает старые точки и тянет предыдущую', () => {
  const day = 86_400_000;
  const now = 100 * day;
  const item = {
    history: [
      { t: 10 * day, p: 180, s: 1 },
      { t: 90 * day, p: 250, s: 1 },
      { t: 99 * day, p: 200, s: 1 }
    ]
  };
  const stats = statsForRange(item, 30, now);
  assert.equal(stats.min, 180);
  assert.equal(stats.max, 250);
  assert.equal(stats.points, 3);
  assert.equal(statsForRange(item, 'all', now).min, 180);
  assert.equal(statsForRange(item, 7, now).points, 2);
});

test('priceSnapshot показывает текущую и предыдущую цену', () => {
  const snapshot = priceSnapshot({
    price: 90,
    history: [
      { t: 1, p: 120 },
      { t: 2, p: 100 },
      { t: 3, p: 90 }
    ]
  });
  assert.equal(snapshot.current, 90);
  assert.equal(snapshot.previous, 100);
  assert.equal(snapshot.first, 120);
  assert.equal(snapshot.points, 3);
});

test('createItem строит корректную модель', () => {
  const item = createItem(
    {
      url: PRODUCT_URL,
      title: 'Тестовый товар',
      price: 20230,
      targetPrice: 19000,
      image: 'https://cdn1.ozone.ru/x.jpg',
      inStock: true
    },
    { historyLimit: 4000 }
  );
  assert.equal(item.id, 'ozon-1234567890');
  assert.equal(item.price, 20230);
  assert.equal(item.targetPrice, 19000);
  assert.equal(item.status, 'ok');
  assert.equal(item.history.length, 1);
  assert.equal(item.history[0].p, 20230);
});

test('sanitizeSettings ограничивает значения', () => {
  const settings = sanitizeSettings({
    intervalMinutes: 1,
    notifyPercent: 500,
    historyLimit: 999999,
    notifyOnDrop: 0,
    tabFallback: 'yes'
  });
  assert.equal(settings.intervalMinutes, 15);
  assert.equal(settings.notifyPercent, 90);
  assert.equal(settings.historyLimit, 10000);
  assert.equal(settings.notifyOnDrop, false);
  assert.equal(settings.tabFallback, true);

  const fallback = sanitizeSettings({});
  assert.equal(fallback.intervalMinutes, 360);
  assert.equal(fallback.notifyPercent, 3);
  assert.equal(fallback.tabFallback, true);
});

/* ------------------------------ другие магазины ------------------------------ */

const WB_URL = 'https://www.wildberries.ru/catalog/14890618/detail.aspx?targetUrl=GP';
const GA_URL = 'https://goldapple.ru/80790100005-amber';
const LETU_URL = 'https://www.letu.ru/product/essence-tush-dlya-resnits-maximum-definition/153801007?utm=1';

test('ссылки Wildberries, Золотого яблока и Летуаль нормализуются', () => {
  assert.equal(skuFromUrl(WB_URL), '14890618');
  assert.equal(normalizeProductUrl(WB_URL), 'https://www.wildberries.ru/catalog/14890618/detail.aspx');
  assert.equal(productIdFromUrl(WB_URL), 'wb-14890618');
  assert.equal(titleFromUrl(WB_URL), 'Товар Wildberries');

  assert.equal(skuFromUrl(GA_URL + '/'), '80790100005');
  assert.equal(normalizeProductUrl(GA_URL + '/'), 'https://goldapple.ru/80790100005-amber');
  assert.equal(productIdFromUrl(GA_URL), 'goldapple-80790100005');
  assert.equal(titleFromUrl(GA_URL), 'Amber');

  assert.equal(skuFromUrl(LETU_URL), '153801007');
  assert.equal(
    normalizeProductUrl(LETU_URL),
    'https://www.letu.ru/product/essence-tush-dlya-resnits-maximum-definition/153801007'
  );
  assert.equal(productIdFromUrl(LETU_URL), 'letu-153801007');
  assert.equal(titleFromUrl(LETU_URL), 'Essence tush dlya resnits maximum definition');
});

test('isProductUrl отличает карточки от каталогов и поиска', () => {
  assert.equal(isProductUrl(WB_URL), true);
  assert.equal(isProductUrl('https://www.wildberries.ru/catalog/0/search.aspx'), false);
  assert.equal(isProductUrl(GA_URL), true);
  assert.equal(isProductUrl('https://goldapple.ru/makijazh'), false);
  assert.equal(isProductUrl(LETU_URL), true);
  assert.equal(isProductUrl('https://www.letu.ru/category/uhod'), false);
  assert.equal(isProductUrl(PRODUCT_URL), true);
  assert.equal(storeIdFromUrl(LETU_URL), 'letu');
  assert.equal(storeIdFromUrl('https://example.com/product/x/12345'), null);
  assert.equal(normalizeOzonUrl(WB_URL), null);
});

test('parseWbApi переводит копейки в рубли и читает наличие', () => {
  const product = parseWbApi({
    data: {
      products: [
        {
          id: 14890618,
          name: 'Джоггеры спортивные',
          brand: 'DreamFit',
          totalQuantity: 5,
          sizes: [{ price: { product: 259900, total: 259900, basic: 359900 } }]
        }
      ]
    }
  });
  assert.deepEqual(product, {
    title: 'DreamFit Джоггеры спортивные',
    price: 2599,
    currency: 'RUB',
    inStock: true,
    sku: '14890618',
    store: 'wb'
  });
  assert.equal(parseWbApi({ data: { products: [] } }), null);

  const soldOut = parseWbApi({
    data: { products: [{ id: 1, name: 'Товар', brand: 'Бренд', totalQuantity: 0, sizes: [] }] }
  });
  assert.equal(soldOut.price, null);
  assert.equal(soldOut.inStock, false);
});

test('JSON-LD и meta на страницах новых магазинов', () => {
  const wbHtml = `<html><head>
    <title>Купить Джоггеры DreamFit | Wildberries</title>
    <script type="application/ld+json">{"@type":"Product","name":"Джоггеры DreamFit спортивные","image":"https://basket.example/1.webp","offers":{"@type":"Offer","price":"2599","availability":"https://schema.org/InStock"}}</script>
  </head><body></body></html>`;
  const wb = parseProductFromHtml(wbHtml, WB_URL);
  assert.equal(wb.store, 'wb');
  assert.equal(wb.id, 'wb-14890618');
  assert.equal(wb.price, 2599);
  assert.equal(wb.title, 'Джоггеры DreamFit спортивные');

  const letuHtml = `<html><head>
    <meta property="og:title" content="DR. CEURACLE Пенка для умывания &quot;Чайное дерево&quot; Tea Tree Purifine 30 купить по цене 2917₽ в ЛЭТУАЛЬ">
    <meta property="priceCurrency" content="RUB">
    <meta property="og:image" content="https://static.letu.ru/x.jpg">
  </head><body></body></html>`;
  const letu = parseProductFromHtml(letuHtml, LETU_URL);
  assert.equal(letu.store, 'letu');
  assert.equal(letu.price, null);
  assert.equal(letu.title, 'DR. CEURACLE Пенка для умывания "Чайное дерево" Tea Tree Purifine 30');
  assert.equal(letu.image, 'https://static.letu.ru/x.jpg');

  const gaHtml = `<html><head><title>Prada Парфюмерная вода Amber 80 мл — купить, цена в Москве</title></head><body></body></html>`;
  const ga = parseProductFromHtml(gaHtml, GA_URL);
  assert.equal(ga.store, 'goldapple');
  assert.equal(ga.title, 'Prada Парфюмерная вода Amber 80 мл');
});

test('страница проверки Gold Apple считается блокировкой', () => {
  assert.equal(
    isBlockedPage('<html><head><title>Gold Apple — checking device</title></head></html>'),
    true
  );
});

test('createItem сохраняет магазин, а миграция добавляет store старым записям', () => {
  const wbItem = createItem({ url: WB_URL, title: 'Джоггеры', price: 2599 }, { historyLimit: 4000 });
  assert.equal(wbItem.store, 'wb');
  assert.equal(wbItem.id, 'wb-14890618');
  assert.equal(wbItem.price, 2599);

  const migrated = normalizeItemStore({
    id: 'ozon-1',
    url: 'https://www.letu.ru/product/test/153801007',
    title: 'Товар'
  });
  assert.equal(migrated.store, 'letu');
  assert.equal(migrated.id, 'ozon-1');

  const oldOzon = normalizeItemStore({ id: 'ozon-2', url: PRODUCT_URL, title: 'Товар' });
  assert.equal(oldOzon.store, 'ozon');
});
