import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readSrc, sliceFunction } from '../../helpers/repo.js';
import { normalize } from '../../../src/domain/call/quoteMatch.js';

const src = readSrc('features/reporting/analyze.js');

const HEAD = `${sliceFunction(src, 'function enoughEvidence')}
${sliceFunction(src, 'function spreadAcrossCalls')}`;

function load(names, extra = '') {
  return new Function(
    'MIN_EVIDENCE',
    'MIN_EVIDENCE_CALLS',
    'MAX_EVIDENCE_PER_FINDING',
    'normalize',
    'buildCandidates',
    'verifyCandidate',
    `${HEAD}
${extra}
return { ${names.join(', ')} };`
  );
}

const quoteOf = (callId, n) => `репліка ${callId} номер ${n}`;

function candidatesFor(spec) {
  const byId = new Map();
  spec.forEach(([id, callId, n], i) => {
    byId.set(id, { id, callId, startTime: `2026-07-0${i + 1}`, type: 'error', quote: quoteOf(callId, n) });
  });
  return () => ({ byId });
}

const passthroughVerify = (c) => ({ callId: c.callId, startTime: c.startTime, quote: c.quote, start: null, end: null, note: null });

function assemble(spec, evidenceIds) {
  const { assembleFindings } = load(['assembleFindings'], sliceFunction(src, 'function assembleFindings'))(
    2,
    2,
    6,
    normalize,
    candidatesFor(spec),
    passthroughVerify
  );
  return assembleFindings([{ type: 'error', claim: 'перебиває', why_hurts_booking: 'х', action: 'д', evidence_ids: evidenceIds }], []);
}

test('дві цитати з РІЗНИХ дзвінків — finding лишається', () => {
  const found = assemble([['e0', 'call-a', 1], ['e1', 'call-b', 1]], ['e0', 'e1']);
  assert.equal(found.length, 1);
  assert.equal(found[0].evidence.length, 2);
});

test('дві цитати з ОДНОГО дзвінка — finding відкидається: це один епізод, не звичка', () => {
  const found = assemble([['e0', 'call-a', 1], ['e1', 'call-a', 2]], ['e0', 'e1']);
  assert.deepEqual(found, []);
});

test('три цитати, з яких дві з одного дзвінка, а третя з іншого — finding лишається', () => {
  const found = assemble([['e0', 'call-a', 1], ['e1', 'call-a', 2], ['e2', 'call-b', 1]], ['e0', 'e1', 'e2']);
  assert.equal(found.length, 1);
  assert.equal(found[0].evidence.length, 3);
});

test('добір цитат спершу бере по одній із кожного ще не представленого дзвінка', () => {
  const { spreadAcrossCalls } = load(['spreadAcrossCalls'])(2, 2, 6, normalize, null, null);
  const pool = [
    { callId: 'a', quote: '1' }, { callId: 'a', quote: '2' }, { callId: 'a', quote: '3' },
    { callId: 'b', quote: '4' }, { callId: 'c', quote: '5' },
  ];
  assert.deepEqual(spreadAcrossCalls(pool, 3).map((e) => e.callId), ['a', 'b', 'c']);
});

test('коли різних дзвінків бракує, добір усе одно заповнює ліміт', () => {
  const { spreadAcrossCalls } = load(['spreadAcrossCalls'])(2, 2, 6, normalize, null, null);
  const pool = [{ callId: 'a', quote: '1' }, { callId: 'a', quote: '2' }];
  assert.equal(spreadAcrossCalls(pool, 2).length, 2);
});

test('правило «різні дзвінки» стоїть на ВСІХ воротах, не лише на денному аналізі', () => {
  for (const fn of ['assembleFindings', 'applyMergeGroups', 'fallbackMerge', 'verifyFindingsRelevance']) {
    assert.match(sliceFunction(src, `function ${fn}`), /enoughEvidence\(/, `${fn} пускає finding з одного дзвінка`);
  }
  assert.match(src, /const MIN_EVIDENCE_CALLS = 2;/);
});

test('з одного дзвінка у звіт іде не більше двох діалогових кандидатів', () => {
  assert.match(src, /const MAX_DIALOGUE_PER_CALL = 2;/);
  const fn = sliceFunction(src, 'function dialogueCandidates');
  assert.match(fn, /interleave\(\[interrupted, waited\], MAX_DIALOGUE_PER_CALL\)/);
});

test('у кандидати йдуть лише невиправдані паузи — вирок виносить код, не промпт', () => {
  const fn = sliceFunction(src, 'function dialogueCandidates');
  assert.match(fn, /longPauses\s*\n?\s*\.filter\(\(p\) => p\.quote && !p\.justified\)/);
});

test('інструкція reduce більше не відправляє модель шукати попередження в цитаті', () => {
  assert.ok(!/якщо з цитати видно, що менеджер попередив/.test(src),
    'попередження лежить у репліці ПЕРЕД паузою, а не в цитаті після неї');
  assert.match(src, /цитата це репліка ПІСЛЯ паузи/);
});

test('перевірка висновків дістає повний замір і право його відкинути', () => {
  const verify = sliceFunction(src, 'async function verifyFindingsRelevance');
  assert.match(verify, /measured: e\.note/);
  const prompt = JSON.parse(readSrc('features/prompts/defaults.json')).reportVerify.join('\n');
  assert.match(prompt, /НЕ вимагай, щоб перебивання чи пауза були видні з тексту самої цитати/);
  assert.match(prompt, /сам факт ще не означає проблему/);
  assert.ok(!/доказ|рецензент/i.test(prompt), 'у видимому тексті зʼявились заборонені слова');
});
