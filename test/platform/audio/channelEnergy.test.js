import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readSrc, sliceFunction } from '../../helpers/repo.js';
import { ROLE_INVERTED, ROLE_OK, channelVerdict } from '../../../src/domain/call/roles.js';

const src = readSrc('platform/audio/channelEnergy.js');
const RATE = 8000;
const FRAME = 4;

const factory = new Function(
  'SAMPLE_RATE',
  'BYTES_PER_FRAME',
  'MANAGER_ROLE',
  `${sliceFunction(src, 'function rmsOfSpan')}
${sliceFunction(src, 'function weightedMeans')}
return { rmsOfSpan, weightedMeans };`
);
const { rmsOfSpan, weightedMeans } = factory(RATE, FRAME, 'manager');

const LOUD = 10000;
const HUM = 100;

function stereo(spans) {
  const frames = spans.reduce((n, s) => n + s.seconds * RATE, 0);
  const pcm = Buffer.alloc(frames * FRAME);
  let at = 0;
  for (const span of spans) {
    for (let i = 0; i < span.seconds * RATE; i += 1) {
      pcm.writeInt16LE(span.left, (at + i) * FRAME);
      pcm.writeInt16LE(span.right, (at + i) * FRAME + 2);
    }
    at += span.seconds * RATE;
  }
  return pcm;
}

const TALK = stereo([
  { seconds: 1, left: LOUD, right: HUM },
  { seconds: 1, left: HUM, right: LOUD },
]);

test('частота дискретизації й кадр лишились тими, під які рахується енергія', () => {
  assert.match(src, /const SAMPLE_RATE = 8000;/);
  assert.match(src, /const CHANNELS = 2;/);
  assert.match(src, /const BYTES_PER_FRAME = CHANNELS \* 2;/);
});

test('енергія рахується по кожному каналу окремо в межах репліки', () => {
  assert.deepEqual(rmsOfSpan(TALK, 0, 1).map(Math.round), [LOUD, HUM]);
  assert.deepEqual(rmsOfSpan(TALK, 1, 2).map(Math.round), [HUM, LOUD]);
});

test('замір за межами запису не вигадує звуку', () => {
  assert.deepEqual(rmsOfSpan(TALK, 10, 12), [0, 0]);
});

test('менеджер на каналі 0 дає вердикт «коректно»', () => {
  const means = weightedMeans(TALK, [
    { role: 'manager', start: 0, end: 1 },
    { role: 'client', start: 1, end: 2 },
  ]);
  assert.equal(channelVerdict(means, { managerChannel: 0, margin: 1.35 }), ROLE_OK);
});

test('ті самі байти з перевернутими підписами ловляться як інверсія', () => {
  const means = weightedMeans(TALK, [
    { role: 'client', start: 0, end: 1 },
    { role: 'manager', start: 1, end: 2 },
  ]);
  assert.equal(channelVerdict(means, { managerChannel: 0, margin: 1.35 }), ROLE_INVERTED);
});

test('довша репліка важить більше за коротку', () => {
  const pcm = stereo([
    { seconds: 1, left: HUM, right: LOUD },
    { seconds: 3, left: LOUD, right: HUM },
  ]);
  const means = weightedMeans(pcm, [
    { role: 'manager', start: 0, end: 1 },
    { role: 'manager', start: 1, end: 4 },
    { role: 'client', start: 1, end: 4 },
  ]);
  assert.ok(means.manager[0] > means.manager[1], 'коротка репліка переважила довгу');
});

test('репліки без таймкодів не беруться в замір', () => {
  const means = weightedMeans(TALK, [
    { role: 'manager', start: null, end: null },
    { role: 'manager', start: 0, end: 1 },
    { role: 'client', start: 2, end: 1 },
    { role: 'client', start: 1, end: 2 },
  ]);
  assert.deepEqual(means.manager.map(Math.round), [LOUD, HUM]);
  assert.deepEqual(means.client.map(Math.round), [HUM, LOUD]);
});

test('дзвінок, де одна сторона мовчить увесь запис, замір не дає', () => {
  assert.equal(weightedMeans(TALK, [{ role: 'manager', start: 0, end: 2 }]), null);
});

test('моно пропускається ДО декодування — на ньому порівняння каналів безглузде', () => {
  const fn = sliceFunction(src, 'async function measureRoleChannels');
  assert.ok(fn.indexOf('probeChannels') < fn.indexOf('decodePcm'), 'моно дійде до заміру і дасть монету');
  assert.match(fn, /channels < CHANNELS\) return \{ mono: true/);
});
