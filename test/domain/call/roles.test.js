import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ROLE_INVERTED,
  ROLE_OK,
  ROLE_UNCLEAR,
  channelVerdict,
  invertRoles,
  keywordSpeaker,
  selfIntroSpeaker,
  speakerOfChannel,
  transcriptFromSegments,
} from '../../../src/domain/call/roles.js';

const turn = (speaker, text) => ({ speaker, text });

const LOUD = 1200;
const QUIET = 300;

test('мовець нашого каналу береться за номером, а не за порядком', () => {
  assert.equal(speakerOfChannel(['speaker_0', 'speaker_1'], 0), 'speaker_0');
  assert.equal(speakerOfChannel(['speaker_0', 'speaker_1'], 1), 'speaker_1');
});

test('канал, якого серед мовців немає, не вигадується', () => {
  assert.equal(speakerOfChannel(['speaker_0'], 1), null);
  assert.equal(speakerOfChannel([], 0), null);
});

test('самопредставлення віддає роль тому, хто назвався', () => {
  const turns = [turn('speaker_1', 'Алло'), turn('speaker_0', 'Добрий день, це Роман, автосервіс')];
  assert.equal(selfIntroSpeaker(turns, 'Роман'), 'speaker_0');
});

test('питальна форма «Це Роман?» — це запитання, а не представлення', () => {
  assert.equal(selfIntroSpeaker([turn('speaker_1', 'Це Роман?')], 'Роман'), null);
  assert.equal(selfIntroSpeaker([turn('speaker_1', 'Алло, це Роман?')], 'Роман'), null);
});

test('звертання «Алло, Роман» говорить ТОЙ, ХТО ЗВЕРТАЄТЬСЯ, — ролі він не отримує', () => {
  for (const text of ['Алло, Роман', 'Да, Роман.', 'Привіт, Роман, слухай', 'Ну, Роман, що там']) {
    assert.equal(selfIntroSpeaker([turn('speaker_1', text)], 'Роман'), null, `прийняв звертання «${text}»`);
  }
});

test('звертання не глушить справжнє представлення в тій самій розмові', () => {
  const turns = [turn('speaker_1', 'Алло, Роман'), turn('speaker_0', 'Да, це Роман')];
  assert.equal(selfIntroSpeaker(turns, 'Роман'), 'speaker_0');
});

test('латинські двійники в імені не ховають представлення', () => {
  assert.equal(selfIntroSpeaker([turn('speaker_0', 'Це Poмaн, слухаю')], 'Роман'), 'speaker_0');
});

test('без імені самопредставлення не перевіряється', () => {
  assert.equal(selfIntroSpeaker([turn('speaker_0', 'Це Роман')], null), null);
});

test('keyword-евристика віддає того, хто говорить мовою сервісу', () => {
  const turns = [
    turn('speaker_0', 'У мене стукає щось спереду'),
    turn('speaker_1', 'Можу записати вас на діагностику, приїжджайте'),
  ];
  assert.equal(keywordSpeaker(turns, ['speaker_0', 'speaker_1']), 'speaker_1');
});

test('без жодного маркера евристика мовчить, а не вгадує', () => {
  const turns = [turn('speaker_0', 'Ага'), turn('speaker_1', 'Добре')];
  assert.equal(keywordSpeaker(turns, ['speaker_0', 'speaker_1']), null);
});

test('транскрипт збирається з ролей, тож підпис завжди збігається з segments', () => {
  const segments = [
    { role: 'manager', text: 'Добрий день' },
    { role: 'client', text: 'Вітаю' },
  ];
  assert.equal(transcriptFromSegments(segments), 'Менеджер: Добрий день\n\nКлієнт: Вітаю');
});

test('інверсія міняє ролі місцями і не чіпає таймкоди', () => {
  const segments = [{ role: 'manager', text: 'А', start: 0, end: 1 }, { role: 'client', text: 'Б', start: 1, end: 2 }];
  const flipped = invertRoles(segments);
  assert.deepEqual(flipped.map((s) => s.role), ['client', 'manager']);
  assert.deepEqual(flipped.map((s) => [s.start, s.end]), [[0, 1], [1, 2]]);
});

test('подвійна інверсія повертає оригінал — скрипт ремонту ідемпотентний', () => {
  const segments = [{ role: 'manager', text: 'А' }, { role: 'client', text: 'Б' }];
  assert.deepEqual(invertRoles(invertRoles(segments)), segments);
});

test('менеджер на нашому каналі — вердикт «коректно»', () => {
  const verdict = channelVerdict(
    { manager: [LOUD, QUIET], client: [QUIET, LOUD] },
    { managerChannel: 0, margin: 1.35 }
  );
  assert.equal(verdict, ROLE_OK);
});

test('менеджер на чужому каналі — вердикт «перевернуто»', () => {
  const verdict = channelVerdict(
    { manager: [QUIET, LOUD], client: [LOUD, QUIET] },
    { managerChannel: 0, margin: 1.35 }
  );
  assert.equal(verdict, ROLE_INVERTED);
});

test('зміна каналу менеджера перевертає той самий замір', () => {
  const energy = { manager: [LOUD, QUIET], client: [QUIET, LOUD] };
  assert.equal(channelVerdict(energy, { managerChannel: 0, margin: 1.35 }), ROLE_OK);
  assert.equal(channelVerdict(energy, { managerChannel: 1, margin: 1.35 }), ROLE_INVERTED);
});

test('слабке розділення каналів лишається неоднозначним, а не вгадується', () => {
  const verdict = channelVerdict(
    { manager: [1000, 900], client: [900, 1000] },
    { managerChannel: 0, margin: 1.35 }
  );
  assert.equal(verdict, ROLE_UNCLEAR);
});

test('лише одна сторона переважає — теж неоднозначно', () => {
  const verdict = channelVerdict(
    { manager: [LOUD, QUIET], client: [1000, 1000] },
    { managerChannel: 0, margin: 1.35 }
  );
  assert.equal(verdict, ROLE_UNCLEAR);
});

test('замір без однієї зі сторін не дає вердикту', () => {
  assert.equal(channelVerdict({ manager: null, client: null }, { managerChannel: 0, margin: 1.35 }), ROLE_UNCLEAR);
});
