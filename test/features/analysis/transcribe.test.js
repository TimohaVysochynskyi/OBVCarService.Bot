import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readSrc, sliceFunction } from '../../helpers/repo.js';

const transcribe = readSrc('features/analysis/transcribe.js');
const elevenlabs = readSrc('platform/elevenlabs/client.js');
const process = readSrc('features/ingest/process.js');
const poll = readSrc('features/ingest/poll.js');

test('транскрипція йде ЛИШЕ через ElevenLabs — фолбеку на OpenAI більше немає', () => {
  assert.match(transcribe, /transcribeDiarized\(audioBlob, \{ managerName/);
  assert.ok(!/openai/i.test(transcribe), 'у транскрипції лишилась згадка OpenAI');
  assert.ok(!/falling back|fallback/i.test(transcribe));
});

test('збій ElevenLabs не глушиться: у transcribeAudio немає catch', () => {
  const fn = transcribe.match(/async function transcribeAudio[\s\S]*?\n\}/)[0];
  assert.ok(!/catch/.test(fn), 'помилка мусить іти назовні, а не ставати дзвінком без таймкодів');
});

test('аварія ElevenLabs позначається окремо від збою одного файлу', () => {
  assert.match(elevenlabs, /const OUTAGE_CODES = new Set\(\[/);
  for (const code of ['ELV-NOKEY', 'ELV-QUOTA', 'ELV-AUTH', 'ELV-RATE', 'ELV-5XX', 'ELV-TIMEOUT', 'ELV-NET']) {
    assert.ok(elevenlabs.includes(`'${code}'`), `${code} не рахується аварією`);
  }
  assert.match(elevenlabs, /err\.elevenlabsUnavailable = true/);
});

test('живий дзвінок під час аварії не потрапляє в чергу зі спаленою спробою', () => {
  const live = process.match(/async function processOneCall[\s\S]*?\n\}/)[0];
  const failure = live.slice(live.indexOf('} catch (err) {'));
  const abort = failure.indexOf('elevenlabsUnavailable');
  const queue = failure.indexOf('upsertPending');
  assert.ok(abort > 0, 'аварія не розпізнається у живому шляху');
  assert.ok(abort < queue, 'спершу мусить бути вихід з аварії, потім черга');
  assert.match(failure.slice(abort, queue), /throw err/);
});

test('ретрай черги під час аварії перериває прохід, а не бампає attempts', () => {
  const retry = process.match(/async function retryPendingCalls[\s\S]*?\n\}/)[0];
  const abort = retry.indexOf('elevenlabsUnavailable');
  assert.ok(abort > 0);
  assert.match(retry.slice(abort, abort + 200), /throw err/);
  assert.ok(abort < retry.indexOf('await upsertPending'), 'інакше 20 спроб згорять за 5 годин простою');
});

test('жоден код ElevenLabs не вважається безнадійним — дзвінок не стане failed', () => {
  const errors = readSrc('shared/errors.js');
  const hopeless = errors.match(/const HOPELESS = new Set\(\[[^\]]*\]\)/)[0];
  assert.ok(!/ELV-/.test(hopeless), 'дзвінок став би failed через простій сервісу');
});

test('аварія алертиться один раз, із нагадуванням і з долею дзвінків', () => {
  assert.match(poll, /alertOnce\('elevenlabs_outage'/);
  assert.match(poll, /reminderMin: config\.elevenlabs\.outageReminderMin/);
  assert.match(poll, /data: NOTICES\.callsWaiting/);
  const texts = readSrc('shared/errorTexts.js');
  assert.match(texts, /callsWaiting:/);
  assert.match(texts, /чекають у черзі й обробляться самі/);
});

test('відновлення повідомляється окремо, і збір продовжується сам', () => {
  assert.match(poll, /async function noteElevenLabsUp/);
  assert.match(poll, /recovered: \(\{ downFor \}\) => NOTICES\.elevenLabsBackUp\(downFor\)/);
  assert.ok(poll.indexOf('noteElevenLabsUp()') < poll.indexOf('catch (err)'),
    'відновлення мусить відмічатись на успішному прогоні');
});

test('інжест не стартує без ключа ElevenLabs — мовчазного режиму без таймкодів не існує', () => {
  assert.match(readSrc('apps/poller/index.js'), /missingConfig\(\['db', 'binotel', 'openai', 'elevenlabs'\]\)/);
});

test('модуль транскрипції OpenAI видалено разом із фолбеком', () => {
  assert.throws(() => readSrc('platform/openai/transcribe.js'));
  assert.ok(!/transcribeFile/.test(readSrc('platform/openai/client.js')));
});

test('скрипти переразшифровки кажуть, що прогін зупинено, а не «готово»', () => {
  for (const script of ['scripts/backfillAnalysis.js', 'scripts/retranscribeRecent.js']) {
    assert.match(readSrc(script), /elevenlabsUnavailable/, `${script} мовчки завершиться успіхом`);
  }
});

test('ліміт OpenAI теж перериває прогін, а не спалює спробу дзвінка', () => {
  const live = sliceFunction(process, 'async function processOneCall');
  const failure = live.slice(live.indexOf('} catch (err) {'));
  const abort = failure.indexOf('openaiLimited');
  const queue = failure.indexOf('upsertPending');
  assert.ok(abort > 0, 'ліміт не розпізнається у живому шляху');
  assert.ok(abort < queue, '20 спроб згорять за 5 годин, як це вже сталось із пʼятьма дзвінками');
  assert.match(failure.slice(abort, queue), /throw err/);
});

test('ретрай черги під час ліміту OpenAI теж не бампає attempts', () => {
  const retry = sliceFunction(process, 'async function retryPendingCalls');
  const abort = retry.indexOf('openaiLimited');
  assert.ok(abort > 0);
  assert.ok(abort < retry.indexOf('await upsertPending'));
  assert.match(retry.slice(abort, abort + 220), /throw err/);
});

test('позначку ставить порт моделей, а не кожен викликач окремо', () => {
  const client = readSrc('platform/openai/client.js');
  assert.match(client, /const LIMIT_CODES = new Set/);
  assert.match(client, /err\.openaiLimited = true/);
  for (const file of ['features/analysis/classifyCall.js', 'features/analysis/analyzeCall.js', 'features/reporting/analyze.js']) {
    assert.ok(!/openaiLimited/.test(readSrc(file)), `${file} ставить позначку сам`);
  }
});

test('жоден код ліміту OpenAI не вважається безнадійним', () => {
  const hopeless = readSrc('shared/errors.js').match(/const HOPELESS = new Set[^;]+;/)[0];
  for (const code of ['OAI-RATE', 'OAI-QUOTA']) {
    assert.ok(!hopeless.includes(code), `${code} зробив би дзвінок failed після поповнення`);
  }
});

test('ліміт алертиться один раз, із нагадуванням і з долею дзвінків', () => {
  assert.match(poll, /alertOnce\('openai_limit'/);
  assert.match(poll, /reminderMin: config\.openai\.limitReminderMin/);
  assert.match(poll, /data: NOTICES\.callsWaitingLimit/);
  const texts = readSrc('shared/errorTexts.js');
  assert.match(texts, /callsWaitingLimit:/);
  assert.match(texts, /Спроби навмисно не витрачаються/);
  assert.ok(poll.indexOf('noteOpenAiFree()') < poll.indexOf('catch (err)'),
    'відновлення мусить відмічатись на успішному прогоні');
});

test('перевірка балансу має ВЛАСНИЙ короткий таймаут, не 300с від транскрипції', () => {
  assert.match(elevenlabs, /const BALANCE_TIMEOUT_MS = 15_000;/);
  const fn = sliceFunction(elevenlabs, 'async function getElevenLabsBalance');
  assert.match(fn, /timeoutMs: BALANCE_TIMEOUT_MS/);
  assert.match(fn, /catch \(err\)/, 'збій балансу мусить лишатись не фатальним');
});
