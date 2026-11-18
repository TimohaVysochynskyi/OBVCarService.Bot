import { withRetry } from '../../shared/retry.js';
import { classify } from '../../shared/errors.js';
import { chatJson } from '../openai/llm.js';
import { fetchOk, fetchRaw } from '../../shared/http.js';
import { probeChannels } from '../audio/meta.js';
import {
  MANAGER_ROLE,
  CLIENT_ROLE,
  keywordSpeaker,
  selfIntroSpeaker,
  speakerOfChannel,
  transcriptFromSegments,
} from '../../domain/call/roles.js';
import { config } from '../../shared/config.js';

const STT_URL = 'https://api.elevenlabs.io/v1/speech-to-text';
const SUBSCRIPTION_URL = 'https://api.elevenlabs.io/v1/user/subscription';
const sttModel = () => config.elevenlabs.sttModel;
const numSpeakers = () => config.elevenlabs.numSpeakers;

async function sttDiarize(audioBlob, { multichannel = false } = {}) {
  const key = config.elevenlabs.apiKey;
  if (!key) throw new Error('ELEVENLABS_API_KEY is not set');
  return withRetry(
    async () => {
      const form = new FormData();
      form.append('file', audioBlob, 'call.mp3');
      form.append('model_id', sttModel());
      if (multichannel) {
        form.append('use_multi_channel', 'true');
        form.append('diarize', 'false');
        form.append('multichannel_output_style', 'separate');
      } else {
        form.append('diarize', 'true');
        form.append('num_speakers', numSpeakers());
      }
      if (config.call.language) form.append('language_code', config.call.language);

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

function creditsToUsd(credits) {
  const amount = Number(credits);
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  return (amount / 1000) * config.elevenlabs.usdPer1000Credits;
}

function minBalanceUsd() {
  return config.elevenlabs.minBalanceUsd;
}

async function getElevenLabsBalance() {
  const key = config.elevenlabs.apiKey;
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

function speakerIdOf(word, multichannel, previous) {
  if (multichannel && word.channel_index != null) return `speaker_${word.channel_index}`;
  if (word.speaker_id != null) return word.speaker_id;
  if (word.channel_index != null) return `speaker_${word.channel_index}`;
  return previous ?? 'speaker_0';
}

function tidyTurns(turns) {
  return turns
    .map((x) => ({ speaker: x.speaker, text: x.text.replace(/\s+/g, ' ').trim(), start: x.start, end: x.end }))
    .filter((x) => x.text);
}

function buildTurns(words, multichannel = false) {
  const turns = [];
  let cur = null;
  for (const w of words || []) {
    const t = w.text ?? '';
    if (w.type === 'spacing') {
      if (cur) cur.text += t;
      continue;
    }
    const sid = speakerIdOf(w, multichannel, cur?.speaker);
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
  return tidyTurns(turns);
}

function buildChannelTurns(words, speaker, gapSec) {
  const turns = [];
  let cur = null;
  for (const w of words || []) {
    const t = w.text ?? '';
    if (w.type === 'spacing') {
      if (cur) cur.text += t;
      continue;
    }
    const start = w.start ?? null;
    const silence = cur && start != null && cur.end != null && start - cur.end > gapSec;
    if (!cur || silence) {
      if (cur) turns.push(cur);
      cur = { speaker, text: t, start, end: w.end ?? null };
    } else {
      cur.text += t;
      if (start != null && cur.start == null) cur.start = start;
      if (w.end != null) cur.end = w.end;
    }
  }
  if (cur) turns.push(cur);
  return tidyTurns(turns);
}

function sttModeOf(data, multichannel) {
  if (!multichannel) return 'diarize';
  return Array.isArray(data.transcripts) ? 'separate' : 'multichannel';
}

function turnsFromResponse(data, multichannel) {
  const perChannel = multichannel && Array.isArray(data.transcripts) ? data.transcripts : null;
  if (!perChannel) return buildTurns(data.words, multichannel);
  const gapSec = config.call.turnGapSec;
  return perChannel
    .map((t, index) => buildChannelTurns(t.words, `speaker_${t.channel_index ?? index}`, gapSec))
    .flat()
    .sort((a, b) => (a.start ?? 0) - (b.start ?? 0));
}

function plainText(data) {
  if (data.text) return String(data.text).trim();
  if (!Array.isArray(data.transcripts)) return '';
  return data.transcripts.map((t) => String(t.text || '').trim()).filter(Boolean).join('\n\n');
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

const DIRECTION_FACTS = {
  in: 'Це ВХІДНИЙ дзвінок: слухавку взяв НАШ працівник, тож першим зазвичай говорить саме він.',
  out:
    'Це ВИХІДНИЙ дзвінок: ми подзвонили, тож першим відповідає СПІВРОЗМОВНИК ("алло"), ' +
    'а наш працівник говорить другим. Те, що людина пояснює свою потребу, НЕ робить її нашим працівником.',
};

async function pickManagerSpeaker(turns, speakerIds, { managerName, direction } = {}) {
  const intro = selfIntroSpeaker(turns, managerName);
  if (intro) {
    console.log(`[elevenlabs] manager by self-introduction ("${managerName}") → ${intro}`);
    return intro;
  }

  const keyword = keywordSpeaker(turns, speakerIds);
  const directionFact = DIRECTION_FACTS[direction] ? `${DIRECTION_FACTS[direction]}\n` : '';

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
      `⚠️ ЗВЕРТАННЯ — це НЕ представлення: "Алло, ${managerName}", "Да, ${managerName}", "${managerName}, добрий день" говорить той, хто ЗВЕРТАЄТЬСЯ до «${managerName}», отже сам ним НЕ є.\n` +
      directionFact +
      `Якщо імені в розмові немає: наш працівник — той, хто поводиться як працівник СТО (вітає від сервісу, консультує клієнта, пропонує запис/ціни/майстра).\n` +
      `Поверни JSON: reasoning (1-2 речення), manager (рівно один id: ${speakerIds.join(', ')}), confidence.`
    : `Ти аналізуєш транскрипт телефонної розмови автосервісу (СТО). Учасники: ${speakerIds.join(', ')}. ` +
      `Рівно один із них — працівник СТО (МЕНЕДЖЕР), решта — КЛІЄНТ.\n` +
      `Ознаки МЕНЕДЖЕРА: вітається від імені сервісу; питає марку/проблему авто; пропонує запис, ціни, майстра.\n` +
      `Ознаки КЛІЄНТА: описує СВОЮ проблему ("у мене стукає"), питає ціну, погоджується/відмовляється.\n` +
      directionFact +
      `Аналізуй ВЕСЬ діалог — клієнт міг заговорити першим ("алло?").\n` +
      `Поверни JSON: reasoning (1-2 речення), manager (рівно один id: ${speakerIds.join(', ')}), confidence.`;

  try {
    const out = await chatJson({
      op: 'визначення ролей мовців',
      model: config.openai.analyzeModel,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: body },
      ],
      schema: ROLE_SCHEMA,
      attempts: 2,
      delayMs: 1000,
      label: 'OpenAI speaker role',
    });

    if (!speakerIds.includes(out.manager)) return keyword ?? turns[0].speaker;
    if (out.confidence === 'low' && keyword && keyword !== out.manager) {
      console.log(`[elevenlabs] low-confidence role (LLM=${out.manager}, keyword=${keyword}) → using keyword heuristic`);
      return keyword;
    }
    return out.manager;
  } catch (err) {
    console.error(`[elevenlabs] role labeling failed, using keyword heuristic: ${err.message}`);
    return keyword ?? turns[0].speaker;
  }
}

const OUTAGE_CODES = new Set([
  'ELV-NOKEY', 'ELV-QUOTA', 'ELV-AUTH', 'ELV-PERM', 'ELV-RATE', 'ELV-5XX', 'ELV-TIMEOUT', 'ELV-NET',
]);

function markOutage(err) {
  if (OUTAGE_CODES.has(classify(err))) err.elevenlabsUnavailable = true;
  return err;
}

async function transcribeDiarized(audioBlob, { managerName, audioPath, direction } = {}) {
  try {
    return await diarize(audioBlob, { managerName, audioPath, direction });
  } catch (err) {
    throw markOutage(err);
  }
}

async function resolveManagerSpeaker(turns, speakerIds, { multichannel, managerName, direction }) {
  if (multichannel) {
    const channel = config.call.managerChannel;
    const ours = speakerOfChannel(speakerIds, channel);
    if (ours) {
      console.log(`[elevenlabs] role from audio channel ${channel} → ${ours} (no model call)`);
      return ours;
    }
    console.warn(`[elevenlabs] audio channel ${channel} has no speaker here — falling back to transcript analysis`);
  }
  return pickManagerSpeaker(turns, speakerIds, { managerName, direction });
}

async function diarize(audioBlob, { managerName, audioPath, direction } = {}) {
  const channels = await probeChannels(audioPath || audioBlob);
  const multichannel = (channels ?? 1) >= 2;
  if (multichannel) console.log(`[elevenlabs] ${channels}-channel audio → multichannel STT (per-channel speakers)`);
  const data = await sttDiarize(audioBlob, { multichannel });
  const plain = plainText(data);
  const sttMode = sttModeOf(data, multichannel);
  const turns = turnsFromResponse(data, multichannel);
  if (turns.length === 0) return { transcript: plain || '(порожньо)', segments: null, sttMode };

  const speakerIds = [...new Set(turns.map((t) => t.speaker))];
  if (speakerIds.length < 2) {
    return { transcript: plain || turns.map((t) => t.text).join(' '), segments: null, sttMode };
  }

  const managerId = await resolveManagerSpeaker(turns, speakerIds, { multichannel, managerName, direction });
  const segments = turns.map((t) => ({
    role: t.speaker === managerId ? MANAGER_ROLE : CLIENT_ROLE,
    text: t.text,
    start: t.start,
    end: t.end,
  }));
  return { transcript: transcriptFromSegments(segments), segments, sttMode };
}

export {
  transcribeDiarized,
  getElevenLabsBalance,
  creditsToUsd,
  minBalanceUsd,
};
