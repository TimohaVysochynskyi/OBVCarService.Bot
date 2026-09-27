import { parseModelJson } from '../../core/errors.js';
import { post, get } from './client.js';

async function chatJson({ op, model, messages, schema, temperature, attempts, delayMs, label }) {
  const body = { model, messages };
  if (temperature != null) body.temperature = temperature;
  if (schema) body.response_format = { type: 'json_schema', json_schema: schema };
  const data = await post('/chat/completions', { op, model, body, attempts, delayMs, label });
  return parseModelJson(data, 'openai', op);
}

async function chatText({ op, model, messages, temperature, attempts, delayMs, label }) {
  const body = { model, messages };
  if (temperature != null) body.temperature = temperature;
  const data = await post('/chat/completions', { op, model, body, attempts, delayMs, label });
  return data?.choices?.[0]?.message?.content ?? '';
}

async function pingModel(model, { op = 'перевірка доступу до моделі', timeoutMs } = {}) {
  return get(`/models/${encodeURIComponent(model)}`, { op, timeoutMs });
}

export { chatJson, chatText, pingModel };
