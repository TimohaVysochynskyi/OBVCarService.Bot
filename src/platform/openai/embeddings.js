import { post } from './client.js';

async function embed({ op, model, input, attempts, delayMs, label }) {
  const data = await post('/embeddings', { op, model, body: { model, input }, attempts, delayMs, label });
  return data.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
}

export { embed };
