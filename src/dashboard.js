import {
  INTERVAL_OPTIONS,
  formatAxisDate,
  formatDate,
  formatDateTime,
  formatDelta,
  formatInteger,
  formatPercent,
  formatPrice,
  formatRelative,
  plural,
  statsForRange,
  truncate
} from './lib/shared.js';
import { storeMetaFromUrl } from './lib/parse.js';
import { analyzeInci, INCI_VERDICT_LABELS, INCI_TAG_META } from './lib/inci.js';

const $ = (selector) => document.querySelector(selector);

const els = {
  banner: $('#banner'),
  bannerClose: $('#bannerClose'),
  itemList: $('#itemList'),
  itemCount: $('#itemCount'),
  searchInput: $('#searchInput'),
  addUrlInput: $('#addUrlInput'),
  addUrlBtn: $('#addUrlBtn'),
  refreshAllBtn: $('#refreshAllBtn'),
  sideStatus: $('#sideStatus'),
  exportBtn: $('#exportBtn'),
  importBtn: $('#importBtn'),
  importFile: $('#importFile'),
  settingsBtn: $('#settingsBtn'),
  detail: $('#detail'),
  empty: $('#empty'),
  emptyOzonBtn: $('#emptyOzonBtn'),
  heroImg: $('#heroImg'),
  detailTitle: $('#detailTitle'),
  statusChip: $('#statusChip'),
  storeChip: $('#storeChip'),
  sourceChip: $('#sourceChip'),
  bigPrice: $('#bigPrice'),
  bigChange: $('#bigChange'),
  targetHitChip: $('#targetHitChip'),
  openOzon: $('#openOzon'),
  checkNowBtn: $('#checkNowBtn'),
  deleteBtn: $('#deleteBtn'),
  errorNote: $('#errorNote'),
  chartCanvas: $('#chartCanvas'),
  chartWrap: $('#chartWrap'),
  chartTip: $('#chartTip'),
  chartEmpty: $('#chartEmpty'),
  chartSub: $('#chartSub'),
  rangeButtons: $('#rangeButtons'),
  statsGrid: $('#statsGrid'),
  inciSub: $('#inciSub'),
  inciVerdict: $('#inciVerdict'),
  inciBody: $('#inciBody'),
  targetInput: $('#targetInput'),
  saveTargetBtn: $('#saveTargetBtn'),
  clearTargetBtn: $('#clearTargetBtn'),
  targetProgress: $('#targetProgress'),
  targetBar: $('#targetBar'),
  targetHint: $('#targetHint'),
  infoAdded: $('#infoAdded'),
  infoChecked: $('#infoChecked'),
  infoPoints: $('#infoPoints'),
  infoSource: $('#infoSource'),
  infoSku: $('#infoSku'),
  clearHistoryBtn: $('#clearHistoryBtn'),
  settingsModal: $('#settingsModal'),
  closeSettings: $('#closeSettings'),
  cancelSettings: $('#cancelSettings'),
  saveSettingsBtn: $('#saveSettingsBtn'),
  setInterval: $('#setInterval'),
  setNotify: $('#setNotify'),
  setPercent: $('#setPercent'),
  setTargetNotify: $('#setTargetNotify'),
  setTabFallback: $('#setTabFallback'),
  setLimit: $('#setLimit'),
  clearAllBtn: $('#clearAllBtn'),
  toast: $('#toast')
};

const state = {
  data: null,
  selectedId: null,
  range: 30,
  search: '',
  busy: false,
  hoverT: null,
  chart: null,
  toastTimer: null,
  drawQueued: false,
  refreshButtonHtml: '',
  settingsOpen: false
};

const SOURCE_LABELS = {
  page: 'карточка товара',
  fetch: 'фоновая проверка',
  tab: 'через вкладку',
  import: 'импорт',
  pending: 'ожидает'
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
  }, 3800);
}

async function loadState() {
  const response = await call('GET_STATE', { mode: 'full' });
  if (response.ok) state.data = response;
  return response;
}

function allItems() {
  return state.data && Array.isArray(state.data.items) ? state.data.items : [];
}

function currentItem() {
  return allItems().find((item) => item.id === state.selectedId) || null;
}

function rangeLabel(range = state.range) {
  if (range === 'all') return 'за всё время';
  if (range === 365) return 'за год';
  return `за ${range} ${plural(Number(range), 'день', 'дня', 'дней')}`;
}

/* ------------------------------ выделение ------------------------------ */

function selectItem(id, pushHash = true) {
  if (!id) return;
  state.selectedId = id;
  state.hoverT = null;
  try {
    localStorage.setItem('opt-selected', id);
  } catch {
    /* ignore */
  }
  if (pushHash) {
    try {
      history.replaceState(null, '', `#item=${encodeURIComponent(id)}`);
    } catch {
      /* ignore */
    }
  }
  render();
}

function parseHash() {
  const raw = location.hash.replace(/^#/, '');
  if (!raw) return {};
  let value = raw;
  try {
    value = decodeURIComponent(raw);
  } catch {
    /* ignore */
  }
  if (value.startsWith('item=')) return { type: 'item', id: value.slice(5) };
  if (value.startsWith('settings')) return { type: 'settings' };
  if (value.startsWith('welcome')) return { type: 'welcome' };
  return {};
}

/* ------------------------------- сайдбар ------------------------------- */

function renderSidebar() {
  const items = allItems();
  const query = state.search.trim().toLowerCase();
  const filtered = query
    ? items.filter(
        (item) =>
          String(item.title || '').toLowerCase().includes(query) ||
          String(item.sku || '').includes(query)
      )
    : items;

  els.itemCount.textContent = String(items.length);

  if (!filtered.length) {
    els.itemList.innerHTML = `<div class="side-empty">${
      items.length ? 'Ничего не найдено' : 'Пока нет товаров.<br>Добавьте ссылку или откройте карточку в любом из магазинов.'
    }</div>`;
    return;
  }

  els.itemList.innerHTML = filtered
    .map((item) => {
      const stats = item.stats || {};
      const price = Number.isFinite(item.price) ? item.price : null;
      const first = Number.isFinite(stats.first) ? stats.first : null;
      const delta = first && price ? ((price - first) / first) * 100 : null;
      const deltaClass = delta == null ? '' : delta < 0 ? 'good' : delta > 0 ? 'bad' : '';
      const active = item.id === state.selectedId ? ' active' : '';
      const warn = item.status === 'blocked' || item.status === 'error';
      const store = storeMetaFromUrl(item.url);
      return `
        <button class="side-item${active}" data-id="${escapeHtml(item.id)}" title="${escapeHtml(item.title)}">
          <div class="si-thumb">
            ${item.image ? `<img src="${escapeHtml(item.image)}" alt="" loading="lazy" />` : '₽'}
          </div>
          <div class="si-main">
            <div class="si-title">${
              store ? `<span class="store-badge store-${store.id}">${escapeHtml(store.badge)}</span> ` : ''
            }${escapeHtml(truncate(item.title, 78))}</div>
            <div class="si-meta">
              <span class="si-price">${escapeHtml(price ? formatPrice(price) : '—')}</span>
              ${
                delta != null && Math.abs(delta) >= 0.1
                  ? `<span class="si-delta ${deltaClass}">${escapeHtml(formatPercent(delta))}</span>`
                  : ''
              }
            </div>
          </div>
          ${warn ? `<span class="si-dot" title="${escapeHtml(item.error || 'Ошибка обновления')}"></span>` : ''}
        </button>`;
    })
    .join('');
}

/* -------------------------------- детали -------------------------------- */

function statusInfo(item) {
  if (!item || !Number.isFinite(item.price)) {
    return { text: 'Ожидает первой цены', className: 'chip warn' };
  }
  if (item.status === 'blocked') return { text: 'Нужно открыть карточку', className: 'chip warn' };
  if (item.status === 'error') return { text: 'Ошибка обновления', className: 'chip bad' };
  return { text: 'Цена актуальна', className: 'chip good' };
}

function renderStats(item, stats) {
  const change = Number.isFinite(stats.change) ? stats.change : null;
  const changePct = Number.isFinite(stats.changePct) ? stats.changePct : null;
  const changeClass = change == null ? '' : change < 0 ? 'good' : change > 0 ? 'bad' : '';
  const label = rangeLabel();

  const cards = [
    {
      label: 'Минимум',
      value: formatPrice(stats.min),
      sub: stats.minAt ? formatDate(stats.minAt) : '—',
      className: 'good'
    },
    {
      label: 'Максимум',
      value: formatPrice(stats.max),
      sub: stats.maxAt ? formatDate(stats.maxAt) : '—',
      className: ''
    },
    {
      label: 'Средняя',
      value: formatPrice(stats.avg),
      sub: 'взвешено по времени',
      className: ''
    },
    {
      label: 'Изменение',
      value: changePct == null ? '—' : formatPercent(changePct),
      sub: change == null ? label : `${formatDelta(change)} · ${label}`,
      className: changeClass
    }
  ];

  els.statsGrid.innerHTML = cards
    .map(
      (card) => `
        <div class="stat">
          <div class="stat-label">${card.label}</div>
          <div class="stat-value ${card.className}">${escapeHtml(card.value)}</div>
          <div class="stat-sub">${escapeHtml(card.sub)}</div>
        </div>`
    )
    .join('');
}

function renderTarget(item) {
  if (document.activeElement !== els.targetInput) {
    els.targetInput.value = item.targetPrice ? String(item.targetPrice) : '';
  }

  const target = Number(item.targetPrice);
  const price = Number(item.price);
  if (!Number.isFinite(target) || target <= 0) {
    els.targetProgress.hidden = true;
    return;
  }

  els.targetProgress.hidden = false;
  const first = item.stats && Number.isFinite(item.stats.first) ? item.stats.first : price;
  let percent = 0;

  if (Number.isFinite(price) && price <= target) {
    percent = 100;
    els.targetHint.textContent = `Цель достигнута: ${formatPrice(price)} ≤ ${formatPrice(target)}`;
  } else if (Number.isFinite(price) && Number.isFinite(first) && first > target) {
    percent = ((first - price) / (first - target)) * 100;
    const left = price - target;
    els.targetHint.textContent = `До цели ${formatPrice(left)} (${formatPercent((left / price) * 100, false)})`;
  } else if (Number.isFinite(price)) {
    percent = 0;
    els.targetHint.textContent = `Цена выше цели на ${formatPrice(price - target)}`;
  } else {
    els.targetHint.textContent = `Цель: ${formatPrice(target)}`;
  }

  els.targetBar.style.width = `${Math.max(2, Math.min(100, percent))}%`;
}

/* --------------------------------- состав --------------------------------- */

const INCI_TAG_LABELS = Object.fromEntries(
  Object.entries(INCI_TAG_META)
    .filter(([, meta]) => meta.label)
    .map(([tag, meta]) => [tag, meta.label])
);

function inciSeverity(tag) {
  return (INCI_TAG_META[tag] && INCI_TAG_META[tag].severity) || 'neutral';
}

function renderComposition(item) {
  const body = els.inciBody;
  if (!body) return;

  const verdict = els.inciVerdict;
  const raw = typeof item.composition === 'string' ? item.composition.trim() : '';

  if (!raw) {
    if (verdict) verdict.hidden = true;
    if (els.inciSub) els.inciSub.textContent = 'состав не сохранён';
    body.innerHTML = `<p class="inci-empty">Состав пока не сохранён. Откройте карточку товара и нажмите «Разобрать состав» в плашке — после этого разбор появится здесь.</p>`;
    return;
  }

  const analysis = analyzeInci(raw);

  if (verdict) {
    if (analysis.ok) {
      const level = analysis.verdict.level;
      verdict.hidden = false;
      verdict.className = `chip ${level === 'bad' ? 'bad' : level === 'warn' ? 'warn' : level === 'good' ? 'good' : 'neutral'}`;
      verdict.textContent = `состав: ${INCI_VERDICT_LABELS[level] || INCI_VERDICT_LABELS.neutral}`;
    } else {
      verdict.hidden = true;
    }
  }

  if (els.inciSub) {
    els.inciSub.textContent = analysis.ok
      ? `${analysis.total} ${plural(analysis.total, 'компонент', 'компонента', 'компонентов')} · ${analysis.matched} в локальной базе`
      : 'не удалось распознать список';
  }

  const flags = (analysis.flags || [])
    .map(
      (flag) =>
        `<span class="inci-flag ${inciSeverity(flag.tag)}" title="${escapeHtml(flag.note || '')}">${escapeHtml(
          flag.label
        )} · ${flag.count}</span>`
    )
    .join('');

  const ingredients = (analysis.ingredients || [])
    .map((ingredient) => {
      const tags = (ingredient.tags || [])
        .filter((tag) => INCI_TAG_LABELS[tag])
        .map(
          (tag) =>
            `<span class="inci-tag ${inciSeverity(tag)}">${escapeHtml(INCI_TAG_LABELS[tag])}</span>`
        )
        .join('');
      const unknown = ingredient.matched ? '' : '<span class="inci-tag unknown">нет в базе</span>';
      const note = ingredient.note ? `<div class="inci-note">${escapeHtml(ingredient.note)}</div>` : '';
      return `<div class="inci-item">
        <div class="inci-item-head">
          <span class="inci-name">${escapeHtml(ingredient.name)}</span>
          ${unknown}
          ${tags}
        </div>
        ${note}
      </div>`;
    })
    .join('');

  body.innerHTML = `
    ${flags ? `<div class="inci-flags">${flags}</div>` : ''}
    <div class="inci-verdict-text">${escapeHtml(analysis.verdict.text || '')}</div>
    <div class="inci-list">${ingredients}</div>
    <div class="inci-disclaimer">Локальная справочная база. Оценка не является медицинской рекомендацией.</div>
  `;
}

function renderDetail(item) {
  const stats = statsForRange(item, state.range);
  const price = Number.isFinite(item.price) ? item.price : null;
  const status = statusInfo(item);
  const store = storeMetaFromUrl(item.url);

  document.title = `${truncate(item.title, 55)} — Price Tracker`;

  els.detailTitle.textContent = item.title;
  if (els.storeChip) {
    els.storeChip.hidden = !store;
    els.storeChip.textContent = store ? store.label : '';
    els.storeChip.className = `chip muted-chip store-chip store-${store ? store.id : 'none'}`;
  }
  els.statusChip.textContent = status.text;
  els.statusChip.className = status.className;
  els.statusChip.title = item.error || '';

  els.sourceChip.textContent = `источник: ${SOURCE_LABELS[item.source] || item.source || '—'}`;

  if (item.image) {
    els.heroImg.src = item.image;
  } else {
    els.heroImg.removeAttribute('src');
  }

  els.openOzon.href = item.url;
  els.openOzon.textContent = store ? `Открыть на ${store.label} ↗` : 'Открыть товар ↗';

  els.bigPrice.textContent = price ? formatPrice(price) : '—';

  const firstEver = item.stats && Number.isFinite(item.stats.first) ? item.stats.first : null;
  if (price && firstEver) {
    const change = price - firstEver;
    const percent = (change / firstEver) * 100;
    if (Math.abs(percent) >= 0.1) {
      els.bigChange.hidden = false;
      els.bigChange.textContent = formatPercent(percent);
      els.bigChange.className = `big-change ${percent < 0 ? 'good' : 'bad'}`;
      els.bigChange.title = `${formatDelta(change)} с момента добавления`;
    } else {
      els.bigChange.hidden = true;
    }
  } else {
    els.bigChange.hidden = true;
  }

  const hitTarget = item.targetPrice && price && price <= item.targetPrice;
  els.targetHitChip.hidden = !hitTarget;

  if (item.error && (item.status === 'blocked' || item.status === 'error')) {
    els.errorNote.hidden = false;
    els.errorNote.textContent = item.error;
  } else {
    els.errorNote.hidden = true;
  }

  const points = item.stats && item.stats.points ? item.stats.points : 0;
  els.infoAdded.textContent = formatDate(item.addedAt);
  els.infoChecked.textContent = item.lastCheckAt ? formatRelative(item.lastCheckAt) : 'ещё не было';
  els.infoChecked.title = item.lastCheckAt ? formatDateTime(item.lastCheckAt) : '';
  els.infoPoints.textContent = `${points} ${plural(points, 'точка', 'точки', 'точек')}`;
  els.infoSource.textContent = SOURCE_LABELS[item.source] || item.source || '—';
  els.infoSku.textContent = item.sku || '—';

  const pointsInRange = stats.points || 0;
  els.chartSub.textContent = `${rangeLabel()} · ${pointsInRange} ${plural(
    pointsInRange,
    'точка',
    'точки',
    'точек'
  )} · обновлено ${item.lastCheckAt ? formatRelative(item.lastCheckAt) : '—'}`;

  renderStats(item, stats);
  renderTarget(item);
  renderComposition(item);
  scheduleDraw();
}

/* --------------------------------- график -------------------------------- */

function seriesFor(item, range) {
  const now = Date.now();
  const history = (Array.isArray(item.history) ? item.history : [])
    .filter((point) => point && Number.isFinite(point.t) && Number.isFinite(point.p) && point.p > 0)
    .slice()
    .sort((a, b) => a.t - b.t);

  if (!history.length) {
    if (!Number.isFinite(item.price)) return [];
    const start = item.addedAt || now - 86_400_000;
    return [
      { t: start, p: item.price, s: item.inStock ? 1 : 0 },
      { t: Math.max(now, start + 3_600_000), p: item.price, s: item.inStock ? 1 : 0 }
    ];
  }

  let points;
  if (range === 'all') {
    points = history;
  } else {
    const from = now - Number(range) * 86_400_000;
    const before = [...history].reverse().find((point) => point.t < from);
    const inside = history.filter((point) => point.t >= from);
    points = before ? [{ ...before, t: from }, ...inside] : inside;
  }

  if (!points.length) points = [history[history.length - 1]];
  if (points.length === 1) {
    const only = points[0];
    points = [only, { t: Math.max(now, only.t + 3_600_000), p: only.p, s: only.s, virtual: true }];
  }
  return points;
}

function niceTicks(min, max, target = 5) {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1];
  if (max <= min) {
    max = min + Math.max(1, min * 0.1);
  }
  const rough = (max - min) / target;
  const magnitude = Math.pow(10, Math.floor(Math.log10(rough || 1)));
  const normalized = rough / magnitude;
  const step =
    (normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 2.5 ? 2.5 : normalized <= 5 ? 5 : 10) * magnitude;
  const low = Math.max(0, Math.floor(min / step) * step);
  const high = Math.ceil(max / step) * step;
  const ticks = [];
  for (let value = low; value <= high + step * 0.001; value += step) {
    ticks.push(Math.round(value * 100) / 100);
  }
  return ticks;
}

function hideChartTip() {
  els.chartTip.hidden = true;
}

function scheduleDraw() {
  if (state.drawQueued) return;
  state.drawQueued = true;
  const run = () => {
    if (!state.drawQueued) return;
    state.drawQueued = false;
    drawChart();
  };
  // requestAnimationFrame может не сработать в фоновой вкладке — подстраховка.
  requestAnimationFrame(run);
  setTimeout(run, 250);
}

function drawChart() {
  const canvas = els.chartCanvas;
  const wrap = els.chartWrap;
  if (!canvas || !wrap) return;

  const item = currentItem();
  const series = item ? seriesFor(item, state.range) : [];
  els.chartEmpty.hidden = series.length > 0;

  const rect = wrap.getBoundingClientRect();
  const width = Math.max(120, Math.round(rect.width));
  const height = Math.max(120, Math.round(rect.height));
  const dpr = window.devicePixelRatio || 1;

  if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
  }
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;

  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  if (!series.length) {
    state.chart = null;
    hideChartTip();
    return;
  }

  const pad = { l: 62, r: 20, t: 16, b: 30 };
  const plotW = width - pad.l - pad.r;
  const plotH = height - pad.t - pad.b;
  if (plotW < 30 || plotH < 30) return;

  const from = series[0].t;
  const to = Math.max(Date.now(), series[series.length - 1].t);
  const values = series.map((point) => point.p);
  if (item && item.targetPrice) values.push(item.targetPrice);

  let min = Math.min(...values);
  let max = Math.max(...values);
  if (min === max) {
    min = Math.max(0, min * 0.95);
    max = max * 1.05 || min + 1;
  }

  const ticks = niceTicks(min, max, 5);
  const yMin = ticks[0];
  const yMax = ticks[ticks.length - 1];
  const xOf = (t) => pad.l + ((t - from) / (to - from || 1)) * plotW;
  const yOf = (p) => pad.t + (1 - (p - yMin) / (yMax - yMin || 1)) * plotH;

  const isFalling = series[series.length - 1].p <= series[0].p;
  const color = isFalling ? '#22d3a5' : '#ff7b7b';

  ctx.font = '10.5px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'right';

  for (const tick of ticks) {
    const y = yOf(tick);
    ctx.strokeStyle = 'rgba(255,255,255,0.055)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(pad.l, y);
    ctx.lineTo(width - pad.r, y);
    ctx.stroke();
    ctx.fillStyle = '#5f6f8c';
    ctx.fillText(formatInteger(tick), pad.l - 10, y);
  }

  const span = to - from;
  const tickCount = Math.max(2, Math.min(6, Math.floor(plotW / 105)));
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (let i = 0; i < tickCount; i++) {
    const t = from + (span * i) / (tickCount - 1);
    const x = xOf(t);
    ctx.strokeStyle = 'rgba(255,255,255,0.032)';
    ctx.beginPath();
    ctx.moveTo(x, pad.t);
    ctx.lineTo(x, pad.t + plotH);
    ctx.stroke();
    ctx.fillStyle = '#5f6f8c';
    ctx.fillText(formatAxisDate(t, span), x, height - pad.b + 9);
  }

  if (item && Number.isFinite(item.targetPrice) && item.targetPrice >= yMin && item.targetPrice <= yMax) {
    const y = yOf(item.targetPrice);
    ctx.save();
    ctx.strokeStyle = 'rgba(245,181,68,0.55)';
    ctx.lineWidth = 1.2;
    ctx.setLineDash([5, 5]);
    ctx.beginPath();
    ctx.moveTo(pad.l, y);
    ctx.lineTo(width - pad.r, y);
    ctx.stroke();
    ctx.restore();
    ctx.fillStyle = '#c9a25c';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    ctx.fillText(`цель ${formatInteger(item.targetPrice)}`, width - pad.r, y - 3);
  }

  const gradient = ctx.createLinearGradient(0, pad.t, 0, pad.t + plotH);
  gradient.addColorStop(0, isFalling ? 'rgba(34,211,165,0.26)' : 'rgba(255,123,123,0.22)');
  gradient.addColorStop(1, 'rgba(0,0,0,0)');

  // Заливка под ступенчатой линией.
  ctx.beginPath();
  ctx.moveTo(xOf(series[0].t), yOf(series[0].p));
  for (let i = 1; i < series.length; i++) {
    ctx.lineTo(xOf(series[i].t), yOf(series[i - 1].p));
    ctx.lineTo(xOf(series[i].t), yOf(series[i].p));
  }
  ctx.lineTo(xOf(to), yOf(series[series.length - 1].p));
  ctx.lineTo(xOf(to), pad.t + plotH);
  ctx.lineTo(xOf(series[0].t), pad.t + plotH);
  ctx.closePath();
  ctx.fillStyle = gradient;
  ctx.fill();

  // Сама линия.
  ctx.beginPath();
  ctx.moveTo(xOf(series[0].t), yOf(series[0].p));
  for (let i = 1; i < series.length; i++) {
    ctx.lineTo(xOf(series[i].t), yOf(series[i - 1].p));
    ctx.lineTo(xOf(series[i].t), yOf(series[i].p));
  }
  ctx.lineTo(xOf(to), yOf(series[series.length - 1].p));
  ctx.strokeStyle = color;
  ctx.lineWidth = 2.2;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.stroke();

  const lastX = xOf(to);
  const lastY = yOf(series[series.length - 1].p);
  ctx.beginPath();
  ctx.arc(lastX, lastY, 4.2, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.strokeStyle = '#0a1220';
  ctx.lineWidth = 2;
  ctx.stroke();

  state.chart = {
    series,
    from,
    to,
    pad,
    plotW,
    plotH,
    width,
    height,
    xOf,
    yOf
  };

  if (state.hoverT != null) {
    const hoverT = Math.min(to, Math.max(from, state.hoverT));
    let point = series[0];
    for (const candidate of series) {
      if (candidate.t <= hoverT) point = candidate;
      else break;
    }
    const hx = xOf(hoverT);
    const hy = yOf(point.p);

    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.28)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(hx, pad.t);
    ctx.lineTo(hx, pad.t + plotH);
    ctx.stroke();
    ctx.restore();

    ctx.beginPath();
    ctx.arc(hx, hy, 4, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.strokeStyle = '#0a1220';
    ctx.lineWidth = 2;
    ctx.stroke();

    els.chartTip.innerHTML = `<b>${escapeHtml(formatPrice(point.p))}</b><span>${escapeHtml(
      formatDateTime(hoverT)
    )}</span>`;
    els.chartTip.style.left = `${Math.min(width - 72, Math.max(72, hx))}px`;
    els.chartTip.style.top = `${Math.max(58, hy)}px`;
    els.chartTip.hidden = false;
  } else {
    hideChartTip();
  }
}

/* --------------------------------- рендер -------------------------------- */

function updateBanner() {
  const dismissed = sessionStorage.getItem('opt-banner-dismissed') === '1';
  els.banner.hidden = dismissed || allItems().length > 0;
}

function renderFooter() {
  const items = allItems();
  if (state.busy || (state.data && state.data.refreshing)) {
    els.sideStatus.textContent = 'Обновляем цены…';
    return;
  }
  if (!items.length) {
    els.sideStatus.textContent = 'Нет товаров';
    return;
  }
  const last = Math.max(...items.map((item) => item.lastCheckAt || 0));
  els.sideStatus.textContent = last ? `Обновлено ${formatRelative(last)}` : 'Ожидает проверки';
}

function render() {
  const items = allItems();

  if (state.selectedId && !items.some((item) => item.id === state.selectedId)) {
    state.selectedId = null;
  }
  if (!state.selectedId && items.length) state.selectedId = items[0].id;

  renderSidebar();
  renderFooter();
  updateBanner();

  const item = currentItem();
  if (item) {
    els.detail.hidden = false;
    els.empty.hidden = true;
    renderDetail(item);
  } else {
    els.detail.hidden = true;
    els.empty.hidden = false;
    els.statsGrid.innerHTML = '';
    document.title = 'Price Tracker — панель цен';
    hideChartTip();
  }
}

/* -------------------------------- действия ------------------------------ */

async function addByUrl() {
  const url = els.addUrlInput.value.trim();
  if (!url) {
    els.addUrlInput.focus();
    return;
  }
  els.addUrlBtn.disabled = true;
  const response = await call('ADD_URL', { url });
  els.addUrlBtn.disabled = false;

  if (response.ok) {
    els.addUrlInput.value = '';
    await loadState();
    if (response.item && response.item.id) selectItem(response.item.id);
    else render();
    showToast('Товар добавлен, цена подтянется в фоне');
  } else {
    showToast(response.error || 'Не удалось распознать ссылку', true);
  }
}

async function refreshAll() {
  if (state.busy) return;
  state.busy = true;
  els.refreshAllBtn.disabled = true;
  els.refreshAllBtn.textContent = 'Обновляем…';
  renderFooter();

  const response = await call('REFRESH_ALL', { force: true });

  state.busy = false;
  els.refreshAllBtn.disabled = false;
  els.refreshAllBtn.innerHTML = state.refreshButtonHtml;
  await loadState();
  render();

  if (response.ok) {
    if (!response.total) {
      showToast('Список пуст — добавьте товар');
    } else {
      const failed = response.failed ? `, ошибок: ${response.failed}` : '';
      showToast(`Готово: обновлено ${response.updated} из ${response.total}${failed}`);
    }
  } else {
    showToast(response.error || 'Не удалось обновить цены', true);
  }
}

async function checkNow() {
  const item = currentItem();
  if (!item) return;
  els.checkNowBtn.disabled = true;
  const original = els.checkNowBtn.textContent;
  els.checkNowBtn.textContent = 'Проверяем…';
  const response = await call('REFRESH_ITEM', { id: item.id });
  els.checkNowBtn.disabled = false;
  els.checkNowBtn.textContent = original;
  await loadState();
  render();
  if (response.ok) showToast('Цена обновлена');
  else showToast(response.error || 'Не удалось обновить цену', true);
}

async function deleteCurrent() {
  const item = currentItem();
  if (!item) return;
  if (!confirm(`Удалить «${truncate(item.title, 80)}» из отслеживания?`)) return;
  const response = await call('REMOVE_ITEM', { id: item.id });
  if (response.ok) {
    state.selectedId = null;
    await loadState();
    const first = allItems()[0];
    if (first) selectItem(first.id);
    else {
      try {
        history.replaceState(null, '', location.pathname);
      } catch {
        /* ignore */
      }
      render();
    }
    showToast('Товар удалён');
  } else {
    showToast(response.error || 'Не удалось удалить товар', true);
  }
}

async function saveTarget() {
  const item = currentItem();
  if (!item) return;
  const raw = els.targetInput.value.trim();
  const value = raw ? Number(raw.replace(/\s/g, '').replace(',', '.')) : null;
  if (raw && (!Number.isFinite(value) || value <= 0)) {
    showToast('Введите корректную цену', true);
    return;
  }
  const response = await call('SET_TARGET', { id: item.id, targetPrice: value });
  if (response.ok) {
    await loadState();
    render();
    showToast(value ? 'Целевая цена сохранена' : 'Целевая цена сброшена');
  } else {
    showToast(response.error || 'Не удалось сохранить цель', true);
  }
}

async function clearHistory() {
  const item = currentItem();
  if (!item) return;
  if (!confirm('Очистить всю историю цен этого товара? Текущая цена останется.')) return;
  const response = await call('CLEAR_HISTORY', { id: item.id });
  if (response.ok) {
    await loadState();
    render();
    showToast('История очищена');
  }
}

/* ------------------------------- настройки ------------------------------- */

function populateIntervalOptions() {
  const current = state.data && state.data.settings ? Number(state.data.settings.intervalMinutes) : 360;
  const values = new Set(INTERVAL_OPTIONS.map((option) => option.value));
  els.setInterval.innerHTML = INTERVAL_OPTIONS.map(
    (option) => `<option value="${option.value}">${option.label}</option>`
  ).join('');
  if (!values.has(current)) {
    const option = document.createElement('option');
    option.value = String(current);
    option.textContent = `каждые ${current} мин`;
    els.setInterval.appendChild(option);
  }
}

function syncNotifyControls() {
  const enabled = els.setNotify.checked;
  els.setPercent.disabled = !enabled;
  els.setTargetNotify.disabled = !enabled;
}

function openSettings() {
  if (!state.data) return;
  const settings = state.data.settings;
  populateIntervalOptions();
  els.setInterval.value = String(settings.intervalMinutes);
  els.setNotify.checked = Boolean(settings.notifyOnDrop);
  els.setPercent.value = String(settings.notifyPercent);
  els.setTargetNotify.checked = Boolean(settings.notifyTarget);
  els.setTabFallback.checked = Boolean(settings.tabFallback);
  els.setLimit.value = String(settings.historyLimit);
  syncNotifyControls();
  els.settingsModal.hidden = false;
  state.settingsOpen = true;
}

function closeSettings() {
  els.settingsModal.hidden = true;
  state.settingsOpen = false;
  if (location.hash.includes('settings')) {
    const hash = state.selectedId ? `#item=${encodeURIComponent(state.selectedId)}` : '';
    try {
      history.replaceState(null, '', location.pathname + hash);
    } catch {
      /* ignore */
    }
  }
}

async function saveSettings() {
  const settings = {
    intervalMinutes: Number(els.setInterval.value),
    notifyOnDrop: els.setNotify.checked,
    notifyPercent: Number(els.setPercent.value),
    notifyTarget: els.setTargetNotify.checked,
    tabFallback: els.setTabFallback.checked,
    historyLimit: Number(els.setLimit.value)
  };
  const response = await call('SET_SETTINGS', { settings });
  if (response.ok) {
    if (state.data) state.data.settings = response.settings;
    closeSettings();
    renderFooter();
    showToast('Настройки сохранены');
  } else {
    showToast(response.error || 'Не удалось сохранить настройки', true);
  }
}

async function clearAll() {
  if (!confirm('Удалить ВСЕ товары и всю историю цен? Это действие нельзя отменить.')) return;
  const response = await call('CLEAR_ALL');
  if (response.ok) {
    state.selectedId = null;
    closeSettings();
    await loadState();
    try {
      history.replaceState(null, '', location.pathname);
    } catch {
      /* ignore */
    }
    render();
    showToast('Все данные удалены');
  }
}

/* -------------------------------- импорт/экспорт -------------------------- */

async function exportData() {
  const response = await call('EXPORT_DATA');
  if (!response || !Array.isArray(response.items)) {
    showToast('Не удалось подготовить экспорт', true);
    return;
  }
  const blob = new Blob([JSON.stringify(response, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const date = new Date();
  const stamp = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate()
  ).padStart(2, '0')}`;
  const link = document.createElement('a');
  link.href = url;
  link.download = `prices-${stamp}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2500);
  showToast(`Экспортировано товаров: ${response.items.length}`);
}

async function importFile(file) {
  if (!file) return;
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    if (!data || (!Array.isArray(data) && !Array.isArray(data.items))) {
      throw new Error('В файле нет списка товаров');
    }
    const response = await call('IMPORT_DATA', { data, mode: 'merge' });
    if (response.ok) {
      await loadState();
      const first = allItems()[0];
      if (first && !currentItem()) selectItem(first.id);
      else render();
      showToast(`Импортировано товаров: ${response.imported}`);
    } else {
      showToast(response.error || 'Не удалось импортировать', true);
    }
  } catch (error) {
    showToast(`Ошибка импорта: ${error.message}`, true);
  } finally {
    els.importFile.value = '';
  }
}

/* --------------------------------- события ------------------------------- */

els.itemList.addEventListener('click', (event) => {
  const row = event.target.closest('.side-item');
  if (row && row.dataset.id) selectItem(row.dataset.id);
});

els.searchInput.addEventListener('input', () => {
  state.search = els.searchInput.value;
  renderSidebar();
});

els.addUrlBtn.addEventListener('click', addByUrl);
els.addUrlInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    addByUrl();
  }
});

els.refreshAllBtn.addEventListener('click', refreshAll);
els.checkNowBtn.addEventListener('click', checkNow);
els.deleteBtn.addEventListener('click', deleteCurrent);
els.saveTargetBtn.addEventListener('click', saveTarget);
els.targetInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    saveTarget();
  }
});
els.clearTargetBtn.addEventListener('click', () => {
  els.targetInput.value = '';
  saveTarget();
});
els.clearHistoryBtn.addEventListener('click', clearHistory);

els.rangeButtons.addEventListener('click', (event) => {
  const button = event.target.closest('[data-range]');
  if (!button) return;
  const value = button.dataset.range;
  state.range = value === 'all' ? 'all' : Number(value);
  state.hoverT = null;
  els.rangeButtons.querySelectorAll('button').forEach((entry) => {
    entry.classList.toggle('active', entry === button);
  });
  render();
});

els.chartCanvas.addEventListener('mousemove', (event) => {
  if (!state.chart) return;
  const rect = els.chartCanvas.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const { pad, plotW, from, to } = state.chart;
  if (x < pad.l || x > pad.l + plotW) {
    state.hoverT = null;
    scheduleDraw();
    return;
  }
  state.hoverT = from + ((x - pad.l) / plotW) * (to - from);
  scheduleDraw();
});

els.chartCanvas.addEventListener('mouseleave', () => {
  state.hoverT = null;
  scheduleDraw();
});

els.bannerClose.addEventListener('click', () => {
  sessionStorage.setItem('opt-banner-dismissed', '1');
  els.banner.hidden = true;
});

els.emptyOzonBtn.addEventListener('click', () => {
  chrome.tabs.create({ url: 'https://www.ozon.ru/' });
});

els.settingsBtn.addEventListener('click', openSettings);
els.closeSettings.addEventListener('click', closeSettings);
els.cancelSettings.addEventListener('click', closeSettings);
els.saveSettingsBtn.addEventListener('click', saveSettings);
els.setNotify.addEventListener('change', syncNotifyControls);
els.clearAllBtn.addEventListener('click', clearAll);

els.settingsModal.addEventListener('click', (event) => {
  if (event.target === els.settingsModal) closeSettings();
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && state.settingsOpen) closeSettings();
});

els.exportBtn.addEventListener('click', exportData);
els.importBtn.addEventListener('click', () => els.importFile.click());
els.importFile.addEventListener('change', () => importFile(els.importFile.files && els.importFile.files[0]));

els.heroImg.addEventListener('error', () => els.heroImg.removeAttribute('src'));

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (!changes.items && !changes.settings) return;
  loadState()
    .then(() => render())
    .catch(() => undefined);
});

chrome.runtime.onMessage.addListener((message) => {
  if (!message || message.type !== 'REFRESH_PROGRESS') return;
  if (state.busy && message.total) {
    els.sideStatus.textContent = `Обновляем ${message.done} из ${message.total}…`;
  }
});

window.addEventListener('hashchange', () => {
  const parsed = parseHash();
  if (parsed.type === 'item' && parsed.id) {
    if (parsed.id !== state.selectedId) selectItem(parsed.id, false);
  } else if (parsed.type === 'settings') {
    openSettings();
  }
});

const resizeObserver = new ResizeObserver(() => scheduleDraw());
resizeObserver.observe(els.chartWrap);

/* --------------------------------- запуск -------------------------------- */

(async () => {
  state.refreshButtonHtml = els.refreshAllBtn.innerHTML;
  const parsed = parseHash();

  let stored = null;
  try {
    stored = localStorage.getItem('opt-selected');
  } catch {
    stored = null;
  }
  state.selectedId = parsed.type === 'item' ? parsed.id : stored;

  await loadState();
  render();

  if (parsed.type === 'settings') openSettings();
})();
