import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sendCopyable, splitMessage } from '../../src/platform/telegram/ui.js';

function fakeApi({ failHtml = false } = {}) {
  const sent = [];
  return {
    sent,
    async sendMessage(chatId, text, extra = {}) {
      if (failHtml && extra.parse_mode) throw new Error('can\'t parse entities');
      sent.push({ text, extra });
      return { message_id: sent.length };
    },
  };
}

test('поточний текст приходить блоком, який Telegram дає скопіювати в один тап', async () => {
  const api = fakeApi();
  await sendCopyable(api, 1, 'перший рядок\nдругий рядок');
  assert.equal(api.sent.length, 1);
  assert.equal(api.sent[0].extra.parse_mode, 'HTML');
  assert.ok(api.sent[0].text.includes('<pre>перший рядок\nдругий рядок</pre>'));
});

test('кутові дужки й амперсанд у промпті не ламають розмітку', async () => {
  const api = fakeApi();
  await sendCopyable(api, 1, 'якщо a < b && c > d — поверни <b>true</b>');
  const body = api.sent[0].text;
  assert.ok(body.includes('&lt;b&gt;true&lt;/b&gt;'));
  assert.ok(body.includes('&amp;&amp;'));
  assert.equal(body.indexOf('<pre>'), body.lastIndexOf('<pre>'));
});

test('пояснення перед блоком теж екранується', async () => {
  const api = fakeApi();
  await sendCopyable(api, 1, 'текст інструкції', { intro: 'Поточний текст <власний>' });
  assert.ok(api.sent[0].text.startsWith('Поточний текст &lt;власний&gt;'));
});

test('найдовший промпт ріжеться на частини, і кожна лишається копійованою', async () => {
  const api = fakeApi();
  const long = Array.from({ length: 400 }, (_, i) => `рядок номер ${i}`).join('\n');
  const ids = await sendCopyable(api, 1, long);
  assert.ok(api.sent.length > 1);
  assert.equal(ids.length, api.sent.length);
  for (const [i, message] of api.sent.entries()) {
    assert.ok(message.text.includes('<pre>'), `частина ${i + 1} без блоку`);
    assert.ok(message.text.length <= 4096, `частина ${i + 1} довша за ліміт Telegram`);
  }
  assert.ok(api.sent[0].text.includes('Частина 1 з'));
});

test('збій розмітки не лишає власника без тексту — повідомлення йде простим', async () => {
  const api = fakeApi({ failHtml: true });
  const ids = await sendCopyable(api, 1, 'текст інструкції', { intro: 'Поточний текст' });
  assert.equal(ids.length, 1);
  assert.equal(api.sent[0].extra.parse_mode, undefined);
  assert.ok(api.sent[0].text.includes('текст інструкції'));
});

test('звичайне розбиття повідомлень не змінилось', () => {
  assert.deepEqual(splitMessage('короткий'), ['короткий']);
  assert.ok(splitMessage('x'.repeat(9000)).length >= 3);
});
