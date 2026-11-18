import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readSrc, sliceFunction } from '../../helpers/repo.js';
import { speakerOfChannel } from '../../../src/domain/call/roles.js';

const src = readSrc('platform/elevenlabs/client.js');
const resolveSrc = sliceFunction(src, 'async function resolveManagerSpeaker');

function resolver(managerChannel, pickResult = 'speaker_llm') {
  const asked = [];
  const logged = [];
  const factory = new Function(
    'config',
    'speakerOfChannel',
    'pickManagerSpeaker',
    'console',
    `${resolveSrc}\nreturn resolveManagerSpeaker;`
  );
  const resolve = factory(
    { call: { managerChannel } },
    speakerOfChannel,
    async (...args) => {
      asked.push(args);
      return pickResult;
    },
    { log: (m) => logged.push(m), warn: (m) => logged.push(m), error: (m) => logged.push(m) }
  );
  return { resolve, asked, logged };
}

const TURNS = [
  { speaker: 'speaker_0', text: 'Добрий день, автосервіс' },
  { speaker: 'speaker_1', text: 'Алло, я по машині' },
];
const IDS = ['speaker_0', 'speaker_1'];

test('стереодзвінок бере роль із номера каналу і НЕ звертається до моделі', async () => {
  const { resolve, asked } = resolver(0);
  const manager = await resolve(TURNS, IDS, { multichannel: true, managerName: 'Роман', direction: 'out' });
  assert.equal(manager, 'speaker_0');
  assert.deepEqual(asked, [], 'модель викликали там, де роль відома з файлу');
});

test('інший канал менеджера перевертає результат без жодної правки коду', async () => {
  const { resolve, asked } = resolver(1);
  const manager = await resolve(TURNS, IDS, { multichannel: true, managerName: 'Роман', direction: 'out' });
  assert.equal(manager, 'speaker_1');
  assert.deepEqual(asked, []);
});

test('якщо наш канал мовчав увесь дзвінок — відкат на розбір транскрипту, а не падіння', async () => {
  const { resolve, asked, logged } = resolver(0);
  const manager = await resolve(TURNS, ['speaker_1'], { multichannel: true, managerName: 'Роман', direction: 'in' });
  assert.equal(manager, 'speaker_llm');
  assert.equal(asked.length, 1, 'відкат не спрацював');
  assert.ok(logged.some((m) => /channel 0/.test(m)), 'відкат стався мовчки — у логах немає причини');
});

test('моно-дзвінок, як і раніше, визначає роль із транскрипту', async () => {
  const { resolve, asked } = resolver(0);
  const manager = await resolve(TURNS, IDS, { multichannel: false, managerName: 'Роман', direction: 'in' });
  assert.equal(manager, 'speaker_llm');
  assert.deepEqual(asked[0][2], { managerName: 'Роман', direction: 'in' });
});

test('у стереорежимі мовець береться з НОМЕРА КАНАЛУ, а не з рядка speaker_id', () => {
  const build = new Function(
    `${sliceFunction(src, 'function speakerIdOf')}
${sliceFunction(src, 'function tidyTurns')}
${sliceFunction(src, 'function buildTurns')}
return buildTurns;`
  )();
  const words = [
    { text: 'Алло', speaker_id: 'speaker_1', channel_index: 0, start: 0, end: 1 },
    { text: 'Вітаю', speaker_id: 'speaker_0', channel_index: 1, start: 1, end: 2 },
  ];
  assert.deepEqual(build(words, true).map((t) => t.speaker), ['speaker_0', 'speaker_1']);
  assert.deepEqual(build(words, false).map((t) => t.speaker), ['speaker_1', 'speaker_0']);
});

test('у моно номера каналу немає — лишається мітка діаризації', () => {
  const build = new Function(
    `${sliceFunction(src, 'function speakerIdOf')}
${sliceFunction(src, 'function tidyTurns')}
${sliceFunction(src, 'function buildTurns')}
return buildTurns;`
  )();
  const words = [{ text: 'Алло', speaker_id: 'speaker_1', start: 0, end: 1 }];
  assert.deepEqual(build(words, true).map((t) => t.speaker), ['speaker_1']);
});

test('напрямок доходить до моделі — він відомий зі 100% рядків, вгадувати нема чого', () => {
  assert.match(src, /const DIRECTION_FACTS = \{/);
  assert.match(src, /in: 'Це ВХІДНИЙ дзвінок/);
  assert.match(src, /out:\s*\n?\s*'Це ВИХІДНИЙ дзвінок/);
  assert.match(src, /DIRECTION_FACTS\[direction\]/);
});

test('правило-пастка «наш працівник — той, хто телефонує» прибране з промпту', () => {
  assert.ok(!/наш працівник — той, хто телефонує/.test(src),
    'саме це правило перевертало 47.5% вихідних дзвінків');
});

test('промпт прямо попереджає, що звертання не є представленням', () => {
  assert.match(src, /ЗВЕРТАННЯ — це НЕ представлення/);
});

test('низька впевненість моделі відкочується на евристику ЗАВЖДИ, а не лише без імені', () => {
  const pick = sliceFunction(src, 'async function pickManagerSpeaker');
  assert.match(pick, /if \(out\.confidence === 'low' && keyword && keyword !== out\.manager\)/);
  assert.ok(!/!managerName && out\.confidence/.test(pick), 'евристика знову вимкнена для персональних номерів');
});

test('роль визначається рівно в одному місці — diarize не кличе модель сам', () => {
  const diarize = sliceFunction(src, 'async function diarize');
  assert.match(diarize, /resolveManagerSpeaker\(turns, speakerIds, \{ multichannel/);
  assert.ok(!/pickManagerSpeaker\(/.test(diarize), 'diarize обходить перевірку каналу');
});

test('підписи реплік і transcript збираються з однієї функції, тож не можуть розійтись', () => {
  const diarize = sliceFunction(src, 'async function diarize');
  assert.match(diarize, /transcriptFromSegments\(segments\)/);
  assert.ok(!/'Менеджер'/.test(diarize), 'підпис знову вшитий у транскрипцію окремо від segments');
});

test('канонічне імʼя підставляється ДО транскрипції, а не після неї', () => {
  const process = readSrc('features/ingest/process.js');
  const fn = sliceFunction(process, 'async function transcribeClassifyAndSave');
  assert.match(fn, /managerName: knownManagerName\(call\)/);
  assert.match(fn, /direction: call\.direction/);
  assert.ok(fn.indexOf('knownManagerName(call)') < fn.indexOf('resolveManagerName'),
    'імʼя від Binotel знову пішло в транскрипцію замість канонічного');
  const known = sliceFunction(process, 'function knownManagerName');
  assert.match(known, /PERSONAL_OPERATORS\[ext\]/);
  assert.match(known, /SHARED_EXTENSIONS\.includes\(ext\)/);
});
