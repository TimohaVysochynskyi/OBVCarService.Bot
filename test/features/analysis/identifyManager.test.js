import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readSrc, readJson, sliceFunction } from '../../helpers/repo.js';
import { installFakeOpenAi, scripted, jsonResponse } from '../../helpers/fakeOpenAi.js';
import { identifyManager } from '../../../src/features/analysis/identifyManager.js';

const src = readSrc('features/analysis/identifyManager.js');
const ROSTER = ['Роман', 'Андрій', 'Володимир'];

const SEGMENTS = [
  { role: 'client', text: 'Алло, добрий день, це Володимир?' },
  { role: 'manager', text: 'Ні, це Андрій, слухаю вас уважно.' },
  { role: 'client', text: 'Мені треба записатись на заміну масла.' },
  { role: 'manager', text: 'Можу запропонувати четвер зранку.' },
];

async function run(dialogue, reply) {
  const fake = installFakeOpenAi(scripted([jsonResponse(reply)]));
  try {
    const value = await identifyManager(dialogue, ROSTER);
    return { value, body: fake.calls[0].body.messages[1].content };
  } finally {
    fake.restore();
  }
}

test('моделі подаються ЛИШЕ репліки нашого працівника', async () => {
  const { body } = await run({ transcript: 'не має значення', segments: SEGMENTS }, { operator: 'Андрій' });
  assert.ok(body.includes('Ні, це Андрій, слухаю вас уважно.'), 'реплік менеджера немає у вході');
  assert.ok(!body.includes('це Володимир?'), 'репліка клієнта потрапила в модель і може перетягнути атрибуцію');
  assert.match(body, /Репліки НАШОГО працівника/);
});

test('кандидати передаються разом із репліками', async () => {
  const { body, value } = await run({ transcript: '', segments: SEGMENTS }, { operator: 'Андрій' });
  assert.match(body, /Кандидати: Роман, Андрій, Володимир/);
  assert.equal(value, 'Андрій');
});

test('без сегментів іде весь транскрипт і про це сказано прямо', async () => {
  const { body } = await run({ transcript: 'Менеджер: Алло\n\nКлієнт: Добрий день' }, { operator: null });
  assert.match(body, /Транскрипт розмови \(сторони не розділені\)/);
  assert.match(body, /Добрий день/);
});

test('порожній ростер не коштує жодного запиту до моделі', async () => {
  const fake = installFakeOpenAi(scripted([]));
  try {
    assert.equal(await identifyManager({ transcript: 'будь-що' }, []), null);
    assert.equal(fake.calls.length, 0);
  } finally {
    fake.restore();
  }
});

test('null від моделі лишається null — атрибуція не вгадується', async () => {
  const { value } = await run({ transcript: '', segments: SEGMENTS }, { operator: null });
  assert.equal(value, null);
});

test('модель обмежена списком кандидатів', () => {
  assert.match(src, /enum: \[\.\.\.candidates, null\]/);
});

test('довгу розмову обрізано, щоб не роздувати запит', () => {
  assert.match(src, /const MAX_CHARS = 4000;/);
  assert.match(sliceFunction(src, 'function managerSide'), /slice\(0, MAX_CHARS\)/);
});

test('промпт більше не описує моно-режим, якого не існує з серпня 2026', () => {
  const prompt = readJson('features/prompts/defaults.json').identify.join('\n');
  assert.ok(!/Запис моно/.test(prompt), 'модель описує неіснуючу ситуацію');
  assert.match(prompt, /репліки НАШОГО працівника/);
  assert.match(prompt, /Звертання до когось на імʼя представленням НЕ є/);
});

test('жоден викликач не передає голий транскрипт першим аргументом', () => {
  for (const file of ['features/ingest/process.js', 'features/analysis/reprocess.js', 'scripts/reattributeShared.js']) {
    const text = readSrc(file);
    assert.ok(!/identifyManager\(\s*(?:[a-z]\w*\.)?transcript\s*,/.test(text),
      `${file} віддає моделі весь транскрипт, разом із репліками клієнта`);
    assert.match(text, /identifyManager\(/);
  }
  assert.match(readSrc('features/ingest/process.js'), /resolveManagerName\(call, \{ transcript, segments \}, roster\)/);
});

test('переатрибуція спільних ліній теж дістає сегменти з бази', () => {
  const query = sliceFunction(readSrc('features/operators/repo.js'), 'async function getNumericManagerCalls');
  assert.match(query, /transcript, segments/);
});
