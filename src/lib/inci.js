/**
 * Разбор состава косметики (INCI) и локальная оценка компонентов.
 * Чистый модуль: используется service worker'ом и панелью истории.
 */

import { INCI_DB, INCI_PATTERNS } from '../data/inci-db.js';

export const INCI_TAG_META = Object.freeze({
  allergen: { label: 'аллерген', severity: 'bad', flag: true, note: 'Потенциальный аллерген; при чувствительной коже стоит проверить реакцию.' },
  irritant: { label: 'раздражитель', severity: 'warn', flag: true, note: 'Может раздражать чувствительную кожу.' },
  comedogenic: { label: 'комедогенный', severity: 'warn', flag: true, note: 'Может забивать поры у кожи, склонной к акне.' },
  phototoxic: { label: 'фототоксичность', severity: 'warn', flag: true, note: 'Фуранокумарины повышают чувствительность кожи к солнцу.' },
  fragrance: { label: 'отдушка', severity: 'warn', flag: true, note: 'Ароматический компонент.' },
  alcohol: { label: 'спирт', severity: 'warn', flag: true, note: 'Спирт может сушить кожу.' },
  sulfate: { label: 'сульфат', severity: 'warn', flag: true, note: 'Агрессивное поверхностно-активное вещество.' },
  controversial: { label: 'спорный', severity: 'neutral', flag: true, note: 'Спорный компонент: оценки безопасности расходятся.' },
  preservative: { label: 'консервант', severity: 'neutral', flag: true, note: 'Консервант.' },
  silicone: { label: 'силикон', severity: 'neutral', flag: false, note: 'Создаёт защитную плёнку и уменьшает сухость.' },
  uv: { label: 'UV-фильтр', severity: 'neutral', flag: false, note: 'Защищает от ультрафиолета.' },
  soothing: { label: 'успокаивает', severity: 'good', flag: false, note: 'Успокаивающий компонент.' },
  humectant: { label: 'увлажняет', severity: 'good', flag: false, note: 'Притягивает и удерживает влагу.' },
  antioxidant: { label: 'антиоксидант', severity: 'good', flag: false, note: 'Антиоксидант.' },
  active: { label: 'актив', severity: 'good', flag: false, note: 'Активный компонент.' },
  emollient: { label: 'смягчает', severity: 'good', flag: false, note: 'Смягчает кожу.' },
  oil: { label: 'масло', severity: 'neutral', flag: false, note: 'Масло.' },
  wax: { label: 'воск', severity: 'neutral', flag: false, note: 'Воск.' },
  emulsifier: { label: 'эмульгатор', severity: 'neutral', flag: false, note: 'Эмульгатор.' },
  surfactant: { label: 'ПАВ', severity: 'neutral', flag: false, note: 'Поверхностно-активное вещество.' },
  pigment: { label: 'пигмент', severity: 'neutral', flag: false, note: 'Пигмент.' },
  thickener: { label: 'загуститель', severity: 'neutral', flag: false, note: 'Загуститель.' },
  film: { label: 'плёнка', severity: 'neutral', flag: false, note: 'Плёнкообразователь.' },
  absorbent: { label: 'абсорбент', severity: 'neutral', flag: false, note: 'Впитывает влагу и кожное сало.' },
  peptide: { label: 'пептид', severity: 'good', flag: false, note: 'Пептид.' },
  base: { label: '', severity: 'neutral', flag: false, note: '' },
  solvent: { label: '', severity: 'neutral', flag: false, note: '' },
  solubilizer: { label: '', severity: 'neutral', flag: false, note: '' },
  ph: { label: '', severity: 'neutral', flag: false, note: '' },
  chelator: { label: '', severity: 'neutral', flag: false, note: '' },
  botanical: { label: 'экстракт', severity: 'neutral', flag: false, note: 'Растительный компонент; свойства зависят от сырья.' },
  protein: { label: 'протеин', severity: 'neutral', flag: false, note: 'Белковый гидролизат; возможна индивидуальная реакция.' },
  conditioner: { label: 'кондиционирует', severity: 'neutral', flag: false, note: 'Катионный компонент для волос: облегчает расчёсывание.' },
  antiperspirant: { label: 'антиперспирант', severity: 'neutral', flag: false, note: 'Соль алюминия снижает потоотделение.' },
  dye: { label: 'краситель', severity: 'neutral', flag: false, note: 'Компонент красителя для волос.' },
  fluoride: { label: 'фторид', severity: 'good', flag: false, note: 'Соединение фтора: укрепляет эмаль.' }
});

export const INCI_FLAG_TAGS = Object.freeze([
  'allergen',
  'irritant',
  'comedogenic',
  'phototoxic',
  'sulfate',
  'fragrance',
  'alcohol',
  'controversial',
  'preservative'
]);

const POSITIVE_TAGS = ['soothing', 'humectant', 'antioxidant', 'active', 'emollient', 'peptide', 'fluoride'];
const PROBLEM_TAGS = ['allergen', 'irritant', 'comedogenic', 'sulfate'];

const STOP_SECTION = /(?:способ применения|меры предосторожности|противопоказания|инструкция по применению|производитель|изготовитель|импорт[её]р|срок годности|условия хранения|страна производства|объ[её]м|вес нетто|бренд|артикул|отзывы|доставка|состав на|дата производства)/i;

const LABEL_RE = /(?:^|\n)\s*(?:состав\s+товара|состав|ингредиенты|ingredients|inci)\s*[:\-—]?\s*/i;
const INLINE_LABEL_RE = /(?:состав|ингредиенты|ingredients|inci)\s*[:\-—]\s*/i;
const MAY_CONTAIN_RE = /(?:может содержать|может включать|may contain)\s*[:\-—]?\s*/i;

/** Приводит сырой текст к виду «список ингредиентов без заголовков и пояснений». */
export function cleanComposition(raw) {
  if (typeof raw !== 'string') return '';
  let text = raw
    .replace(/\r/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n');

  const label = text.match(LABEL_RE) || text.match(INLINE_LABEL_RE);
  if (label) text = text.slice(label.index + label[0].length);

  text = text.replace(MAY_CONTAIN_RE, ', ');
  text = text.replace(/^[\s:;,.•·\-–—]+/, '');

  const stop = text.match(STOP_SECTION);
  if (stop && stop.index > 20) text = text.slice(0, stop.index);

  return text
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
    .replace(/[\s,;]+$/, '')
    .trim();
}

/** Этоксилаты и полимеры пишут то через дефис, то через пробел: PEG 32 / PEG-32. */
const ETHOXYLATE_RE =
  /\b(peg|ppg|peg\/ppg|poloxamer|ceteareth|steareth|ceteth|oleth|laureth|beheneth|isoceteth|isosteareth|trideceth|deceth|glycereth|pareth|nonoxynol|octoxynol)\s*[-–—]?\s*(\d+)/g;

/** Нормализует название для поиска в базе: без скобок, процентов и лишней пунктуации. */
export function normalizeInciName(value) {
  let text = String(value || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[\u00a0\u200b]/g, ' ');
  text = text.replace(/\([^)]*\)/g, ' ');
  text = text.replace(/\b\d+(?:[.,]\d+)?\s*%/g, ' ');
  text = text.replace(/\s*&\s*/g, ' and ');
  text = text.replace(/\bci\s*(\d{4,5})\b/g, 'ci $1');
  text = text.replace(ETHOXYLATE_RE, '$1-$2');
  text = text.replace(/^[\s\-–—•·*:;,.]+|[\s\-–—•·*:;,.]+$/g, '');
  return text.replace(/\s+/g, ' ').trim();
}

/** Делит состав на отдельные ингредиенты, не разрывая скобки. */
export function splitInci(raw) {
  const text = cleanComposition(raw);
  if (!text) return [];

  const tokens = [];
  const push = (value) => {
    const token = String(value)
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^[\s.:;\-–—•·]+|[\s.:;\-–—•·]+$/g, '')
      .trim();
    if (!token || token.length < 2) return;
    if (/^(?:состав|ингредиенты|ingredients|inci|может содержать|may contain)$/i.test(token)) return;
    if (!/[a-zа-яё]/i.test(token)) return;
    tokens.push(token);
  };

  for (const line of text.split('\n')) {
    let depth = 0;
    let current = '';
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === '(') depth++;
      else if (char === ')') depth = Math.max(0, depth - 1);

      // Запятая между цифрами — часть названия (1,2-HEXANEDIOL, PEG-40,3), а не разделитель.
      const decimalComma = char === ',' && /\d/.test(line[i - 1] || '') && /\d/.test(line[i + 1] || '');

      if (depth === 0 && !decimalComma && /[,;•·]/.test(char)) {
        push(current);
        current = '';
      } else {
        current += char;
      }
    }
    push(current);
  }
  return tokens;
}

/** Похоже ли содержимое на настоящий список INCI, а не на абзац описания. */
export function isLikelyComposition(raw) {
  const tokens = Array.isArray(raw) ? raw : splitInci(raw);
  if (tokens.length < 3) return false;
  const joined = tokens.join(', ');
  const latinHint = /(?:aqua|water|parfum|glycerin|alcohol|sodium|acid|extract|oil|butter|wax|glycol|silicone|dimethicone|tocopherol|hydroxide|chloride|ci \d{4,5})/i;
  const ruHint = /(?:вода|глицерин|масло|кислота|экстракт|отдушка|спирт|натри|кали|воск|гликоль|силикон|витамин)/i;
  if (!latinHint.test(joined) && !ruHint.test(joined)) return false;
  const alphabetical = tokens.filter((token) => /[a-zа-яё]/i.test(token)).length;
  return alphabetical / tokens.length >= 0.7;
}

/** Разбивает составное название на части: «AQUA/WATER/EAU», «GLYCERIN AND WATER». */
function compoundParts(key) {
  return key.split(/\s*\/\s*|\s+and\s+|\s*\+\s*/);
}

function lookupInci(key) {
  if (!key) return null;
  const exact = INCI_DB[key];
  if (exact) return exact;

  for (const part of compoundParts(key)) {
    const clean = part.trim();
    if (clean && clean !== key && INCI_DB[clean]) return INCI_DB[clean];
  }

  for (const rule of INCI_PATTERNS) {
    if (rule.re.test(key)) return rule.make(key);
  }
  return null;
}

/** Короткое пояснение для ингредиента: своё или из первого тега. */
export function ingredientNote(ingredient) {
  if (!ingredient) return '';
  if (ingredient.note) return ingredient.note;
  for (const tag of ingredient.tags || []) {
    const meta = INCI_TAG_META[tag];
    if (meta && meta.note) return meta.note;
  }
  return '';
}

/** Теги, которые стоит показать рядом с ингредиентом. */
export function visibleTags(ingredient) {
  const tags = [];
  for (const tag of (ingredient && ingredient.tags) || []) {
    const meta = INCI_TAG_META[tag];
    if (!meta || !meta.label) continue;
    if (tags.some((entry) => entry.tag === tag)) continue;
    tags.push({ tag, ...meta });
  }
  return tags;
}

/**
 * Разбирает состав и возвращает сводку, флаги и список ингредиентов.
 * @param {string} raw
 */
export function analyzeInci(raw) {
  const tokens = splitInci(raw);
  const seen = new Set();
  const ingredients = [];

  for (const token of tokens) {
    const key = normalizeInciName(token);
    if (!key || seen.has(key)) continue;
    seen.add(key);

    const entry = lookupInci(key);
    if (entry) {
      ingredients.push({
        raw: token,
        key,
        name: entry.name,
        tags: Array.isArray(entry.tags) ? entry.tags : [],
        note: entry.note || '',
        matched: true
      });
    } else {
      ingredients.push({ raw: token, key, name: token, tags: [], note: '', matched: false });
    }
  }

  const counts = {};
  const positiveCounts = {};
  for (const ingredient of ingredients) {
    for (const tag of ingredient.tags) {
      counts[tag] = (counts[tag] || 0) + 1;
      if (POSITIVE_TAGS.includes(tag)) positiveCounts[tag] = (positiveCounts[tag] || 0) + 1;
    }
  }

  const flags = INCI_FLAG_TAGS.filter((tag) => counts[tag] > 0).map((tag) => ({
    tag,
    count: counts[tag],
    ...INCI_TAG_META[tag]
  }));

  const positives = POSITIVE_TAGS.filter((tag) => positiveCounts[tag] > 0).map((tag) => ({
    tag,
    count: positiveCounts[tag],
    ...INCI_TAG_META[tag]
  }));

  const matched = ingredients.filter((ingredient) => ingredient.matched).length;
  const allergen = counts.allergen || 0;
  const irritant = counts.irritant || 0;
  const comedogenic = counts.comedogenic || 0;
  const problem = ingredients.filter((ingredient) =>
    ingredient.tags.some((tag) => PROBLEM_TAGS.includes(tag))
  ).length;

  let level = 'neutral';
  let text = '';

  if (!ingredients.length) {
    level = 'neutral';
    text = 'Состав не распознан.';
  } else if (matched === 0) {
    level = 'neutral';
    text = 'Компонентов нет в локальной базе — показан только список ингредиентов.';
  } else if (allergen >= 5 || problem >= 8) {
    level = 'bad';
    text = 'В составе много потенциальных аллергенов или раздражителей. Будьте осторожны, особенно при чувствительной коже.';
  } else if (allergen >= 2 || irritant >= 2 || comedogenic >= 2 || problem >= 4) {
    level = 'warn';
    text = 'В составе есть потенциальные аллергены или раздражители. Стоит проверить реакцию на небольшом участке кожи.';
  } else if (problem >= 1) {
    level = 'neutral';
    text = 'Есть отдельные компоненты, которые могут не подойти чувствительной коже.';
  } else {
    level = 'good';
    text = 'Заметных аллергенов и раздражителей в локальной базе не найдено.';
  }

  return {
    ok: ingredients.length > 0,
    text: cleanComposition(raw),
    total: ingredients.length,
    matched,
    unknown: ingredients.length - matched,
    ingredients,
    flags,
    positives,
    counts,
    verdict: { level, text }
  };
}

export function normalizeComposition(raw) {
  const text = cleanComposition(raw);
  if (!text) return null;
  return text.slice(0, 20000);
}

export const INCI_VERDICT_LABELS = Object.freeze({
  good: 'спокойный',
  neutral: 'есть нюансы',
  warn: 'есть риски',
  bad: 'много рисков'
});
