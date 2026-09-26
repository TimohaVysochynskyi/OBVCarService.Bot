import { withRetry } from './retry.js';
import { parseModelJson } from './errors.js';
import { fetchOk } from './http.js';
import { transcribeDiarized } from './elevenlabs.js';

const PROMPTS = {
  uk: 'Це телефонна розмова автосервісу українською мовою. Часто трапляються розмовні форми та суржик (напр. "да", "шо", "тіки", "нема") — це все українська мова, транскрибуй українською.',
  ru: 'Это телефонный разговор автосервиса на русском языке.',
};
const DEFAULT_PROMPT = PROMPTS.uk;

async function transcribeOnce(audioBlob, { language, prompt } = {}) {
  return withRetry(
    async () => {
      const form = new FormData();
      form.append('file', audioBlob, 'call.mp3');
      form.append('model', process.env.OPENAI_TRANSCRIBE_MODEL || 'gpt-4o-mini-transcribe');
      if (language) form.append('language', language);
      if (prompt) form.append('prompt', prompt);

      const res = await fetchOk('openai', 'транскрипція розмови', 'https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
        body: form,
      });
      const data = await res.json();
      return data.text;
    },
    { attempts: 3, delayMs: 2000, label: `OpenAI transcription${language ? ` (${language})` : ''}` }
  );
}

const DETECT_SCHEMA = {
  name: 'lang_detect',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      spoken: { type: 'string', enum: ['uk', 'ru', 'other'] },
      transcriptLanguage: { type: 'string', enum: ['uk', 'ru', 'other'] },
    },
    required: ['spoken', 'transcriptLanguage'],
    additionalProperties: false,
  },
};

const DETECT_SYSTEM = `Проаналізуй транскрипт телефонної розмови й поверни дві мови:
1) spoken — якою мовою РЕАЛЬНО розмовляють люди. Українська розмовна з діалектизмами/суржиком (наприклад "да" замість "так", "шо", "тіки", "нема", "трошки") — це УКРАЇНСЬКА (uk), НЕ російська. Російська — лише коли лексика й граматика справді російські. Інакше — other.
2) transcriptLanguage — якою мовою фактично НАПИСАНО наведений текст (uk / ru / other).

Приклад: людина говорить українською з суржиком, але текст записано російськими словами → spoken="uk", transcriptLanguage="ru".`;

async function detectLanguages(text) {
  return withRetry(
    async () => {
      const res = await fetchOk('openai', 'визначення мови розмови', 'https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: process.env.OPENAI_ANALYZE_MODEL || 'gpt-4o-mini',
          messages: [
            { role: 'system', content: DETECT_SYSTEM },
            { role: 'user', content: text.slice(0, 4000) },
          ],
          response_format: { type: 'json_schema', json_schema: DETECT_SCHEMA },
        }),
      });
      const data = await res.json();
      return parseModelJson(data, 'openai', 'визначення мови розмови');
    },
    { attempts: 2, delayMs: 1000, label: 'OpenAI language detection' }
  );
}

async function toBlob(audio) {
  if (typeof audio === 'string') {
    const blob = await withRetry(
      async () => {
        console.log(`[transcribe] downloading recording from ${audio}`);
        const res = await fetchOk('recording', 'завантаження запису', audio);
        return res.blob();
      },
      { attempts: 3, delayMs: 1000, label: 'download recording' }
    );
    return blob;
  }
  if (Buffer.isBuffer(audio)) return new Blob([audio], { type: 'audio/mpeg' });
  if (audio && typeof audio.arrayBuffer === 'function') return audio;
  throw new Error('transcribeAudio: expected a Buffer, Blob or URL string');
}

async function transcribeAudio(audio, { managerName, audioPath } = {}) {
  const audioBlob = await toBlob(audio);
  console.log(`[transcribe] audio ready: ${audioBlob.size} bytes`);

  if (process.env.ELEVENLABS_API_KEY) {
    try {
      const result = await transcribeDiarized(audioBlob, managerName, { audioPath });
      console.log(`[transcribe] ElevenLabs OK — ${result.transcript.length} chars (diarized, ${result.segments?.length ?? 0} segments)`);
      return result;
    } catch (err) {
      console.error(`[transcribe] ElevenLabs failed, falling back to OpenAI: ${err.message}`);
    }
  }

  console.log('[transcribe] transcribing via OpenAI (plain, no diarization)...');

  const forced = process.env.CALL_LANGUAGE;
  if (forced) {
    const text = await transcribeOnce(audioBlob, { language: forced, prompt: PROMPTS[forced] });
    console.log(`[transcribe] received ${text.length} chars (forced ${forced})`);
    return { transcript: text, segments: null };
  }

  let text = await transcribeOnce(audioBlob, { prompt: DEFAULT_PROMPT });

  try {
    const { spoken, transcriptLanguage } = await detectLanguages(text);
    console.log(`[transcribe] detected spoken=${spoken}, transcript=${transcriptLanguage}`);
    if ((spoken === 'uk' || spoken === 'ru') && transcriptLanguage !== spoken) {
      console.log(`[transcribe] mismatch - re-transcribing forced ${spoken}`);
      text = await transcribeOnce(audioBlob, { language: spoken, prompt: PROMPTS[spoken] });
    }
  } catch (err) {
    console.error(`[transcribe] language detection skipped: ${err.message}`);
  }

  console.log(`[transcribe] received ${text.length} chars`);
  return { transcript: text, segments: null };
}

export { transcribeAudio };
