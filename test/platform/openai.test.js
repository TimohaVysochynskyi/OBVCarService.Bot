import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readSrc } from '../helpers/repo.js';
import { installFakeOpenAi, scripted, jsonResponse, textResponse, embeddingResponse } from '../helpers/fakeOpenAi.js';
import { chatJson, chatText } from '../../src/platform/openai/llm.js';
import { embed } from '../../src/platform/openai/embeddings.js';
import { usageReport, usageLine, estimateTokens, waitMsFor, TPM_BY_MODEL, PRICE_PER_MTOK } from '../../src/platform/openai/client.js';

const MESSAGES = [{ role: 'user', content: 'привіт' }];

async function withFake(handler, run) {
  const fake = installFakeOpenAi(handler);
  try {
    return { value: await run(), calls: fake.calls };
  } finally {
    fake.restore();
  }
}

test('chatJson шле модель, повідомлення і схему одним тілом', async () => {
  const schema = { name: 's', strict: true, schema: { type: 'object' } };
  const { value, calls } = await withFake(scripted([jsonResponse({ ok: 1 })]), () =>
    chatJson({ op: 'тест', model: 'gpt-4o-mini', messages: MESSAGES, schema }));
  assert.deepEqual(value, { ok: 1 });
  assert.equal(calls[0].path, '/chat/completions');
  assert.equal(calls[0].body.model, 'gpt-4o-mini');
  assert.deepEqual(calls[0].body.messages, MESSAGES);
  assert.deepEqual(calls[0].body.response_format.json_schema, schema);
});

test('temperature не додається, якщо її не просили', async () => {
  const { calls } = await withFake(scripted([jsonResponse({})]), () =>
    chatJson({ op: 'тест', model: 'gpt-4o-mini', messages: MESSAGES }));
  assert.ok(!('temperature' in calls[0].body), 'зайва temperature змінила б поведінку моделі');
});

test('temperature 0 доходить до тіла запиту як є', async () => {
  const { calls } = await withFake(scripted([jsonResponse({})]), () =>
    chatJson({ op: 'тест', model: 'gpt-4o', messages: MESSAGES, temperature: 0 }));
  assert.equal(calls[0].body.temperature, 0);
});

test('chatText віддає текст відповіді, не JSON', async () => {
  const { value } = await withFake(scripted([textResponse('Менеджер: Алло')]), () =>
    chatText({ op: 'тест', model: 'gpt-4o-mini', messages: MESSAGES }));
  assert.equal(value, 'Менеджер: Алло');
});

test('embed повертає вектори у порядку входу, навіть якщо API переплутав', async () => {
  const { value } = await withFake(
    scripted([{ json: async () => ({ data: [{ index: 1, embedding: [2] }, { index: 0, embedding: [1] }], usage: {} }) }]),
    () => embed({ op: 'тест', model: 'text-embedding-3-small', input: ['a', 'b'] }));
  assert.deepEqual(value, [[1], [2]]);
});

test('embed шле батч одним запитом', async () => {
  const { calls } = await withFake(scripted([embeddingResponse([[1], [2], [3]])]), () =>
    embed({ op: 'тест', model: 'text-embedding-3-small', input: ['a', 'b', 'c'] }));
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].body.input, ['a', 'b', 'c']);
});

test('збій повторюється рівно стільки разів, скільки просив викликач', async () => {
  let attempts = 0;
  const { value } = await withFake(
    () => {
      attempts += 1;
      return attempts < 3 ? new Error('тимчасовий збій') : jsonResponse({ ok: true });
    },
    () => chatJson({ op: 'тест', model: 'gpt-4o-mini', messages: MESSAGES, attempts: 3, delayMs: 1 }));
  assert.equal(attempts, 3);
  assert.deepEqual(value, { ok: true });
});

test('вичерпані спроби кидають помилку назовні', async () => {
  const fake = installFakeOpenAi(() => new Error('постійний збій'));
  try {
    await assert.rejects(() => chatJson({ op: 'тест', model: 'gpt-4o-mini', messages: MESSAGES, attempts: 2, delayMs: 1 }));
  } finally {
    fake.restore();
  }
});

test('токени й гроші рахуються з відповіді, а не оцінюються', async () => {
  const fake = installFakeOpenAi(scripted([
    jsonResponse({}, { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 }),
    jsonResponse({}, { prompt_tokens: 2000, completion_tokens: 100, total_tokens: 2100 }),
  ]));
  try {
    await chatJson({ op: 'a', model: 'gpt-4o', messages: MESSAGES });
    await chatJson({ op: 'b', model: 'gpt-4o-mini', messages: MESSAGES });
    const report = usageReport();
    assert.equal(report.calls, 2);
    const big = report.models.find((m) => m.model === 'gpt-4o');
    assert.equal(big.promptTokens, 1000);
    assert.equal(big.completionTokens, 500);
    assert.equal(big.usd, (1000 * 2.5 + 500 * 10) / 1_000_000);
    const small = report.models.find((m) => m.model === 'gpt-4o-mini');
    assert.equal(small.usd, (2000 * 0.15 + 100 * 0.6) / 1_000_000);
    assert.ok(usageLine().includes('$'));
  } finally {
    fake.restore();
  }
});

test('без запитів рядок вартості каже про це прямо', () => {
  assert.equal(usageLine(), 'запитів до OpenAI не було');
});

test('ціна відома для всіх моделей, якими проєкт справді користується', () => {
  for (const model of ['gpt-4o', 'gpt-4o-mini', 'text-embedding-3-small']) {
    assert.ok(PRICE_PER_MTOK[model], `немає ціни для ${model}`);
  }
});

test('ліміт 30k/хв заведений саме на модель, що його ділить зі звітами', () => {
  assert.equal(TPM_BY_MODEL['gpt-4o'], 30_000);
  assert.equal(TPM_BY_MODEL['gpt-4o-mini'], undefined, 'mini має власний, значно вищий ліміт');
});

test('оцінка токенів рахується з тіла запиту і не занижує', () => {
  const small = estimateTokens({ messages: [{ content: 'а'.repeat(100) }] });
  const big = estimateTokens({ messages: [{ content: 'а'.repeat(1000) }] });
  assert.ok(big > small * 5);
  assert.ok(small > 0);
});

test('поки бюджет хвилини не вичерпано — чекати не треба', () => {
  assert.equal(waitMsFor('gpt-4o', 1000, Date.now()), 0);
});

test('модель без ліміту не чекає ніколи', () => {
  assert.equal(waitMsFor('gpt-4o-mini', 10_000_000, Date.now()), 0);
});

test('запит, більший за весь бюджет хвилини, не зависає назавжди', () => {
  assert.equal(waitMsFor('gpt-4o', 50_000, Date.now()), 0);
});

test('ключ перевіряється в транспорті — фейк працює без нього', () => {
  const client = readSrc('platform/openai/client.js');
  assert.match(client, /function requireKey\(op\)/);
  assert.match(client, /Authorization: `Bearer \$\{requireKey\(op\)\}`/);
  assert.ok(!/apiKey/.test(client.slice(client.indexOf('async function post'))),
    'post() не має знати про ключ — заголовок ставить транспорт');
});

test('увесь OpenAI сховано за портом: жодного URL поза platform/openai', () => {
  for (const file of ['features/analysis/analyzeCall.js', 'features/analysis/classifyCall.js', 'features/analysis/dealBlocker.js', 'features/analysis/clientDecline.js',
    'features/analysis/classifyPersonal.js', 'features/analysis/identifyManager.js', 'features/analysis/transcribe.js', 'platform/elevenlabs/client.js',
    'features/reporting/analyze.js', 'features/knowledge-base/kb.js', 'features/archive/dialogue.js', 'features/ops/health.js']) {
    assert.ok(!/api\.openai\.com/.test(readSrc(file)), `${file} ходить в OpenAI повз порт`);
    assert.ok(!/Bearer \$\{config\.openai\.apiKey\}/.test(readSrc(file)), `${file} сам тримає ключ`);
  }
});
