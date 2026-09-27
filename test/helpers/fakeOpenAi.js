import { useTransport, resetUsage } from '../../src/platform/openai/client.js';

function jsonResponse(payload, usage) {
  return {
    json: async () => ({
      choices: [{ message: { content: JSON.stringify(payload) } }],
      usage: usage || { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
    }),
  };
}

function textResponse(text, usage) {
  return {
    json: async () => ({
      choices: [{ message: { content: text } }],
      usage: usage || { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 },
    }),
  };
}

function embeddingResponse(vectors) {
  return {
    json: async () => ({
      data: vectors.map((embedding, index) => ({ index, embedding })),
      usage: { prompt_tokens: 10, completion_tokens: 0, total_tokens: 10 },
    }),
  };
}

function installFakeOpenAi(handler) {
  const calls = [];
  const restore = useTransport(async (op, path, init, options) => {
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
    const call = { op, path, body, options, form: init?.body instanceof FormData ? init.body : null };
    calls.push(call);
    const reply = await handler(call, calls.length - 1);
    if (reply instanceof Error) throw reply;
    return reply;
  });
  resetUsage();
  return {
    calls,
    restore: () => {
      restore();
      resetUsage();
    },
  };
}

function scripted(replies) {
  let index = 0;
  return () => {
    const reply = replies[index];
    index += 1;
    if (reply === undefined) throw new Error(`фейковий OpenAI: зайвий виклик №${index}`);
    return reply;
  };
}

export { installFakeOpenAi, scripted, jsonResponse, textResponse, embeddingResponse };
