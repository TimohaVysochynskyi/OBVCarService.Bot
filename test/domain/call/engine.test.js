import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ENGINE_SERVICE_KEYS,
  isRepairService,
  mentionsEngine,
  serviceLabel,
  servicePromptList,
} from '../../../src/domain/call/engine.js';
import { installFakeOpenAi, scripted, jsonResponse } from '../../helpers/fakeOpenAi.js';
import { detectEngineRequest } from '../../../src/features/analysis/engineRequest.js';

const ENGINE_TALK = 'Клієнт: Доброго дня, у мене мотор стукає, треба капремонт подивитись.';

test('двигун упізнається в усіх розмовних формах', () => {
  for (const text of [
    'у мене мотор стукає',
    'двигун троїть на холодну',
    'двигатель жрет масло',
    'треба двіжок перебрати',
    'движок застукав',
    'капремонт ДВС скільки коштує',
    'прокладка ГБЦ потекла',
    'турбіна свистить',
  ]) {
    assert.equal(mentionsEngine(text), true, `не впізнав: ${text}`);
  }
});

test('розмова без двигуна гейт не проходить', () => {
  for (const text of ['поміняти колодки і диски', 'кондиціонер не холодить', 'розвал-сходження']) {
    assert.equal(mentionsEngine(text), false, `хибне спрацювання: ${text}`);
  }
});

test('планове ТО не рахується ремонтною роботою', () => {
  assert.equal(isRepairService('maintenance'), false);
  assert.equal(isRepairService('other'), false);
  assert.equal(isRepairService('overhaul'), true);
  assert.equal(isRepairService('turbo'), true);
});

test('у кожної послуги є підпис і пояснення для моделі', () => {
  const list = servicePromptList();
  for (const key of ENGINE_SERVICE_KEYS) {
    assert.ok(serviceLabel(key), `немає підпису: ${key}`);
    assert.ok(list.includes(`"${key}"`), `${key} не доїхав у промпт`);
  }
});

async function run(transcript, reply) {
  const fake = installFakeOpenAi(scripted(reply ? [jsonResponse(reply)] : []));
  try {
    return { value: await detectEngineRequest(transcript), calls: fake.calls };
  } finally {
    fake.restore();
  }
}

test('без згадки двигуна модель НЕ викликається — беклог дешевий саме тому', async () => {
  const { value, calls } = await run('Клієнт: хочу поміняти гальмівні колодки.');
  assert.equal(value.isEngineRequest, false);
  assert.equal(calls.length, 0);
});

test('звернення з реальною цитатою зараховується разом з авто', async () => {
  const { value } = await run(ENGINE_TALK, {
    isEngineRequest: true,
    service: 'overhaul',
    car: 'Passat 1.9 TDI',
    evidence: 'у мене мотор стукає, треба капремонт подивитись',
  });
  assert.equal(value.isEngineRequest, true);
  assert.equal(value.service, 'overhaul');
  assert.equal(value.car, 'Passat 1.9 TDI');
});

test('вигадана цитата відкидає все звернення', async () => {
  const { value } = await run(ENGINE_TALK, {
    isEngineRequest: true,
    service: 'overhaul',
    car: 'Passat',
    evidence: 'клієнт просив замінити двигун повністю',
  });
  assert.equal(value.isEngineRequest, false);
  assert.equal(value.service, null);
});

test('послуга поза переліком не проходить', async () => {
  const { value } = await run(ENGINE_TALK, {
    isEngineRequest: true,
    service: 'подивитись мотор',
    car: null,
    evidence: 'у мене мотор стукає',
  });
  assert.equal(value.isEngineRequest, false);
});

test('авто не вигадується: порожнє або сміттєве значення стає null', async () => {
  for (const car of ['', 'невідомо', 'не вказано', null]) {
    const { value } = await run(ENGINE_TALK, {
      isEngineRequest: true,
      service: 'diagnostics',
      car,
      evidence: 'у мене мотор стукає, треба капремонт подивитись',
    });
    assert.equal(value.isEngineRequest, true);
    assert.equal(value.car, null, `прийняв сміття: ${JSON.stringify(car)}`);
  }
});

test('модель відповіла «не по двигуну» — рядок позначається явно, а не лишається порожнім', async () => {
  const { value } = await run(ENGINE_TALK, {
    isEngineRequest: false,
    service: null,
    car: null,
    evidence: null,
  });
  assert.deepEqual(value, { isEngineRequest: false, service: null, car: null, quote: null });
});
