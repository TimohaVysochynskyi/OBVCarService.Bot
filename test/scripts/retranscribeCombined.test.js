import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readRepo, readSrc, sliceFunction, migrationsSql } from '../helpers/repo.js';

const src = readSrc('scripts/retranscribeCombined.js');
const main = sliceFunction(src, 'async function main');
const client = readSrc('platform/elevenlabs/client.js');
const repo = readSrc('features/analysis/repo.js');

test('режим транскрипції зберігається, бо прогін іде в кілька заходів', () => {
  assert.match(migrationsSql(), /ALTER TABLE calls ADD COLUMN IF NOT EXISTS stt_mode TEXT;/);
  const fn = sliceFunction(client, 'function sttModeOf');
  assert.match(fn, /if \(!multichannel\) return 'diarize';/);
  assert.match(fn, /Array\.isArray\(data\.transcripts\) \? 'separate' : 'multichannel'/);
});

test('diarize віддає режим разом із репліками в УСІХ гілках', () => {
  const fn = sliceFunction(client, 'async function diarize');
  const returns = fn.split('return ').slice(1);
  assert.ok(returns.length >= 3, 'гілок виходу стало менше — перевірка втратила предмет');
  for (const branch of returns) {
    assert.ok(branch.includes('sttMode'), `гілка без режиму: ${branch.slice(0, 60)}`);
  }
});

test('у роботу беруться лише непозначені дзвінки, найстаріші першими', () => {
  const query = sliceFunction(repo, 'async function getCallsToRetranscribe');
  assert.match(query, /stt_mode IS NULL AND audio_path IS NOT NULL/);
  assert.match(query, /ORDER BY start_time ASC/);
});

test('моно пропускається БЕЗ витрати кредитів', () => {
  const skip = main.indexOf("markSttMode(call.generalCallId, 'mono')");
  const spend = main.indexOf('transcribeDiarized');
  assert.ok(skip > 0 && skip < spend, 'моно доходить до платного виклику');
  assert.match(main, /probeChannels/);
});

test('резерв кредитів перевіряється ПЕРЕД дзвінком, а не після', () => {
  const guard = main.indexOf('credits <= RESERVE');
  assert.ok(guard > 0 && guard < main.indexOf('transcribeDiarized'));
  assert.match(main, /stoppedOnReserve = true/);
  assert.match(src, /const DEFAULT_RESERVE = 3000;/);
});

test('аварія ElevenLabs зупиняє прогін, а не крутить помилки по колу', () => {
  assert.match(main, /err\?\.elevenlabsUnavailable/);
  assert.match(main, /ПРОГІН ЗУПИНЕНО/);
});

test('перероблений дзвінок зберігає і режим, і новий розбір', () => {
  assert.match(main, /sttMode: stt\.sttMode/);
  const update = sliceFunction(repo, 'async function updateCallAnalysis');
  assert.match(update, /stt_mode = COALESCE\(\$7, stt_mode\)/);
});

test('скрипт оголошений у package.json', () => {
  const pkg = JSON.parse(readRepo('package.json'));
  assert.equal(pkg.scripts['retranscribe:combined'], 'node src/scripts/retranscribeCombined.js');
});

test('межа кредитів працює й тоді, коли баланс недоступний', () => {
  const estimate = new Function(
    'CREDITS_PER_MIN',
    `${sliceFunction(src, 'const creditsFor')}
return creditsFor;`
  )(20);
  assert.equal(estimate(60), 20);
  assert.equal(estimate(30), 10);
  assert.equal(estimate(0), 10, 'надто короткий дзвінок усе одно щось коштує');
  assert.match(main, /MAX_CREDITS != null && spent \+ creditsFor/);
});

test('оцінка кредитів рахується з заміряного курсу, а не з вигаданого', () => {
  assert.match(src, /const CREDITS_PER_MIN = 20;/);
});
