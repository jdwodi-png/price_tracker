import test from 'node:test';
import assert from 'node:assert/strict';

import {
  analyzeInci,
  cleanComposition,
  ingredientNote,
  isLikelyComposition,
  normalizeComposition,
  normalizeInciName,
  splitInci,
  visibleTags,
  INCI_VERDICT_LABELS
} from '../src/lib/inci.js';

const SAMPLE =
  'Состав: AQUA (WATER), GLYCERIN, PARFUM, LIMONENE, SODIUM LAURETH SULFATE 2%, ' +
  'COCOS NUCIFERA (COCONUT) OIL, RETINOL. Способ применения: нанести на кожу.';

test('splitInci не разрывает скобки и режет по запятым', () => {
  const tokens = splitInci('AQUA (WATER), GLYCERIN, PARFUM');
  assert.deepEqual(tokens, ['AQUA (WATER)', 'GLYCERIN', 'PARFUM']);
});

test('cleanComposition убирает подпись и обрезает на способе применения', () => {
  const text = cleanComposition(SAMPLE);
  assert.match(text, /^AQUA \(WATER\), GLYCERIN/);
  assert.ok(!/способ применения/i.test(text));
  assert.ok(!/^состав/i.test(text));
});

test('normalizeInciName убирает скобки, проценты и пунктуацию', () => {
  assert.equal(normalizeInciName('COCOS NUCIFERA (COCONUT) OIL 2%'), 'cocos nucifera oil');
  assert.equal(normalizeInciName('  Sodium  Laureth Sulfate. '), 'sodium laureth sulfate');
});

test('normalizeInciName приводит номера CI и этоксилаты к единому виду', () => {
  assert.equal(normalizeInciName('CI 15850'), 'ci 15850');
  assert.equal(normalizeInciName('PEG 32'), 'peg-32');
  assert.equal(normalizeInciName('Poloxamer 188'), 'poloxamer-188');
  assert.equal(normalizeInciName('Glyceryl & Water'), 'glyceryl and water');
});

test('«/» и «&» в названии не мешают найти компонент', () => {
  const analysis = analyzeInci('GLYCERIN & WATER, AQUA/WATER/EAU');
  assert.equal(analysis.ingredients[0].matched, true);
  assert.equal(analysis.ingredients[0].name, 'Глицерин');
  assert.equal(analysis.ingredients[1].name, 'Вода');
});

test('isLikelyComposition отличает список INCI от описания', () => {
  assert.equal(isLikelyComposition('AQUA, GLYCERIN, PARFUM, SODIUM CHLORIDE'), true);
  assert.equal(
    isLikelyComposition('Отличный крем для лица. Подходит для ежедневного ухода и делает кожу мягкой.'),
    false
  );
});

test('analyzeInci считает флаги, совпадения и вердикт', () => {
  const analysis = analyzeInci(SAMPLE);

  assert.equal(analysis.ok, true);
  assert.equal(analysis.total, 7);
  assert.equal(analysis.matched, 7);
  assert.equal(analysis.unknown, 0);

  const counts = analysis.counts;
  assert.equal(counts.allergen, 2);
  assert.equal(counts.irritant, 2);
  assert.equal(counts.comedogenic, 1);
  assert.equal(counts.sulfate, 1);
  assert.equal(counts.fragrance, 2);

  assert.equal(analysis.verdict.level, 'warn');
  assert.match(analysis.verdict.text, /аллергены|аллергенов/i);
});

test('состав с большим числом аллергенов получает уровень bad', () => {
  const analysis = analyzeInci(
    'AQUA, GLYCERIN, PARFUM, LIMONENE, LINALOOL, CITRAL, GERANIOL, EUGENOL, CITRONELLOL'
  );
  assert.equal(analysis.verdict.level, 'bad');
  assert.equal(INCI_VERDICT_LABELS.bad, 'много рисков');
});

test('спокойный состав без проблемных компонентов получает good', () => {
  const analysis = analyzeInci('AQUA, GLYCERIN, PANTHENOL, ALLANTOIN, NIACINAMIDE');
  assert.equal(analysis.verdict.level, 'good');
});

test('алиасы и проценты распознаются как один ингредиент', () => {
  const analysis = analyzeInci('AQUA, AQUA, WATER, SODIUM LAURETH SULFATE 2%');
  assert.equal(analysis.total, 3);

  const water = analysis.ingredients.filter((item) => item.name === 'Вода');
  assert.equal(water.length, 2);

  const sles = analysis.ingredients.find((item) => item.raw.includes('LAURETH'));
  assert.equal(sles.matched, true);
  assert.equal(sles.name, 'Лауретсульфат натрия (SLES)');
});

test('«может содержать» превращается в обычный список пигментов', () => {
  const analysis = analyzeInci(
    'Состав: AQUA, GLYCERIN. Может содержать: CI 77891, CI 77491, CI 77499.'
  );
  const keys = analysis.ingredients.map((item) => item.key);
  assert.ok(keys.includes('ci 77891'));
  assert.ok(keys.includes('ci 77491'));
  assert.ok(keys.includes('ci 77499'));
});

test('пустой состав и состав без совпадений обрабатываются корректно', () => {
  const empty = analyzeInci('');
  assert.equal(empty.ok, false);
  assert.equal(empty.total, 0);
  assert.equal(empty.verdict.text, 'Состав не распознан.');

  const unknown = analyzeInci('FOO BAR, BAZ QUX, ZIP ZAP');
  assert.equal(unknown.ok, true);
  assert.equal(unknown.matched, 0);
  assert.match(unknown.verdict.text, /нет в локальной базе/i);
});

test('пояснения и теги доступны для карточки ингредиента', () => {
  const analysis = analyzeInci('PARFUM, LIMONENE');
  const parfum = analysis.ingredients.find((item) => item.key === 'parfum');
  const limonene = analysis.ingredients.find((item) => item.key === 'limonene');

  assert.match(ingredientNote(parfum), /контактного дерматита/i);
  assert.ok(visibleTags(limonene).some((tag) => tag.tag === 'allergen'));
});

test('normalizeComposition сохраняет очищенный текст или null', () => {
  assert.equal(normalizeComposition('Состав: AQUA, GLYCERIN'), 'AQUA, GLYCERIN');
  assert.equal(normalizeComposition('   '), null);
  assert.equal(normalizeComposition(null), null);
});
