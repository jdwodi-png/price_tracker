import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { INCI_DB, INCI_DB_STATS, INCI_PATTERNS, RU_ALIASES } from '../src/data/inci-db.js';
import {
  INCI_TAG_META,
  analyzeInci,
  isLikelyComposition,
  normalizeInciName,
  splitInci
} from '../src/lib/inci.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DB_SOURCE = path.join(ROOT, 'src', 'data', 'inci-db.js');

/** Реалистичные составы с карточек Ozon, WB, Золотого яблока и Летуаль. */
const CORPUS = [
  [
    'крем с церамидами',
    'AQUA/WATER/EAU, GLYCERIN, CETEARYL ALCOHOL, CAPRYLIC/CAPRIC TRIGLYCERIDE, CETYL ALCOHOL, CETEARETH-20, ' +
      'PETROLATUM, DIMETHICONE, PHENOXYETHANOL, POLYSORBATE 20, BEHENTRIMONIUM METHOSULFATE, ' +
      'POLYGLYCERYL-3 DIISOSTEARATE, SODIUM LAUROYL LACTYLATE, CERAMIDE NP, CERAMIDE AP, CERAMIDE EOP, CARBOMER, ' +
      'METHYLPARABEN, SODIUM HYALURONATE, CHOLESTEROL, DISODIUM EDTA, PROPYLPARABEN, HYDROLYZED HYALURONIC ACID, ' +
      'PHYTOSPHINGOSINE, XANTHAN GUM'
  ],
  [
    'сыворотка с ниацинамидом',
    'AQUA (WATER), ETHOXYDIGLYCOL, NIACINAMIDE, PENTYLENE GLYCOL, ZINC PCA, TAMARINDUS INDICA SEED GUM, ' +
      'DIMETHYL ISOSORBIDE, ISOCETETH-20, ETHYLHEXYLGLYCERIN, PHENOXYETHANOL, CHLORPHENESIN, ' +
      'TRISODIUM ETHYLENEDIAMINE DISUCCINATE'
  ],
  [
    'увлажняющий крем',
    'AQUA, GLYCERIN, ISONONYL ISONONANOATE, DIMETHICONE, CETEARETH-20, CETEARYL ALCOHOL, ' +
      'CAPRYLIC/CAPRIC TRIGLYCERIDE, NIACINAMIDE, BUTYLENE GLYCOL, PEG-100 STEARATE, GLYCERYL STEARATE, TOCOPHEROL, ' +
      'SODIUM HYALURONATE, CERAMIDE NP, AMMONIUM POLYACRYLOYLDIMETHYL TAURATE, HYDROXYACETOPHENONE, CAPRYLYL GLYCOL, ' +
      'CITRIC ACID, TRISODIUM ETHYLENEDIAMINE DISUCCINATE, PARFUM'
  ],
  [
    'питательный лосьон',
    'AQUA, GLYCERIN, ISOPROPYL PALMITATE, CETEARYL ALCOHOL, HYDROGENATED COCO-GLYCERIDES, GLYCERYL STEARATE CITRATE, ' +
      'SQUALANE, PANTHENOL, TOCOPHERYL ACETATE, DIMETHICONE, SODIUM CARBOMER, PHENOXYETHANOL, METHYLPARABEN, ' +
      'LINALOOL, CITRONELLOL, GERANIOL, PARFUM'
  ],
  [
    'шампунь',
    'AQUA, SODIUM LAURETH SULFATE, COCAMIDOPROPYL BETAINE, SODIUM CHLORIDE, GLYCERIN, GLYCOL DISTEARATE, DIMETHICONE, ' +
      'CARBOMER, SODIUM BENZOATE, SODIUM HYDROXIDE, CITRIC ACID, POLYQUATERNIUM-10, SALICYLIC ACID, ' +
      'ARGANIA SPINOSA KERNEL OIL, BENZYL ALCOHOL, BENZYL SALICYLATE, LINALOOL, LIMONENE, PARFUM'
  ],
  [
    'сыворотка с ферментами',
    'AQUA, BIFIDA FERMENT LYSATE, GLYCERIN, ALCOHOL DENAT, DIMETHICONE, HYDROXYETHYLPIPERAZINE ETHANE SULFONIC ACID, ' +
      'PEG-20 METHYL GLUCOSE SESQUISTEARATE, PEG-60 HYDROGENATED CASTOR OIL, SODIUM HYALURONATE, ADENOSINE, ' +
      'AMMONIUM POLYACRYLDIMETHYLTAURAMIDE, CAPRYLYL GLYCOL, CITRIC ACID, TRISODIUM ETHYLENEDIAMINE DISUCCINATE, ' +
      'BIOSACCHARIDE GUM-1, PARFUM'
  ],
  [
    'пудра',
    'TALC, MICA, BORON NITRIDE, SILICA, DIMETHICONE, ZEA MAYS STARCH, OCTYLDODECYL STEAROYL STEARATE, ' +
      'TRIMETHYLSILOXYSILICATE, PHENOXYETHANOL, TOCOPHERYL ACETATE, CI 77891, CI 77492, CI 77491, CI 77499'
  ],
  [
    'мицеллярная вода',
    'AQUA, HEXYLENE GLYCOL, GLYCERIN, POLOXAMER 188, DISODIUM EDTA, POLYAMINOPROPYL BIGUANIDE, CITRIC ACID'
  ],
  [
    'дезодорант',
    'AQUA, ALUMINUM CHLOROHYDRATE, GLYCERIN, STEARETH-2, STEARETH-21, PARFUM, DIMETHICONE, CETEARYL ALCOHOL, LIMONENE'
  ],
  [
    'блеск для губ',
    'POLYBUTENE, HYDROGENATED POLYISOBUTENE, OCTYLDODECANOL, CERA ALBA, SILICA DIMETHYL SILYLATE, ' +
      'TOCOPHERYL ACETATE, MICA, CI 15850, CI 77491, PARFUM'
  ],
  [
    'солнцезащитный спрей',
    'ALCOHOL DENAT, DIBUTYL ADIPATE, DICAPRYLYL CARBONATE, BIS-ETHYLHEXYLOXYPHENOL METHOXYPHENYL TRIAZINE, ' +
      'DIETHYLAMINO HYDROXYBENZOYL HEXYL BENZOATE, ETHYLHEXYL TRIAZONE, GLYCERIN, TOCOPHEROL, PARFUM, LIMONENE'
  ],
  [
    'зубная паста',
    'SORBITOL, AQUA, HYDRATED SILICA, SODIUM LAURYL SULFATE, PEG-32, AROMA, CELLULOSE GUM, SODIUM FLUORIDE, ' +
      'SODIUM SACCHARIN, LIMONENE'
  ],
  [
    'маска для волос',
    'AQUA, CETEARYL ALCOHOL, BEHENTRIMONIUM CHLORIDE, GLYCERIN, AMODIMETHICONE, CETRIMONIUM CHLORIDE, ' +
      'HYDROLYZED WHEAT PROTEIN, PANTHENOL, ARGANIA SPINOSA KERNEL OIL, TOCOPHERYL ACETATE, ISOPROPYL ALCOHOL, ' +
      'PARFUM, PHENOXYETHANOL'
  ],
  [
    'крем с ретинолом',
    'AQUA, CAPRYLIC/CAPRIC TRIGLYCERIDE, GLYCERIN, SQUALANE, CETEARYL ALCOHOL, RETINOL, RETINYL PALMITATE, ' +
      'TOCOPHEROL, BISABOLOL, SODIUM HYALURONATE, AMMONIUM ACRYLOYLDIMETHYLTAURATE/VP COPOLYMER, PHENOXYETHANOL, BHT'
  ]
];

test('база: размер и структура соответствуют ожиданиям', () => {
  assert.ok(INCI_DB_STATS.total >= 750, `записей слишком мало: ${INCI_DB_STATS.total}`);
  assert.ok(INCI_DB_STATS.ru >= 120, `русских синонимов слишком мало: ${INCI_DB_STATS.ru}`);
  assert.ok(INCI_PATTERNS.length >= 15);
  assert.match(INCI_DB_STATS.version, /^\d{4}\.\d{2}$/);
  // ни один слой не перекрывает другой — иначе записи теряются при слиянии
  assert.equal(
    INCI_DB_STATS.total,
    INCI_DB_STATS.core + INCI_DB_STATS.extra + INCI_DB_STATS.ru,
    'ключи пересекаются между слоями базы'
  );
});

test('база: все ключи нормализованы и находятся своим же поиском', () => {
  const badKeys = [];
  const badLookups = [];

  for (const key of Object.keys(INCI_DB)) {
    if (normalizeInciName(key) !== key) badKeys.push(key);
    const analysis = analyzeInci(key);
    const hit = analysis.ingredients.find((item) => item.matched && item.key === key);
    if (!hit) badLookups.push(key);
  }

  assert.deepEqual(badKeys, [], 'ключи записаны не в нормализованном виде');
  assert.deepEqual(badLookups, [], 'ключи не находятся через analyzeInci');
});

test('база: у каждой записи есть название и известные теги', () => {
  const problems = [];
  for (const [key, entry] of Object.entries(INCI_DB)) {
    if (!entry || typeof entry.name !== 'string' || !entry.name.trim()) problems.push(`${key}: нет названия`);
    if (!Array.isArray(entry.tags)) {
      problems.push(`${key}: теги не массив`);
      continue;
    }
    for (const tag of entry.tags) {
      if (!INCI_TAG_META[tag]) problems.push(`${key}: неизвестный тег «${tag}»`);
    }
  }
  assert.deepEqual(problems, []);
});

test('база: в исходнике нет повторяющихся ключей', () => {
  const source = fs.readFileSync(DB_SOURCE, 'utf8');
  const keys = [];
  const re = /^ {2}(?:'([^']+)'|([A-Za-z0-9][A-Za-z0-9 _./-]*)): e\(/gm;
  let match;
  while ((match = re.exec(source))) keys.push(match[1] || match[2]);

  assert.ok(keys.length > 500, `распознано слишком мало записей: ${keys.length}`);
  const seen = new Set();
  const duplicates = [];
  for (const key of keys) {
    if (seen.has(key)) duplicates.push(key);
    seen.add(key);
  }
  assert.deepEqual(duplicates, [], 'дубли ключей в inci-db.js: побеждает последняя запись');
});

test('база: русские синонимы указывают на существующие записи', () => {
  const broken = Object.entries(RU_ALIASES)
    .filter(([alias, key]) => !INCI_DB[alias] || typeof key !== 'string')
    .map(([alias, key]) => `${alias} → ${key}`);
  assert.deepEqual(broken, []);
});

test('база: семейные правила распознают производные', () => {
  const cases = [
    ['CETEARETH-20', 'emulsifier'],
    ['STEARETH-21', 'emulsifier'],
    ['PEG-32', 'solvent'],
    ['POLYQUATERNIUM-7', 'conditioner'],
    ['POLYGLYCERYL-4 OLEATE', 'emulsifier'],
    ['CI 15850', 'pigment'],
    ['CI 42051:1', null],
    ['CERAMIDE EOP', 'soothing'],
    ['DIMETHICONE/VINYL DIMETHICONE CROSSPOLYMER', 'silicone'],
    ['HYDROLYZED OAT PROTEIN', 'protein']
  ];

  for (const [raw, tag] of cases) {
    const analysis = analyzeInci(raw);
    const ingredient = analysis.ingredients[0];
    if (tag === null) {
      // «CI 42051:1» — номер с индексом; главное, чтобы разбор не падал
      assert.ok(ingredient);
      continue;
    }
    assert.equal(ingredient.matched, true, `${raw} не распознан`);
    assert.ok(ingredient.tags.includes(tag), `${raw}: нет тега ${tag} (${ingredient.tags.join(', ')})`);
  }
});

test('база: реальные составы покрываются почти полностью', () => {
  let total = 0;
  let matched = 0;
  const report = [];

  for (const [label, text] of CORPUS) {
    const analysis = analyzeInci(text);
    total += analysis.total;
    matched += analysis.matched;
    const missed = analysis.ingredients.filter((item) => !item.matched).map((item) => item.raw);
    const share = analysis.matched / analysis.total;
    if (share < 0.95) report.push(`${label}: ${analysis.matched}/${analysis.total} — нет: ${missed.join('; ')}`);
    assert.equal(analysis.total, splitInci(text).length);
  }

  assert.deepEqual(report, []);
  const coverage = matched / total;
  assert.ok(coverage >= 0.97, `покрытие ${(coverage * 100).toFixed(1)}% (${matched}/${total})`);
});

test('база: ключевые компоненты узнаются с правильными тегами', () => {
  const expectations = [
    ['BUTYL METHOXYDIBENZOYLMETHANE', ['Дибензоилметан', 'авобензон'], 'uv'],
    ['TRISODIUM ETHYLENEDIAMINE DISUCCINATE', ['Тринатрия'], 'chelator'],
    ['HAMAMELIS VIRGINIANA WATER', ['Гамамелис'], 'botanical'],
    ['HYDROLYZED WHEAT PROTEIN', ['пшеничный'], 'allergen'],
    ['COCAMIDOPROPYL BETAINE', ['Кокамидопропилбетаин'], 'surfactant'],
    ['CITRUS BERGAMIA PEEL OIL', ['бергамота'], 'phototoxic'],
    ['SODIUM FLUORIDE', ['Фторид натрия'], 'fluoride'],
    ['ALUMINUM CHLOROHYDRATE', ['хлоргидрат'], 'antiperspirant']
  ];

  for (const [raw, namePart, tag] of expectations) {
    const [ingredient] = analyzeInci(raw).ingredients;
    assert.equal(ingredient.matched, true, `${raw} не распознан`);
    assert.ok(
      namePart.some((part) => ingredient.name.includes(part)),
      `${raw}: неожиданное название «${ingredient.name}»`
    );
    assert.ok(ingredient.tags.includes(tag), `${raw}: нет тега ${tag}`);
  }
});

test('база: состав на русском разбирается как INCI', () => {
  const text = 'Состав: вода, глицерин, отдушка, лимонен, феноксиэтанол, экстракт алоэ.';
  const analysis = analyzeInci(text);

  assert.equal(analysis.total, 6);
  assert.equal(analysis.matched, 6);
  assert.equal(analysis.counts.allergen, 2);
  assert.equal(analysis.counts.fragrance, 2);
  assert.equal(analysis.verdict.level, 'warn');
  assert.equal(isLikelyComposition('Вода, глицерин, отдушка, лимонен, пантенол'), true);
});

test('база: незнакомые компоненты остаются без тегов', () => {
  const analysis = analyzeInci('FOO BAR, BAZ QUX, ZIP ZAP');
  assert.equal(analysis.ok, true);
  assert.equal(analysis.matched, 0);
  assert.equal(analysis.flags.length, 0);
  assert.match(analysis.verdict.text, /нет в локальной базе/i);
});

test('номера с запятой внутри названия не режутся', () => {
  assert.deepEqual(splitInci('AQUA, 1,2-HEXANEDIOL, GLYCERIN'), ['AQUA', '1,2-HEXANEDIOL', 'GLYCERIN']);
  const [ingredient] = analyzeInci('1,2-HEXANEDIOL').ingredients;
  assert.equal(ingredient.matched, true);
  assert.equal(ingredient.key, '1,2-hexanediol');
});
