import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readSrc, sliceFunction } from '../../helpers/repo.js';

const src = readSrc('platform/elevenlabs/client.js');

const build = new Function(
  `${sliceFunction(src, 'function tidyTurns')}
${sliceFunction(src, 'function buildChannelTurns')}
return buildChannelTurns;`
)();

const word = (text, start, end) => ({ text, start, end });
const space = { text: ' ', type: 'spacing' };

function withSpaces(words) {
  return words.flatMap((w, i) => (i ? [space, w] : [w]));
}

test('у межах каналу репліка лишається цілою, навіть коли друга сторона говорить поверх', () => {
  const ours = withSpaces([
    word('С', 0, 0.3),
    word('головы,', 0.35, 0.9),
    word('да,', 1.0, 1.3),
    word('зрозуміло', 1.4, 2.0),
  ]);
  const turns = build(ours, 'speaker_0', 0.8);
  assert.equal(turns.length, 1, 'репліку посікло на уламки');
  assert.equal(turns[0].text, 'С головы, да, зрозуміло');
  assert.equal(turns[0].start, 0);
  assert.equal(turns[0].end, 2.0);
});

test('нова репліка починається за мовчанням у каналі, а не за зміною мовця', () => {
  const words = withSpaces([
    word('Добрий', 0, 0.4),
    word('день', 0.45, 0.9),
    word('Записав', 5, 5.5),
    word('вас', 5.55, 5.9),
  ]);
  const turns = build(words, 'speaker_0', 0.8);
  assert.equal(turns.length, 2);
  assert.deepEqual(turns.map((t) => t.text), ['Добрий день', 'Записав вас']);
  assert.equal(turns[1].start, 5);
});

test('пауза, менша за поріг, репліку не ріже', () => {
  const words = withSpaces([word('Ну', 0, 0.3), word('добре', 0.9, 1.4)]);
  assert.equal(build(words, 'speaker_0', 0.8).length, 1);
});

test('усі репліки каналу несуть його мовця — роль не вгадується', () => {
  const turns = build(withSpaces([word('Алло', 0, 0.5), word('Так', 9, 9.4)]), 'speaker_1', 0.8);
  assert.deepEqual(turns.map((t) => t.speaker), ['speaker_1', 'speaker_1']);
});

test('репліки двох каналів зливаються за часом і можуть перекриватись', () => {
  const merge = new Function(
    'config',
    `${sliceFunction(src, 'function tidyTurns')}
${sliceFunction(src, 'function buildChannelTurns')}
${sliceFunction(src, 'function buildTurns')}
${sliceFunction(src, 'function speakerIdOf')}
${sliceFunction(src, 'function turnsFromResponse')}
return turnsFromResponse;`
  )({ call: { turnGapSec: 0.8 } });

  const data = {
    transcripts: [
      { channel_index: 0, words: withSpaces([word('Зрозуміло,', 4.5, 5.0), word('це', 5.1, 5.3), word('стійки', 5.4, 6.0)]) },
      { channel_index: 1, words: withSpaces([word('У', 0, 0.2), word('мене', 0.3, 0.7), word('стукає', 0.8, 1.4)]) },
    ],
  };
  const turns = merge(data, true);
  assert.deepEqual(turns.map((t) => t.speaker), ['speaker_1', 'speaker_0']);
  assert.ok(turns[0].start < turns[1].start, 'злиття не впорядкувало репліки за часом');
});

test('мультиканальний режим просить окремі транскрипти по каналах', () => {
  assert.match(src, /multichannel_output_style', 'separate'/);
  assert.ok(!/'combined'/.test(src), 'combined зливає слова обох каналів і січе репліки');
});

test('відповідь без масиву transcripts не валить транскрипцію, а йде старим шляхом', () => {
  const pick = new Function(
    'config',
    `${sliceFunction(src, 'function tidyTurns')}
${sliceFunction(src, 'function buildChannelTurns')}
${sliceFunction(src, 'function speakerIdOf')}
${sliceFunction(src, 'function buildTurns')}
${sliceFunction(src, 'function turnsFromResponse')}
return turnsFromResponse;`
  )({ call: { turnGapSec: 0.8 } });
  const turns = pick({ words: [word('Алло', 0, 0.5)] }, true);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].text, 'Алло');
});
