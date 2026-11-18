import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PAUSE_CLIENT_SILENT,
  PAUSE_HOLD,
  PAUSE_SAME_EXCHANGE,
  PAUSE_WARNED_BEFORE,
  INTERRUPT_CUT_OFF,
  INTERRUPT_OVERLAP,
  detectInterruptions,
  detectLongPauses,
  metricsPromptBlock,
  dialogueMetrics,
} from '../../../src/domain/call/dialogueMetrics.js';

const THRESHOLD = 6;
const HOLD = 20;
const OVERLAP = 0.4;

const seg = (role, text, start, end) => ({ role, text, start, end });

const pausesOf = (segments) => detectLongPauses(segments, THRESHOLD, HOLD);
const candidatesOf = (segments) => pausesOf(segments).filter((p) => !p.justified);

test('кейс Романа: «Да, щас, дві хвилинки.» робить наступну паузу законною', () => {
  const segments = [
    seg('manager', 'Да, щас, дві хвилинки.', 0, 2),
    seg('client', 'Угу.', 2, 3),
    seg('manager', 'Алло!', 14.3, 15),
  ];
  const [pause] = pausesOf(segments);
  assert.equal(pause.pauseSec, 11.3);
  assert.equal(pause.justified, true);
  assert.equal(pause.reason, PAUSE_WARNED_BEFORE);
  assert.deepEqual(candidatesOf(segments), []);
});

test('пауза після підтакування «Угу.» не стає кандидатом — питання не ставили', () => {
  const segments = [
    seg('manager', 'Там по ціні виходить дві тисячі вісімсот гривень разом.', 0, 4),
    seg('client', 'Угу.', 4, 5),
    seg('manager', 'Можемо записати вас на четвер зранку, якщо зручно.', 13, 16),
  ];
  const [pause] = pausesOf(segments);
  assert.equal(pause.justified, true);
  assert.equal(pause.reason, PAUSE_CLIENT_SILENT);
});

test('поріг 6с: пауза 4.5с не рахується, 7с рахується', () => {
  const build = (gap) => [
    seg('manager', 'Доброго дня, автосервіс, слухаю вас уважно.', 0, 3),
    seg('client', 'А скільки коштує заміна зчеплення на Пассаті?', 3, 6),
    seg('manager', 'Залежить від того, яке зчеплення ставити, десь від восьми тисяч.', 6 + gap, 9 + gap),
  ];
  assert.deepEqual(pausesOf(build(4.5)), []);
  assert.equal(candidatesOf(build(7)).length, 1);
});

test('пауза 35с — це переведення дзвінка, а не тиша, і в кандидати не йде', () => {
  const withWarning = [
    seg('manager', 'Секунду, перемкну вас на майстра.', 0, 2),
    seg('client', 'А скільки це може зайняти часу приблизно?', 2, 5),
    seg('manager', 'Вибачте, що чекали, майстер зараз підійде до телефону.', 40, 43),
  ];
  const noWarning = [
    seg('manager', 'Так, зрозумів вас.', 0, 2),
    seg('client', 'А скільки це може зайняти часу приблизно?', 2, 5),
    seg('manager', 'Вибачте, що чекали, майстер зараз підійде до телефону.', 40, 43),
  ];
  for (const segments of [withWarning, noWarning]) {
    const [pause] = pausesOf(segments);
    assert.equal(pause.reason, PAUSE_HOLD);
    assert.equal(pause.justified, true);
  }
});

test('дві сусідні паузи в одному обміні дають один кандидат, а не два', () => {
  const segments = [
    seg('client', 'Двигун почав дивно працювати, цвиркає щось під капотом.', 0, 4),
    seg('manager', 'Двигун рівно працює? Чи цвиркає саме на холодну?', 12, 15),
    seg('client', 'Цвиркає переважно вранці, коли машина постояла ніч.', 15, 19),
    seg('manager', 'Тоді треба подивитись ремінь і ролики, це займе годину.', 27, 31),
  ];
  const pauses = pausesOf(segments);
  assert.equal(pauses.length, 2);
  assert.equal(pauses[1].reason, PAUSE_SAME_EXCHANGE);
  assert.equal(candidatesOf(segments).length, 1);
});

test('трикрапка означає, що клієнт стих сам — це не перебивання', () => {
  const segments = [
    seg('client', 'Я хотів спитати про заміну масла, але…', 0, 5),
    seg('manager', 'Можу записати вас на завтра на одинадцяту.', 4.0, 8),
  ];
  assert.deepEqual(detectInterruptions(segments, OVERLAP), []);
});

test('підтакування менеджера поверх мови клієнта — це слухання, а не перебивання', () => {
  const segments = [
    seg('client', 'У мене там стукає щось спереду, коли їду по нерівній дорозі', 0, 6),
    seg('manager', 'Ага.', 4, 5),
  ];
  assert.deepEqual(detectInterruptions(segments, OVERLAP), []);
});

test('справжнє перекриття: менеджер почав, поки клієнт говорив, і клієнт замовк', () => {
  const segments = [
    seg('client', 'У мене там стукає щось спереду, коли їду по нерівній', 0, 6),
    seg('manager', 'Зрозуміло, це скоріше за все стійки стабілізатора.', 4.5, 9),
  ];
  const [hit] = detectInterruptions(segments, OVERLAP);
  assert.equal(hit.overlapSec, 1.5);
  assert.equal(hit.quote, 'Зрозуміло, це скоріше за все стійки стабілізатора.');
});

test('клієнт, який говорив далі поверх менеджера, не вважається перебитим', () => {
  const segments = [
    seg('client', 'У мене там стукає щось спереду, коли їду по нерівній дорозі', 0, 10),
    seg('manager', 'Зрозуміло, це стійки.', 4, 6),
  ];
  assert.deepEqual(detectInterruptions(segments, OVERLAP), []);
});

test('уламок на два символи не вважається обірваною думкою', () => {
  const segments = [
    seg('client', 'Яс--', 0, 6),
    seg('manager', 'Зрозуміло, це скоріше за все стійки стабілізатора.', 4.5, 9),
  ];
  assert.deepEqual(detectInterruptions(segments, OVERLAP), []);
});

test('законні паузи лишаються в заміреному блоці для оцінки балу, з позначкою', () => {
  const segments = [
    seg('manager', 'Хвилинку, зараз подивлюсь по базі.', 0, 2),
    seg('client', 'Добре, я почекаю на лінії, дякую вам.', 2, 5),
    seg('manager', 'Є вільне місце на четвер о десятій.', 14, 17),
  ];
  const block = metricsPromptBlock(dialogueMetrics(segments, { thresholdSec: THRESHOLD }));
  assert.match(block, /пауза 9с/);
  assert.match(block, /пауза законна/);
});

test('без таймкодів метрики мовчать, а не вигадують паузи', () => {
  const segments = [seg('client', 'Алло', null, null), seg('manager', 'Слухаю', null, null)];
  assert.deepEqual(pausesOf(segments), []);
  assert.deepEqual(detectInterruptions(segments, OVERLAP), []);
});

test('на старих посічених транскриптах обрив на тире лишається резервним сигналом', () => {
  const segments = [
    seg('client', 'Я хотів спитати, чи можна приїхати сьог—', 0, 5),
    seg('manager', 'Сьогодні вже все розписано, давайте на завтра.', 5, 9),
  ];
  const [hit] = detectInterruptions(segments, OVERLAP);
  assert.equal(hit.kind, INTERRUPT_CUT_OFF);
  assert.equal(hit.overlapSec, 0);
});

test('перекриття має пріоритет над тире — це сильніший сигнал', () => {
  const segments = [
    seg('client', 'Я хотів спитати, чи можна приїхати сьог—', 0, 6),
    seg('manager', 'Сьогодні вже все розписано, давайте на завтра.', 4.5, 9),
  ];
  const [hit] = detectInterruptions(segments, OVERLAP);
  assert.equal(hit.kind, INTERRUPT_OVERLAP);
  assert.equal(hit.overlapSec, 1.5);
});

test('тире не рятує уламок і не рятує підтакування у відповідь', () => {
  assert.deepEqual(detectInterruptions([seg('client', 'Яс—', 0, 5), seg('manager', 'Зрозуміло, записую вас.', 5, 7)], OVERLAP), []);
  assert.deepEqual(detectInterruptions([seg('client', 'Я хотів спитати, чи можна сьог—', 0, 5), seg('manager', 'Угу.', 5, 6)], OVERLAP), []);
});
