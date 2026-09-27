import { postForm } from './client.js';

async function transcribeFile({ op, model, audioBlob, filename = 'call.mp3', language, prompt, attempts, delayMs, label }) {
  const form = new FormData();
  form.append('file', audioBlob, filename);
  form.append('model', model);
  if (language) form.append('language', language);
  if (prompt) form.append('prompt', prompt);
  const data = await postForm('/audio/transcriptions', { op, form, attempts, delayMs, label });
  return data.text;
}

export { transcribeFile };
