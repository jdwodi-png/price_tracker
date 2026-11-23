import {
  formatPrice,
  formatRelative,
  formatPercent,
  plural,
  truncate
} from './lib/shared.js';
import { isProductUrl, productIdFromUrl, storeMetaFromUrl, titleFromUrl } from './lib/parse.js';

const state = {
  data: null,
  currentProduct: null,
  tabId: null,
  busy: false,
  toastTimer: null,
  renderTimer: null
};

const $ = (selector) => document.querySelector(selector);

const els = {
  currentCard: $('#currentCard'),
  curLabel: $('#curLabel'),
  curBadge: $('#curBadge'),
  curImg: $('#curImg'),
  curTitle: $('#curTitle'),
  curPrice: $('#curPrice'),
  curDelta: $('#curDelta'),
  curAction: $('#curAction'),
  count: $('#count'),
  list: $('#list'),
  statusText: $('#statusText'),
  refreshBtn: $('#refreshBtn'),
  dashboardBtn: $('#dashboardBtn'),
  settingsBtn: $('#settingsBtn'),
  addUrlBtn: $('#addUrlBtn'),
  addUrlRow: $('#addUrlRow'),
  urlInput: $('#urlInput'),
  urlAddBtn: $('#urlAddBtn'),
  toast: $('#toast'),
  subtitle: $('#subtitle')
};

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function call(type, payload = {}) {
  try {
    const response = await chrome.runtime.sendMessage({ type, ...payload });
    return response || { ok: false, error: 'Нет ответа от расширения' };
  } catch (error) {
    return { ok: false, error: error && error.message ? error.message : 'Ошибка расширения' };
  }
}

function showToast(text, isError = false) {
  els.toast.textContent = text;
  els.toast.classList.toggle('error', Boolean(isError));
  els.toast.hidden = false;
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => {
    els.toast.hidden = true;
  }, 3400);
}

function itemById(id) {
  return state.data && Array.isArray(state.data.items)
    ? state.data.items.find((item) => item.id === id) || null
    : null;
}

function trackedForProduct(product) {
  if (!product || !state.data) return null;
  let id = null;
  try {
    id = productIdFromUrl(product.url);
  } catch {
    id = null;
  }
  return (
    (id && itemById(id)) ||
    state.data.items.find((item) => item.url === product.url) ||
    null
  );
}

async function loadState() {
  const response = await call('GET_STATE', { mode: 'lite' });
  if (response.ok) state.data = response;
  return response;
}

async function loadCurrentProduct() {
  state.currentProduct = null;
  let tab = null;
  try {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  } catch {
    return;
  }
  if (!tab || !tab.id || !tab.url || !isProductUrl(tab.url)) return;
  state.tabId = tab.id;

  const fromTab = async () => {
    const response = await chrome.tabs.sendMessage(tab.id, { type: 'EXTRACT_NOW' });
    return response && response.product ? response.product : null;
  };

  let product = null;
  try {
    product = await fromTab();
  } catch {
    product = null;
  }

  if (!product) {
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['src/content.js'] });
      await new Promise((resolve) => setTimeout(resolve, 300));
      product = await fromTab();
    } catch {
      product = null;
    }
  }

  if (!product) {
    product = {
      url: tab.url,
      title: titleFromUrl(tab.url),
      price: null,
      image: null,
      inStock: true
    };
  }
  if (!product.url) product.url = tab.url;
  state.currentProduct = product;
}

function renderCurrent() {
  const product = state.currentProduct;
  if (!product) {
    els.currentCard.hidden = true;
    return;
  }

  const tracked = trackedForProduct(product);
  const price = Number.isFinite(product.price)
    ? product.price
    : tracked && Number.isFinite(tracked.price)
      ? tracked.price
      : null;
  const stats = tracked && tracked.stats ? tracked.stats : null;
  const delta = stats && Number.isFinite(stats.first) && Number.isFinite(price) && stats.first
    ? ((price - stats.first) / stats.first) * 100
    : null;

  els.currentCard.hidden = false;
  const store = storeMetaFromUrl(product.url);
  els.curLabel.textContent = store ? `${store.label} · на этой странице` : 'На этой странице';
  els.curBadge.hidden = !tracked;
  els.curBadge.textContent = tracked ? 'Отслеживается' : '';

  if (product.image) {
    els.curImg.src = product.image;
    els.curImg.style.visibility = 'visible';
  } else {
    els.curImg.removeAttribute('src');
    els.curImg.style.visibility = 'hidden';
  }

  els.curTitle.textContent = product.title || titleFromUrl(product.url);
  els.curPrice.textContent = Number.isFinite(price) ? formatPrice(price) : 'Цена не определена';

  if (delta != null && Math.abs(delta) >= 0.1) {
    els.curDelta.hidden = false;
    els.curDelta.textContent = formatPercent(delta);
    els.curDelta.className = `current-delta ${delta < 0 ? 'good' : 'bad'}`;
  } else {
    els.curDelta.hidden = true;
  }

  els.curAction.textContent = tracked ? 'История' : 'Добавить';
  els.curAction.dataset.mode = tracked ? 'open' : 'add';
  els.curAction.dataset.id = tracked ? tracked.id : '';
  els.curAction.disabled = false;
}

function drawSpark(canvas, history) {
  const points = (Array.isArray(history) ? history : [])
    .filter((point) => point && Number.isFinite(point.t) && Number.isFinite(point.p))
    .slice(-60);

  const dpr = window.devicePixelRatio || 1;
  const width = 64;
  const height = 30;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;

  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  if (points.length < 2) {
    ctx.strokeStyle = 'rgba(126, 166, 255, 0.3)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(3, height / 2);
    ctx.lineTo(width - 3, height / 2);
    ctx.stroke();
    ctx.setLineDash([]);
    return;
  }

  const padX = 3;
  const padY = 5;
  const min = Math.min(...points.map((point) => point.p));
  const max = Math.max(...points.map((point) => point.p));
  const span = max - min || 1;
  const firstT = points[0].t;
  const lastT = points[points.length - 1].t;
  const timeSpan = lastT - firstT || 1;

  const x = (t) => padX + ((t - firstT) / timeSpan) * (width - padX * 2);
  const y = (p) => padY + (1 - (p - min) / span) * (height - padY * 2);

  const falling = points[points.length - 1].p <= points[0].p;
  const color = falling ? '#22d3a5' : '#ff7b7b';

  const gradient = ctx.createLinearGradient(0, 0, 0, height);
  gradient.addColorStop(0, falling ? 'rgba(34, 211, 165, 0.22)' : 'rgba(255, 123, 123, 0.2)');
  gradient.addColorStop(1, falling ? 'rgba(34, 211, 165, 0)' : 'rgba(255, 123, 123, 0)');

  ctx.beginPath();
  ctx.moveTo(x(points[0].t), y(points[0].p));
  for (let i = 1; i < points.length; i++) {
    ctx.lineTo(x(points[i].t), y(points[i - 1].p));
    ctx.lineTo(x(points[i].t), y(points[i].p));
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.7;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.stroke();

  ctx.lineTo(x(points[points.length - 1].t), height);
  ctx.lineTo(x(points[0].t), height);
  ctx.closePath();
  ctx.fillStyle = gradient;
  ctx.fill();

  const lastX = x(points[points.length - 1].t);
  const lastY = y(points[points.length - 1].p);
  ctx.beginPath();
  ctx.arc(lastX, lastY, 2.2, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
}

function renderList() {
  const items = state.data && Array.isArray(state.data.items) ? state.data.items.slice() : [];
  items.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
  els.count.textContent = String(items.length);

  if (!items.length) {
    els.list.innerHTML = `
      <div class="empty">
        <div class="empty-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
            <path d="M4 19V5" /><path d="M4 19h16" />
            <path d="M7 15l3.5-4 3 2.5L20 6" />
            <path d="M20 10V6h-4" />
          </svg>
        </div>
        <b>Пока пусто</b>
        <p>Откройте карточку товара в Ozon, Wildberries, Золотом яблоке или Летуаль и нажмите «Отслеживать цену». Или добавьте ссылку вручную.</p>
        <button class="btn" data-act="open-ozon">Открыть Ozon</button>
      </div>`;
    return;
  }

  els.list.innerHTML = items
    .map((item) => {
      const stats = item.stats || {};
      const first = Number.isFinite(stats.first) ? stats.first : null;
      const price = Number.isFinite(item.price) ? item.price : null;
      const delta = first && price ? ((price - first) / first) * 100 : null;
      const deltaClass = delta == null ? '' : delta < 0 ? 'good' : delta > 0 ? 'bad' : '';
      const minText = Number.isFinite(stats.min) ? `мин ${formatPrice(stats.min)}` : 'нет данных';
      const target = item.targetPrice && price && price <= item.targetPrice;
      const warn = item.status === 'blocked' || item.status === 'error';
      const store = storeMetaFromUrl(item.url);
      const meta = [
        minText,
        item.lastCheckAt ? formatRelative(item.lastCheckAt) : 'ожидает проверки',
        target ? 'цель достигнута' : ''
      ]
        .filter(Boolean)
        .join(' · ');

      return `
        <article class="item" data-id="${escapeHtml(item.id)}" data-url="${escapeHtml(item.url)}" title="${escapeHtml(
          item.title
        )}">
          <div class="thumb-wrap">
            ${
              item.image
                ? `<img class="thumb" src="${escapeHtml(item.image)}" alt="" loading="lazy" />`
                : '<div class="thumb-fallback">₽</div>'
            }
          </div>
          <div class="item-main">
            <div class="item-title">${
              store ? `<span class="store-badge store-${store.id}">${escapeHtml(store.badge)}</span> ` : ''
            }${escapeHtml(truncate(item.title, 80))}</div>
            <div class="item-price-row">
              <span class="item-price">${escapeHtml(price ? formatPrice(price) : '—')}</span>
              ${
                delta != null && Math.abs(delta) >= 0.1
                  ? `<span class="item-delta ${deltaClass}">${escapeHtml(formatPercent(delta))}</span>`
                  : ''
              }
            </div>
            <div class="item-meta">
              ${warn ? `<span class="warn-dot" title="${escapeHtml(item.error || 'Ошибка обновления')}"></span>` : ''}
              <span>${escapeHtml(meta)}</span>
            </div>
          </div>
          <div class="item-side">
            <canvas class="spark" width="64" height="30"></canvas>
            <button class="external" data-external="1" title="Открыть${store ? ` на ${escapeHtml(store.label)}` : ''}">↗</button>
          </div>
        </article>`;
    })
    .join('');

  els.list.querySelectorAll('.item').forEach((row) => {
    const item = itemById(row.dataset.id);
    if (!item) return;
    const stats = item.stats || {};
    const label = row.querySelector('.item-meta span:last-child');
    if (label && stats.points) {
      label.title = `${stats.points} ${plural(stats.points, 'точка', 'точки', 'точек')} истории`;
    }
    const canvas = row.querySelector('canvas.spark');
    if (canvas) drawSpark(canvas, item.history);
  });
}

function renderFooter(refreshing = false) {
  const items = state.data && Array.isArray(state.data.items) ? state.data.items : [];
  if (refreshing) {
    els.statusText.textContent = 'Обновляем цены…';
    return;
  }
  if (!items.length) {
    els.statusText.textContent = 'Добавьте первый товар';
    return;
  }
  const last = Math.max(...items.map((item) => item.lastCheckAt || 0));
  els.statusText.textContent = last ? `Обновлено ${formatRelative(last)}` : 'Ожидает проверки';
}

function render(refreshing = false) {
  renderCurrent();
  renderList();
  renderFooter(refreshing);
  const count = state.data && state.data.items ? state.data.items.length : 0;
  els.subtitle.textContent = count
    ? `${count} ${plural(count, 'товар', 'товара', 'товаров')} в отслеживании`
    : 'история цен';
}

async function reloadAndRender() {
  await loadState();
  render(state.busy || Boolean(state.data && state.data.refreshing));
}

async function addCurrentProduct() {
  const product = state.currentProduct;
  if (!product) return;
  els.curAction.disabled = true;
  els.curAction.textContent = 'Добавляем…';
  const response = await call('ADD_PRODUCT', { product });
  if (response.ok) {
    await reloadAndRender();
    showToast('Товар добавлен в отслеживание');
  } else {
    els.curAction.disabled = false;
    els.curAction.textContent = 'Добавить';
    showToast(response.error || 'Не удалось добавить товар', true);
  }
}

async function addByUrl() {
  const url = els.urlInput.value.trim();
  if (!url) {
    els.urlInput.focus();
    return;
  }
  els.urlAddBtn.disabled = true;
  els.urlAddBtn.textContent = '…';
  const response = await call('ADD_URL', { url });
  els.urlAddBtn.disabled = false;
  els.urlAddBtn.textContent = 'Добавить';

  if (response.ok) {
    els.urlInput.value = '';
    els.addUrlRow.hidden = true;
    await reloadAndRender();
    showToast('Товар добавлен, цена подтянется в фоне');
  } else {
    showToast(response.error || 'Не удалось распознать ссылку', true);
  }
}

async function refreshAll() {
  if (state.busy) return;
  const items = state.data && state.data.items ? state.data.items : [];
  if (!items.length) {
    showToast('Список пуст — сначала добавьте товар', true);
    return;
  }

  state.busy = true;
  els.refreshBtn.classList.add('spinning');
  els.refreshBtn.disabled = true;
  renderFooter(true);

  const response = await call('REFRESH_ALL', { force: true });

  state.busy = false;
  els.refreshBtn.classList.remove('spinning');
  els.refreshBtn.disabled = false;
  await loadState();
  render(false);

  if (response.ok) {
    const failed = response.failed ? `, ошибок: ${response.failed}` : '';
    showToast(`Готово: обновлено ${response.updated} из ${response.total}${failed}`);
  } else {
    showToast(response.error || 'Не удалось обновить цены', true);
  }
}

function openDashboard(id) {
  call('OPEN_DASHBOARD', id ? { id } : {});
}

function debouncedReload() {
  clearTimeout(state.renderTimer);
  state.renderTimer = setTimeout(() => {
    reloadAndRender().catch(() => undefined);
  }, 180);
}

/* ------------------------------ события ------------------------------ */

els.refreshBtn.addEventListener('click', refreshAll);

els.dashboardBtn.addEventListener('click', () => openDashboard());

els.settingsBtn.addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('src/dashboard.html#settings') });
});

els.addUrlBtn.addEventListener('click', () => {
  els.addUrlRow.hidden = !els.addUrlRow.hidden;
  if (!els.addUrlRow.hidden) els.urlInput.focus();
});

els.urlAddBtn.addEventListener('click', addByUrl);

els.urlInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    addByUrl();
  }
});

els.curAction.addEventListener('click', () => {
  if (els.curAction.dataset.mode === 'open') {
    const id = els.curAction.dataset.id;
    if (id) openDashboard(id);
    return;
  }
  addCurrentProduct();
});

els.list.addEventListener('click', (event) => {
  const openOzon = event.target.closest('[data-act="open-ozon"]');
  if (openOzon) {
    chrome.tabs.create({ url: 'https://www.ozon.ru/' });
    return;
  }

  const external = event.target.closest('[data-external]');
  const row = event.target.closest('.item');
  if (!row) return;
  if (external) {
    event.stopPropagation();
    chrome.tabs.create({ url: row.dataset.url });
    return;
  }
  openDashboard(row.dataset.id);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.items || changes.settings) debouncedReload();
});

chrome.runtime.onMessage.addListener((message) => {
  if (!message || message.type !== 'REFRESH_PROGRESS') return;
  if (message.finished) {
    renderFooter(false);
    return;
  }
  if (state.busy && message.total) {
    els.statusText.textContent = `Обновляем ${message.done} из ${message.total}…`;
  }
});

/* ------------------------------ запуск ------------------------------ */

(async () => {
  await loadState();
  render(Boolean(state.data && state.data.refreshing));
  await loadCurrentProduct();
  renderCurrent();
})().catch((error) => {
  console.error(error);
  showToast('Не удалось загрузить данные', true);
});
