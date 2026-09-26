import { withRetry } from './retry.js';
import { parseModelJson } from './errors.js';
import { fetchOk, fetchRaw } from './http.js';
import { probeChannels } from './audioMeta.js';

const STT_URL = 'https://api.elevenlabs.io/v1/speech-to-text';
const SUBSCRIPTION_URL = 'https://api.elevenlabs.io/v1/user/subscription';
const sttModel = () => process.env.ELEVENLABS_STT_MODEL || 'scribe_v1';
const numSpeakers = () => process.env.ELEVENLABS_NUM_SPEAKERS || '2';

async function sttDiarize(audioBlob, { multichannel = false } = {}) {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) throw new Error('ELEVENLABS_API_KEY is not set');
  return withRetry(
    async () => {
      const form = new FormData();
      form.append('file', audioBlob, 'call.mp3');
      form.append('model_id', sttModel());
      if (multichannel) {
        form.append('use_multi_channel', 'true');
        form.append('diarize', 'false');
        form.append('multichannel_output_style', 'combined');
      } else {
        form.append('diarize', 'true');
        form.append('num_speakers', numSpeakers());
      }
      if (process.env.CALL_LANGUAGE) form.append('language_code', process.env.CALL_LANGUAGE);

      const res = await fetchOk('elevenlabs', 'транскрипція розмови', STT_URL, {
        method: 'POST',
        headers: { 'xi-api-key': key },
        body: form,
      });
      return res.json();
    },
    { attempts: 3, delayMs: 2000, label: 'ElevenLabs STT' }
  );
}

const DEFAULT_USD_PER_1000_CREDITS = 0.3642;

const DEFAULT_MIN_BALANCE_USD = 3.31;

const envNumber = (name, fallback) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

function creditsToUsd(credits) {
  const amount = Number(credits);
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  return (amount / 1000) * envNumber('ELEVENLABS_USD_PER_1000_CREDITS', DEFAULT_USD_PER_1000_CREDITS);
}

function minBalanceUsd() {
  return envNumber('ELEVENLABS_MIN_BALANCE_USD', DEFAULT_MIN_BALANCE_USD);
}

async function getElevenLabsBalance() {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) return { ok: false, reason: 'no_key' };
  try {
    const res = await fetchRaw('elevenlabs', 'перевірка балансу', SUBSCRIPTION_URL, {
      headers: { 'xi-api-key': key },
    });
    if (res.status === 401) {
      const body = await res.text();
      return { ok: false, reason: /missing_permission|user_read/i.test(body) ? 'missing_permission' : 'unauthorized' };
    }
    if (!res.ok) return { ok: false, reason: `http_${res.status}` };
    const data = await res.json();
    const used = Number(data.character_count ?? 0);
    const limit = Number(data.character_limit ?? 0);
    return { ok: true, used, limit, remainingCredits: Math.max(0, limit - used), tier: data.tier, currency: data.currency };
  } catch (err) {
    return { ok: false, reason: 'error', error: err.message };
  }
}

function buildTurns(words) {
  const turns = [];
  let cur = null;
  for (const w of words || []) {
    const t = w.text ?? '';
    if (w.type === 'spacing') {
      if (cur) cur.text += t;
      continue;
    }
    const sid =
      w.speaker_id ??
      (w.channel_index != null ? `speaker_${w.channel_index}` : cur ? cur.speaker : 'speaker_0');
    if (!cur || cur.speaker !== sid) {
      if (cur) turns.push(cur);
      cur = { speaker: sid, text: t, start: w.start ?? null, end: w.end ?? null };
    } else {
      cur.text += t;
      if (w.start != null && cur.start == null) cur.start = w.start;
      if (w.end != null) cur.end = w.end;
    }
  }
  if (cur) turns.push(cur);
  return turns
    .map((x) => ({ speaker: x.speaker, text: x.text.replace(/\s+/g, ' ').trim(), start: x.start, end: x.end }))
    .filter((x) => x.text);
}

const ROLE_SCHEMA = {
  name: 'speaker_roles',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      reasoning: { type: 'string' },
      manager: { type: 'string' },
      confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    },
    required: ['reasoning', 'manager', 'confidence'],
    additionalProperties: false,
  },
};

const MANAGER_MARKERS = [
  'автосервіс', 'автосервис', 'сервіс', 'сервис', 'сто', 'наш майстер', 'майстер', 'мастер',
  'запиш', 'записати', 'запишу', 'запишемо', 'запис на', 'на яку годину', 'на яке авто', 'яка марка',
  'яке авто', 'яка машина', 'діагностик', 'диагностик', 'вартість', 'коштує', 'стоит', 'по ціні',
  'приїжджайте', 'приезжайте', 'підʼїжджайте', 'подъезжайте', 'чим можу допомогти', 'чем могу помочь',
  'передзвоню', 'перезвоню', 'уточню', 'вільн', 'свободн', 'гарного дня', 'працюємо до', 'гривень', 'грн',
  'у нас є', 'наша адреса', 'запчастин', 'запчаст',
];

function selfIntroManager(turns, speakerIds, managerName) {
  const n = String(managerName || '').trim().toLowerCase();
  if (n.length < 3) return null;
  const patterns = [
    `це ${n}`, `это ${n}`, `мене звати ${n}`, `меня зовут ${n}`, `звати ${n}`, `зовут ${n}`,
    `${n} вас турбує`, `${n} вас беспокоит`, `${n} турбує`, `${n} беспокоит`,
    `${n} на зв`, `${n} на связи`, `це знову ${n}`, `это снова ${n}`,
  ];
  for (const t of turns) {
    const low = t.text.toLowerCase();
    if (patterns.some((p) => low.includes(p))) return t.speaker;
  }
  return null;
}

function heuristicManager(turns, speakerIds) {
  const score = Object.fromEntries(speakerIds.map((s) => [s, 0]));
  for (const t of turns) {
    const low = t.text.toLowerCase();
    for (const m of MANAGER_MARKERS) if (low.includes(m)) score[t.speaker] += 1;
  }
  let best = null;
  let bestScore = 0;
  for (const sid of speakerIds) {
    if (score[sid] > bestScore) {
      bestScore = score[sid];
      best = sid;
    }
  }
  return best;
}

async function pickManagerSpeaker(turns, speakerIds, managerName) {
  const intro = selfIntroManager(turns, speakerIds, managerName);
  if (intro) {
    console.log(`[elevenlabs] manager by self-introduction ("${managerName}") → ${intro}`);
    return intro;
  }

  const keyword = heuristicManager(turns, speakerIds);

  const MAX_CHARS = 8000;
  let body = '';
  for (const t of turns) {
    const line = `[${t.speaker}] ${t.text}\n`;
    if (body.length + line.length > MAX_CHARS) break;
    body += line;
  }

  const system = managerName
    ? `Ти аналізуєш транскрипт телефонної розмови автосервісу (СТО). Учасники: ${speakerIds.join(', ')}. ` +
      `Один із них — НАШ працівник на імʼя «${managerName}» (враховуй варіанти написання: Андрій/Андрей, Володимир/Владимир тощо). Визнач, ХТО з мовців — це «${managerName}».\n` +
      `Найнадійніше — САМОПРЕДСТАВЛЕННЯ цим імʼям ("це ${managerName}", "мене звати ${managerName}", "${managerName} вас турбує/беспокоит"): тоді ЦЕЙ мовець і є наш працівник — навіть якщо він сам комусь телефонує й звучить як замовник.\n` +
      `Якщо імені в розмові немає: наш працівник — той, хто поводиться як працівник СТО (вітає від сервісу, консультує клієнта, пропонує запис/ціни/майстра); АБО, якщо це ВИХІДНИЙ дзвінок (наш працівник сам телефонує постачальнику/іншому сервісу), наш працівник — той, хто телефонує й пояснює свою потребу, а НЕ той, хто підняв слухавку ("алло").\n` +
      `Поверни JSON: reasoning (1-2 речення), manager (рівно один id: ${speakerIds.join(', ')}), confidence.`
    : `Ти аналізуєш транскрипт телефонної розмови автосервісу (СТО). Учасники: ${speakerIds.join(', ')}. ` +
      `Рівно один із них — працівник СТО (МЕНЕДЖЕР), решта — КЛІЄНТ.\n` +
      `Ознаки МЕНЕДЖЕРА: вітається від імені сервісу; питає марку/проблему авто; пропонує запис, ціни, майстра.\n` +
      `Ознаки КЛІЄНТА: описує СВОЮ проблему ("у мене стукає"), питає ціну, погоджується/відмовляється.\n` +
      `Аналізуй ВЕСЬ діалог — клієнт міг заговорити першим ("алло?").\n` +
      `Поверни JSON: reasoning (1-2 речення), manager (рівно один id: ${speakerIds.join(', ')}), confidence.`;

  try {
    const out = await withRetry(
      async () => {
        const res = await fetchOk('openai', 'визначення ролей мовців', 'https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: process.env.OPENAI_ANALYZE_MODEL || 'gpt-4o-mini',
            messages: [
              { role: 'system', content: system },
              { role: 'user', content: body },
            ],
            response_format: { type: 'json_schema', json_schema: ROLE_SCHEMA },
          }),
        });
        return parseModelJson(await res.json(), 'openai', 'визначення ролей мовців');
      },
      { attempts: 2, delayMs: 1000, label: 'OpenAI speaker role' }
    );

    if (!speakerIds.includes(out.manager)) return keyword ?? turns[0].speaker;
    if (!managerName && out.confidence === 'low' && keyword && keyword !== out.manager) {
      console.log(`[elevenlabs] low-confidence role (LLM=${out.manager}, keyword=${keyword}) → using keyword heuristic`);
      return keyword;
    }
    return out.manager;
  } catch (err) {
    console.error(`[elevenlabs] role labeling failed, using keyword heuristic: ${err.message}`);
    return keyword ?? turns[0].speaker;
  }
}

async function transcribeDiarized(audioBlob, managerName, { audioPath } = {}) {
  const channels = await probeChannels(audioPath || audioBlob);
  const multichannel = (channels ?? 1) >= 2;
  if (multichannel) console.log(`[elevenlabs] ${channels}-channel audio → multichannel STT (per-channel speakers)`);
  const data = await sttDiarize(audioBlob, { multichannel });
  const plain = (data.text || '').trim();
  const turns = buildTurns(data.words);
  if (turns.length === 0) return { transcript: plain || '(порожньо)', segments: null };

  const speakerIds = [...new Set(turns.map((t) => t.speaker))];
  if (speakerIds.length < 2) {
    return { transcript: plain || turns.map((t) => t.text).join(' '), segments: null };
  }

  const managerId = await pickManagerSpeaker(turns, speakerIds, managerName);
  const role = (sid) => (sid === managerId ? 'manager' : 'client');
  const label = (sid) => (sid === managerId ? 'Менеджер' : 'Клієнт');
  const transcript = turns.map((t) => `${label(t.speaker)}: ${t.text}`).join('\n\n');
  const segments = turns.map((t) => ({ role: role(t.speaker), text: t.text, start: t.start, end: t.end }));
  return { transcript, segments };
}

export {
  transcribeDiarized,
  sttDiarize,
  buildTurns,
  heuristicManager,
  getElevenLabsBalance,
  creditsToUsd,
  minBalanceUsd,
};
