/**
 * UI-smoke для расширения: запускает headless Chrome, загружает распакованное
 * расширение через CDP Extensions.loadUnpacked, наполняет хранилище демо-данными
 * и снимает скриншоты панели и popup.
 *
 * Требуется Chrome 137+ с поддержкой --enable-unsafe-extension-debugging
 * (проверено на Chrome 157).
 *
 * Запуск: node tests/ui-smoke.mjs
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'tests', 'out');
const PORT = Number(process.env.CDP_PORT || 9444);
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PROFILE = path.join(os.tmpdir(), `optr-smoke-${process.pid}`);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function connect(url) {
  const ws = new WebSocket(url);
  let seq = 0;
  const pending = new Map();
  const events = [];
  const handlers = new Map();
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(`${message.error.message} ${JSON.stringify(message.error.data || '')}`));
      else resolve(message.result);
      return;
    }
    events.push(message);
    for (const handler of handlers.get(message.method) || []) {
      Promise.resolve()
        .then(() => handler(message.params))
        .catch(() => undefined);
    }
  });
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('WebSocket error')), { once: true });
  });
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  const on = (method, handler) => {
    if (!handlers.has(method)) handlers.set(method, []);
    handlers.get(method).push(handler);
  };
  return { ws, send, events, ready, on };
}

const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE}`,
    '--enable-unsafe-extension-debugging',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu'
  ],
  { stdio: 'ignore' }
);

async function cleanup(code) {
  // taskkill с /T завершает всё дерево процессов Chrome, иначе профиль
  // остаётся заблокированным и занимает место во временной папке.
  spawnSync('taskkill', ['/pid', String(chrome.pid), '/t', '/f'], { stdio: 'ignore' });
  await sleep(500);
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await fs.rm(PROFILE, { recursive: true, force: true });
      break;
    } catch {
      await sleep(400);
    }
  }
  process.exit(code);
}

let version;
try {
  for (let i = 0; i < 40; i++) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (response.ok) {
        version = await response.json();
        break;
      }
    } catch {
      /* ещё не поднялся */
    }
    await sleep(250);
  }
  if (!version) throw new Error('Chrome не запустился');

  const browser = connect(version.webSocketDebuggerUrl);
  await browser.ready;

  const extension = await browser.send('Extensions.loadUnpacked', { path: ROOT });
  const base = `chrome-extension://${extension.id}`;
  console.log(`Расширение загружено: ${extension.id}`);

  const list = async () => (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json());

  let pageTargetId = null;

  async function openPage(url, width, height) {
    // Переиспользуем стартовую вкладку Chrome: новые вкладки в headless
    // считаются фоновыми, и requestAnimationFrame в них не выполняется.
    if (!pageTargetId) {
      const targets = await list();
      const target = targets.find((entry) => entry.type === 'page' && !entry.url.startsWith('devtools://'));
      if (!target) throw new Error('Не найдена стартовая вкладка Chrome');
      pageTargetId = target.id;
    }
    await browser.send('Target.activateTarget', { targetId: pageTargetId });
    const target = (await list()).find((entry) => entry.id === pageTargetId);
    const page = connect(target.webSocketDebuggerUrl);
    await page.ready;
    await page.send('Page.enable');
    await page.send('Runtime.enable');
    await page.send('Log.enable');
    await page.send('Page.bringToFront');
    await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    await page.send('Page.navigate', { url });
    await sleep(1200);
    return page;
  }

  async function evaluate(page, expression, awaitPromise = false) {
    const result = await page.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  }

  async function waitFor(page, expression, timeout = 6000) {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      if (await evaluate(page, expression)) return true;
      await sleep(150);
    }
    return false;
  }

  function collectErrors(page) {
    return {
      log: page.events
        .filter((event) => event.method === 'Log.entryAdded' && event.params.entry.level === 'error')
        .map((event) => `${event.params.entry.text} @ ${event.params.entry.url || ''}`),
      exceptions: page.events
        .filter((event) => event.method === 'Runtime.exceptionThrown')
        .map((event) => event.params.exceptionDetails.exception?.description || event.params.exceptionDetails.text)
    };
  }

  const dashboard = await openPage(`${base}/src/dashboard.html`, 1440, 900);
  const title = await evaluate(dashboard, 'document.title');
  const runtimeId = await evaluate(dashboard, 'chrome.runtime.id');
  if (runtimeId !== extension.id) throw new Error(`chrome.runtime.id = ${runtimeId}, ожидался ${extension.id}`);
  const emptyStateDisplay = await evaluate(
    dashboard,
    'getComputedStyle(document.getElementById("empty")).display'
  );
  if (emptyStateDisplay === 'none') throw new Error('Пустое состояние панели не показано');

  // Демо-данные: несколько товаров с историей за разные периоды.
  const now = Date.now();
  const day = 86400000;
  const makeHistory = (basePrice, days) => {
    const points = [];
    for (let i = days; i >= 0; i--) {
      const wave = Math.sin(i / 9) * 0.03 + Math.sin(i / 23) * 0.05;
      const value = Math.max(basePrice * 0.72, Math.round(basePrice * (0.95 + wave * 0.5 + (i / days) * 0.18) * 100) / 100);
      points.push({ t: now - i * day, p: value, s: i === 17 ? 0 : 1 });
    }
    points.push({ t: now, p: basePrice, s: 1 });
    return points;
  };
  const INCI_TEXT =
    'AQUA (WATER), GLYCERIN, PARFUM, LIMONENE, SODIUM LAURETH SULFATE, COCOS NUCIFERA OIL, RETINOL';
  const INCI_PARFUM =
    'ALCOHOL DENAT, PARFUM, AQUA, LIMONENE, LINALOOL, CITRAL, GERANIOL, COUMARIN, EUGENOL';
  const demo = [
    ['ozon-1000123456', 'https://www.ozon.ru/product/1000123456/', 'Крем для лица увлажняющий, 50 мл', 24990, 26000, 120, true, INCI_TEXT],
    ['wb-14890618', 'https://www.wildberries.ru/catalog/14890618/detail.aspx', 'Крем для рук питательный DreamFit', 2599, 3000, 90, true, INCI_TEXT],
    ['goldapple-80790100005', 'https://goldapple.ru/80790100005-amber', 'Prada Парфюмерная вода Amber 80 мл', 8640, 8000, 60, false, INCI_PARFUM],
    ['letu-153801007', 'https://www.letu.ru/product/essence-tush-dlya-resnits-maximum-definition/153801007', 'ESSENCE Тушь для ресниц Maximum Definition', 2917, null, 35, true, INCI_TEXT],
    ['ozon-5000333444', 'https://www.ozon.ru/product/5000333444/', 'Книга «Чистый код» Роберт Мартин', 1450, 1200, 20, true, null]
  ].map(([id, url, titleText, price, target, days, inStock, composition]) => ({
    id,
    store: id.slice(0, id.lastIndexOf('-')),
    url,
    sku: id.slice(id.lastIndexOf('-') + 1),
    title: titleText,
    image: null,
    price,
    currency: 'RUB',
    inStock,
    targetPrice: target,
    addedAt: now - days * day,
    updatedAt: now,
    lastCheckAt: now,
    lastAttemptAt: now,
    status: 'ok',
    error: null,
    source: 'fetch',
    notifiedPrice: price,
    composition: composition || null,
    compositionAt: composition ? now : null,
    history: makeHistory(price, days)
  }));

  await evaluate(
    dashboard,
    `chrome.storage.local.set(${JSON.stringify({
      items: demo,
      settings: { intervalMinutes: 360, notifyOnDrop: true, notifyPercent: 3, notifyTarget: true, tabFallback: true, historyLimit: 4000 }
    })}).then(() => 'ok')`,
    true
  );
  await sleep(400);
  // Повторная навигация вместо reload: гарантирует свежий документ и отрисовку.
  await dashboard.send('Page.navigate', { url: `${base}/src/dashboard.html` });
  await sleep(1200);
  const chartDrawn = await waitFor(
    dashboard,
    'document.getElementById("chartCanvas").width > 300'
  );
  if (!chartDrawn) throw new Error('График не отрисовался: canvas остался пустым');

  const state = await evaluate(dashboard, 'chrome.runtime.sendMessage({ type: "GET_STATE" })', true);
  if (!state || !Array.isArray(state.items) || state.items.length !== demo.length) {
    throw new Error(`GET_STATE вернул неожиданные данные: ${JSON.stringify(state).slice(0, 200)}`);
  }

  const sideBadges = await evaluate(
    dashboard,
    '[...document.querySelectorAll(".si-title .store-badge")].map((node) => node.textContent.trim())'
  );
  for (const badge of ['Ozon', 'WB', 'ЗЯ', 'ЛЭТУ']) {
    if (!sideBadges.includes(badge)) {
      throw new Error(`В списке панели нет бейджа «${badge}»: ${JSON.stringify(sideBadges)}`);
    }
  }

  const chartEmptyDisplay = await evaluate(
    dashboard,
    'getComputedStyle(document.getElementById("chartEmpty")).display'
  );
  if (chartEmptyDisplay !== 'none') throw new Error('Подсказка пустого графика видна при наличии истории');
  const emptyAfterSeed = await evaluate(
    dashboard,
    'getComputedStyle(document.getElementById("empty")).display'
  );
  if (emptyAfterSeed !== 'none') throw new Error('Пустое состояние не скрылось после добавления товаров');

  await fs.mkdir(OUT, { recursive: true });
  const dashboardShot = await dashboard.send('Page.captureScreenshot', { format: 'png' });
  await fs.writeFile(path.join(OUT, 'dashboard.png'), Buffer.from(dashboardShot.data, 'base64'));

  // Второй скриншот — диапазон «7 дн», чтобы проверить переключатель.
  await evaluate(dashboard, 'document.querySelector(\'[data-range="7"]\')?.click()');
  await sleep(500);
  const weekShot = await dashboard.send('Page.captureScreenshot', { format: 'png' });
  await fs.writeFile(path.join(OUT, 'dashboard-7d.png'), Buffer.from(weekShot.data, 'base64'));

  // Детальная карточка выбранного товара показывает магазин и правильную ссылку.
  await evaluate(dashboard, 'document.querySelector(\'.side-item[data-id="wb-14890618"]\').click()');
  await sleep(500);
  const detailStore = await evaluate(dashboard, 'document.getElementById("storeChip").textContent');
  if (detailStore !== 'Wildberries') {
    throw new Error(`Неверный магазин в деталях: ${detailStore}`);
  }
  const openLinkText = await evaluate(dashboard, 'document.getElementById("openOzon").textContent');
  if (!openLinkText.includes('Wildberries')) {
    throw new Error(`Ссылка «Открыть» не упоминает магазин: ${openLinkText}`);
  }

  const inciItems = await evaluate(
    dashboard,
    'document.querySelectorAll("#inciBody .inci-item").length'
  );
  if (inciItems < 5) {
    throw new Error(`В панели не отрисовался разбор состава: компонентов ${inciItems}`);
  }
  const inciVerdictText = await evaluate(dashboard, 'document.getElementById("inciVerdict").textContent');
  if (!/есть риски|много рисков/.test(inciVerdictText)) {
    throw new Error(`Неожиданный вердикт состава: ${inciVerdictText}`);
  }
  const inciFlags = await evaluate(
    dashboard,
    'document.querySelectorAll("#inciBody .inci-flag").length'
  );
  if (inciFlags < 3) {
    throw new Error(`В панели не хватает флагов состава: ${inciFlags}`);
  }

  await evaluate(dashboard, 'document.querySelector(\'.side-item[data-id="ozon-5000333444"]\').click()');
  await sleep(300);
  const inciEmpty = await evaluate(
    dashboard,
    'document.querySelectorAll("#inciBody .inci-empty").length'
  );
  if (inciEmpty !== 1) throw new Error('Подсказка об отсутствии состава не показалась');

  const popup = await openPage(`${base}/src/popup.html`, 392, 600);
  const popupCount = await evaluate(popup, 'document.querySelectorAll(".item").length');
  if (popupCount < 1) throw new Error('Popup не отрисовал список товаров');
  const popupBadges = await evaluate(
    popup,
    '[...document.querySelectorAll(".item-title .store-badge")].map((node) => node.textContent.trim())'
  );
  for (const badge of ['Ozon', 'WB', 'ЗЯ', 'ЛЭТУ']) {
    if (!popupBadges.includes(badge)) {
      throw new Error(`В popup нет бейджа «${badge}»: ${JSON.stringify(popupBadges)}`);
    }
  }
  const popupHeight = await evaluate(
    popup,
    'Math.ceil(document.querySelector(".foot").getBoundingClientRect().bottom + 8)'
  );
  await popup.send('Emulation.setDeviceMetricsOverride', {
    width: 392,
    height: Math.max(220, Math.min(600, popupHeight)),
    deviceScaleFactor: 1,
    mobile: false
  });
  await sleep(300);
  const popupShot = await popup.send('Page.captureScreenshot', { format: 'png' });
  await fs.writeFile(path.join(OUT, 'popup.png'), Buffer.from(popupShot.data, 'base64'));

  const collected = [collectErrors(dashboard), collectErrors(popup)];
  const errors = [...new Set(collected.flatMap((entry) => [...entry.log, ...entry.exceptions]))];
  if (errors.length) {
    console.error('Ошибки страниц:', JSON.stringify(errors, null, 2));
    await cleanup(1);
  }

  // Проверка content script на подставных страницах четырёх магазинов (без сети).
  const baseStyle = `<style>body{font-family:Segoe UI,Arial,sans-serif;margin:0;padding:40px;background:#f5f7fb;color:#111}h1{font-size:32px}.price{font-size:40px;font-weight:700;color:#005bff}s{color:#888;font-size:22px;margin-left:12px}</style>`;
  const ozonFixture = `<!doctype html>
<html lang="ru"><head><meta charset="utf-8">
<title>Тестовый товар — купить на OZON</title>
<meta property="og:title" content="Тестовый товар Ozon Price Tracker">
<meta property="og:image" content="https://cdn.example.test/product.jpg">
<script type="application/ld+json">${JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: 'Тестовый товар Ozon Price Tracker',
    image: 'https://cdn.example.test/product.jpg',
    offers: { '@type': 'Offer', price: '1990', priceCurrency: 'RUB', availability: 'https://schema.org/InStock' }
  })}</script>
${baseStyle}
</head><body>
<h1 data-widget="webProductHeading">Тестовый товар Ozon Price Tracker</h1>
<div data-widget="webPrice"><span class="price">1 990 ₽</span></div>
<div data-widget="webDescription">Состав: ${INCI_TEXT}</div>
</body></html>`;

  const wbFixture = `<!doctype html>
<html lang="ru"><head><meta charset="utf-8">
<title>Купить Джоггеры DreamFit | Wildberries</title>
<meta property="og:title" content="Купить Джоггеры DreamFit | Wildberries">
${baseStyle}
</head><body>
<h1>Джоггеры спортивные DreamFit</h1>
<div class="price-block"><ins class="price-block__final-price">2 599 ₽</ins><del>3 599 ₽</del></div>
<div class="product-details__description">Состав: ${INCI_TEXT}</div>
</body></html>`;

  const gaFixture = `<!doctype html>
<html lang="ru"><head><meta charset="utf-8">
<title>Prada Парфюмерная вода Amber 80 мл — купить, цена в Москве</title>
${baseStyle}
</head><body>
<div class="product-card">
  <h1>Prada Парфюмерная вода Amber 80 мл</h1>
  <div class="purchase"><span class="price">8 640 ₽</span><span class="old"><s>9 758 ₽</s></span></div>
  <div class="product-composition">Состав: ${INCI_PARFUM}</div>
</div>
</body></html>`;

  const letuFixture = `<!doctype html>
<html lang="ru"><head><meta charset="utf-8">
<title>ESSENCE Тушь для ресниц Maximum Definition купить по низким ценам в ЛЭТУАЛЬ</title>
${baseStyle}
</head><body>
<h1 class="product-detail-v3__name-title">ESSENCE Тушь для ресниц Maximum Definition</h1>
<div class="price-block__price">
  <span class="price-block__price-current" data-at-price="2917">2 917 ₽</span>
  <span class="price-block__price-old">3 890 ₽</span>
</div>
<div class="product-detail-info">
  <div class="product-detail-info-item">
    <span class="product-detail-info-item__title">Состав</span>
  </div>
</div>
<script>
  document.querySelector('.product-detail-info-item__title').addEventListener('click', function () {
    var content = document.createElement('div');
    content.className = 'product-detail-info-item__content';
    content.textContent = 'Состав: ${INCI_TEXT}';
    this.parentElement.appendChild(content);
  });
</script>
</body></html>`;

  const fixtures = {
    'www.ozon.ru': ozonFixture,
    'www.wildberries.ru': wbFixture,
    'goldapple.ru': gaFixture,
    'www.letu.ru': letuFixture
  };

  await popup.send('Emulation.setDeviceMetricsOverride', {
    width: 1280,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false
  });
  await popup.send('Fetch.enable', {
    patterns: [
      { urlPattern: '*://*.ozon.ru/*', requestStage: 'Request' },
      { urlPattern: '*://*.wildberries.ru/*', requestStage: 'Request' },
      { urlPattern: '*://*.goldapple.ru/*', requestStage: 'Request' },
      { urlPattern: '*://goldapple.ru/*', requestStage: 'Request' },
      { urlPattern: '*://*.letu.ru/*', requestStage: 'Request' }
    ]
  });
  popup.on('Fetch.requestPaused', async (params) => {
    try {
      const host = new URL(params.request.url).hostname;
      const fixture = fixtures[host];
      if (params.resourceType === 'Document' && fixture) {
        await popup.send('Fetch.fulfillRequest', {
          requestId: params.requestId,
          responseCode: 200,
          responseHeaders: [
            { name: 'Content-Type', value: 'text/html; charset=utf-8' },
            { name: 'Cache-Control', value: 'no-store' }
          ],
          body: Buffer.from(fixture, 'utf8').toString('base64')
        });
      } else {
        await popup.send('Fetch.fulfillRequest', {
          requestId: params.requestId,
          responseCode: 204,
          responseHeaders: [],
          body: ''
        });
      }
    } catch {
      /* запрос мог быть отменён навигацией */
    }
  });

  const overlayCases = [
    {
      url: 'https://www.ozon.ru/product/7770012345/',
      price: '1 990',
      store: 'Ozon',
      sku: '7770012345',
      id: 'ozon-7770012345'
    },
    {
      url: 'https://www.wildberries.ru/catalog/14890619/detail.aspx',
      price: '2 599',
      store: 'Wildberries',
      sku: '14890619',
      id: 'wb-14890619'
    },
    {
      url: 'https://goldapple.ru/8070012345-amber-test',
      price: '8 640',
      store: 'Золотое яблоко',
      sku: '8070012345',
      id: 'goldapple-8070012345'
    },
    {
      url: 'https://www.letu.ru/product/test-product/153801008',
      price: '2 917',
      store: 'Летуаль',
      sku: '153801008',
      id: 'letu-153801008'
    }
  ];

  for (const testCase of overlayCases) {
    await popup.send('Page.navigate', { url: testCase.url });
    const overlayAppeared = await waitFor(
      popup,
      'Boolean(document.querySelector("[data-price-tracker]"))',
      9000
    );
    if (!overlayAppeared) {
      const debug = await evaluate(
        popup,
        'JSON.stringify({url: location.href, title: document.title, ready: document.readyState, body: (document.body ? document.body.innerText : "").slice(0, 200), html: document.documentElement.outerHTML.slice(0, 200)})'
      );
      throw new Error(`Content script не показал плашку для ${testCase.store}: ${debug}`);
    }

    if (testCase.store === 'Летуаль') {
      const scanShown = await waitFor(
        popup,
        'document.querySelector("[data-price-tracker]").shadowRoot.textContent.includes("Разобрать состав")',
        6000
      );
      if (!scanShown) throw new Error('Плашка Летуаль не предложила разобрать состав');
      await evaluate(
        popup,
        'document.querySelector("[data-price-tracker]").shadowRoot.querySelector(\'[data-act="inci-scan"]\').click()'
      );
      const inciShown = await waitFor(
        popup,
        'document.querySelector("[data-price-tracker]").shadowRoot.textContent.includes("Состав:")',
        8000
      );
      if (!inciShown) throw new Error('Плашка Летуаль не показала состав после разбора');
      const inciItems = await evaluate(
        popup,
        'document.querySelector("[data-price-tracker]").shadowRoot.querySelectorAll(".inci-item").length'
      );
      if (inciItems < 3) throw new Error(`Плашка Летуаль не показала компоненты: ${inciItems}`);
    } else {
      const inciShown = await waitFor(
        popup,
        'document.querySelector("[data-price-tracker]").shadowRoot.textContent.includes("Состав:")',
        6000
      );
      if (!inciShown) throw new Error(`Плашка ${testCase.store} не показала разбор состава`);
    }

    const overlayText = await evaluate(
      popup,
      'document.querySelector("[data-price-tracker]").shadowRoot.textContent.replace(/\\s+/g, " ").trim()'
    );
    if (
      !overlayText.includes('Отслеживать цену') ||
      !overlayText.includes(testCase.price) ||
      !overlayText.includes(testCase.store)
    ) {
      throw new Error(`Неожиданный текст плашки ${testCase.store}: ${overlayText.replace(/^\s*:host[\s\S]*?\}\s*/, '').slice(0, 400)}`);
    }

    await evaluate(
      popup,
      'document.querySelector("[data-price-tracker]").shadowRoot.querySelector(\'[data-act="track"]\').click()'
    );
    const tracked = await waitFor(
      popup,
      'document.querySelector("[data-price-tracker]").shadowRoot.textContent.includes("отслеживается")',
      6000
    );
    if (!tracked) throw new Error(`Товар ${testCase.store} не добавился в отслеживание`);

    if (testCase.store === 'Ozon') {
      const contentShot = await popup.send('Page.captureScreenshot', { format: 'png' });
      await fs.writeFile(path.join(OUT, 'content-overlay.png'), Buffer.from(contentShot.data, 'base64'));
    }
  }

  await popup.send('Fetch.disable');
  await popup.send('Page.navigate', { url: `${base}/src/popup.html` });
  await sleep(1200);

  const trackedItems = await evaluate(
    popup,
    'chrome.storage.local.get("items").then((data) => (data.items || []).map((item) => ({ id: item.id, store: item.store, sku: item.sku, price: item.price, points: item.history.length, hasComposition: Boolean(item.composition) })))',
    true
  );
  for (const testCase of overlayCases) {
    const saved = trackedItems.find((entry) => entry.id === testCase.id);
    if (!saved) throw new Error(`Товар ${testCase.store} не сохранён (id ${testCase.id})`);
    if (saved.price <= 0 || saved.points < 1) {
      throw new Error(`Товар ${testCase.store} сохранён некорректно: ${JSON.stringify(saved)}`);
    }
    if (!saved.hasComposition) {
      throw new Error(`У товара ${testCase.store} не сохранился состав`);
    }
    if (saved.store !== testCase.id.slice(0, testCase.id.lastIndexOf('-'))) {
      throw new Error(`Неверный магазин у ${testCase.id}: ${saved.store}`);
    }
  }
  const trackedItem = trackedItems.find((entry) => entry.id === 'ozon-7770012345');
  if (!trackedItem || trackedItem.price !== 1990) {
    throw new Error(`Товар Ozon сохранён некорректно: ${JSON.stringify(trackedItem)}`);
  }

  console.log(`Заголовок панели: ${title}`);
  console.log(`GET_STATE: товаров ${state.items.length}`);
  console.log(`Content script: добавлен ${trackedItem.id} за ${trackedItem.price} ₽`);
  console.log('Скриншоты: tests/out/dashboard.png, dashboard-7d.png, popup.png, content-overlay.png');
  console.log('OK');
  await cleanup(0);
} catch (error) {
  console.error('FAIL:', error.message);
  await cleanup(1);
}
