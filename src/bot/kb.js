import { InlineKeyboard } from 'grammy';
import { fetchOk } from '../core/http.js';
import { extractText as pdfExtractText, getDocumentProxy } from 'unpdf';
import mammoth from 'mammoth';
import { withRetry } from '../core/retry.js';
import { appError, parseModelJson } from '../core/errors.js';
import { reportToUser } from './errorReply.js';
import {
  insertKbDoc,
  insertKbChunks,
  searchKbChunks,
  searchKbChunksLexical,
  listKbDocs,
  countKbChunks,
  getKbDoc,
  setKbDocAudience,
  deleteKbDoc,
} from '../core/store.js';
import { ROLES } from './access.js';
import { withProgress, showScreen } from './ui.js';
import { sendDocExcerpt, downloadOriginal } from './kbClip.js';
import { definePrompt } from '../core/prompts.js';

const EMBED_MODEL = () => process.env.OPENAI_EMBED_MODEL || 'text-embedding-3-small';
const CHAT_MODEL = () => process.env.OPENAI_ANALYZE_MODEL || 'gpt-4o-mini';
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

const AUDIENCE_LABEL = { mechanic: '🔧 Механікам', manager: '💼 Менеджерам', both: '👥 Обом' };

function audiencesForRole(role) {
  if (role === ROLES.MANAGER) return ['manager', 'both'];
  if (role === ROLES.MECHANIC) return ['mechanic', 'both'];
  return null;
}


async function extractPages(buffer, filename) {
  const ext = (filename.split('.').pop() || '').toLowerCase();
  if (ext === 'pdf') {
    const pdf = await getDocumentProxy(new Uint8Array(buffer));
    const { text } = await pdfExtractText(pdf, { mergePages: false });
    const arr = Array.isArray(text) ? text : [text];
    return arr.map((t, i) => ({ page: i + 1, text: t || '' }));
  }
  if (ext === 'docx') {
    const { value } = await mammoth.extractRawText({ buffer });
    return [{ page: null, text: value }];
  }
  if (ext === 'txt' || ext === 'text' || ext === 'md') {
    return [{ page: null, text: buffer.toString('utf8') }];
  }
  throw appError('FMT-UNSUP', { message: `формат .${ext} не підтримується` });
}

async function extractText(buffer, filename) {
  const pages = await extractPages(buffer, filename);
  return pages.map((p) => p.text).join('\n\n');
}


const CHUNK_MAX = 1300;
const CHUNK_OVERLAP = 200;

const rawLines = (text) =>
  String(text || '')
    .replace(/\r/g, '')
    .split('\n')
    .map((l) => l.trim());

const EDGE_LINES = 3;

function detectBoilerplate(pages) {
  const counts = new Map();
  for (const p of pages) {
    const lines = rawLines(p.text).filter(Boolean);
    const edges = [...lines.slice(0, EDGE_LINES), ...lines.slice(-EDGE_LINES)];
    for (const l of new Set(edges.filter((l) => l.length >= 3 && l.length <= 80))) {
      counts.set(l, (counts.get(l) || 0) + 1);
    }
  }
  const min = Math.max(5, Math.ceil(pages.length * 0.3));
  return new Set([...counts.entries()].filter(([, n]) => n >= min).map(([l]) => l));
}

const joinWrapped = (a, b) => (/\p{L}-$/u.test(a) ? a.slice(0, -1) + b : `${a} ${b}`);

function pageParagraphs(text, boilerplate) {
  const lines = rawLines(text).filter((l) => !boilerplate.has(l) && !/^\d{1,4}$/.test(l));
  const paras = [];
  let cur = '';
  for (const line of lines) {
    if (!line) {
      if (cur) paras.push(cur);
      cur = '';
      continue;
    }
    if (!cur) {
      cur = line;
      continue;
    }
    if (cur.length >= 40 && !/[.!?:;»"]$/.test(cur)) cur = joinWrapped(cur, line);
    else {
      paras.push(cur);
      cur = line;
    }
  }
  if (cur) paras.push(cur);
  return paras.map((p) => p.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

function splitSentences(text, maxChars) {
  if (text.length <= maxChars) return [text];
  const out = [];
  let cur = '';
  for (const s of text.split(/(?<=[.!?…])\s+/)) {
    if (cur && cur.length + s.length + 1 > maxChars) {
      out.push(cur);
      cur = s;
    } else {
      cur = cur ? `${cur} ${s}` : s;
    }
    while (cur.length > maxChars) {
      out.push(cur.slice(0, maxChars));
      cur = cur.slice(maxChars);
    }
  }
  if (cur) out.push(cur);
  return out;
}

function buildUnits(pages) {
  const boilerplate = detectBoilerplate(pages);
  const units = [];
  for (const { page, text } of pages) {
    for (const para of pageParagraphs(text, boilerplate)) {
      for (const piece of splitSentences(para, CHUNK_MAX)) units.push({ text: piece, page: page ?? null });
    }
  }
  return units;
}

function chunkDocument(pages, { maxChars = CHUNK_MAX, overlap = CHUNK_OVERLAP } = {}) {
  const units = buildUnits(pages);
  const chunks = [];
  const seen = new Set();
  let cur = [];
  let len = 0;

  const emit = () => {
    if (!cur.length) return;
    const content = cur.map((u) => u.text).join('\n\n');
    if (seen.has(content)) return;
    seen.add(content);
    const nums = cur.map((u) => u.page).filter((p) => p != null);
    chunks.push({
      content,
      pageStart: nums.length ? Math.min(...nums) : null,
      pageEnd: nums.length ? Math.max(...nums) : null,
    });
  };

  for (const u of units) {
    if (len && len + u.text.length + 2 > maxChars) {
      emit();
      const carry = [];
      let carried = 0;
      for (let i = cur.length - 1; i >= 0; i -= 1) {
        if (carried + cur[i].text.length > overlap) break;
        carry.unshift(cur[i]);
        carried += cur[i].text.length;
      }
      cur = carry;
      len = carry.reduce((n, x) => n + x.text.length + 2, 0);
    }
    cur.push(u);
    len += u.text.length + 2;
  }
  emit();
  return chunks;
}


function embedInput(filename, chunk) {
  const pg =
    chunk.pageStart != null
      ? ` (стор. ${chunk.pageStart}${chunk.pageEnd && chunk.pageEnd !== chunk.pageStart ? `–${chunk.pageEnd}` : ''})`
      : '';
  return `${filename}${pg}\n\n${chunk.content}`;
}

async function embedTexts(texts) {
  const out = [];
  for (let i = 0; i < texts.length; i += 96) {
    const batch = texts.slice(i, i + 96);
    const embeddings = await withRetry(
      async () => {
        const res = await fetchOk('openai', 'побудова векторів для пошуку', 'https://api.openai.com/v1/embeddings', {
          method: 'POST',
          headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: EMBED_MODEL(), input: batch }),
        });
        const data = await res.json();
        return data.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
      },
      { attempts: 3, delayMs: 1500, label: 'OpenAI embeddings' }
    );
    out.push(...embeddings);
  }
  return out;
}

const kbAnswerPrompt = definePrompt({
  key: 'kbAnswer',
  group: 'kb',
  button: '📚 Відповідь із посібників',
  title: '📚 *Відповідь із посібників*',
  about:
    'Як AI відповідає на питання механіків і менеджерів за завантаженими посібниками: ' +
    'наскільки стисло, чи можна додавати загальні знання. ' +
    '⚠️ Сам пошук по документах і вирізки сторінок працюють окремо й від цього тексту не залежать.',
});

const ANSWER_SCHEMA = {
  name: 'kb_answer',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      answer: { type: 'string' },
      usedSources: { type: 'array', items: { type: 'integer' } },
      usedGeneralKnowledge: { type: 'boolean' },
    },
    required: ['answer', 'usedSources', 'usedGeneralKnowledge'],
    additionalProperties: false,
  },
};

const QUERIES_SCHEMA = {
  name: 'kb_queries',
  strict: true,
  schema: {
    type: 'object',
    properties: { queries: { type: 'array', items: { type: 'string' } } },
    required: ['queries'],
    additionalProperties: false,
  },
};

const RERANK_SCHEMA = {
  name: 'kb_rerank',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      scores: {
        type: 'array',
        items: {
          type: 'object',
          properties: { id: { type: 'integer' }, score: { type: 'integer' } },
          required: ['id', 'score'],
          additionalProperties: false,
        },
      },
    },
    required: ['scores'],
    additionalProperties: false,
  },
};

async function chatJson(messages, schema, { label, attempts = 2, delayMs = 1000 } = {}) {
  return withRetry(
    async () => {
      const res = await fetchOk('openai', label, 'https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: CHAT_MODEL(),
          messages,
          response_format: { type: 'json_schema', json_schema: schema },
        }),
      });
      const data = await res.json();
      return parseModelJson(data, 'openai', label);
    },
    { attempts, delayMs, label }
  );
}


async function expandQueries(question) {
  try {
    const { queries } = await chatJson(
      [
        {
          role: 'system',
          content:
            'Переформулюй запит для пошуку у базі знань 3 різними способами (синоніми, ключові терміни, ширше і вужче формулювання). Тією ж мовою. Поверни JSON {"queries":[...]} лише з переформулюваннями (без пояснень).',
        },
        { role: 'user', content: question },
      ],
      QUERIES_SCHEMA,
      { label: 'OpenAI KB query expansion' }
    );
    return [question, ...(queries || [])].map((q) => (q || '').trim()).filter(Boolean);
  } catch (err) {
    console.error(`[kb] query expansion failed, using raw question: ${err.message}`);
    return [question];
  }
}

function toPrefixTsQuery(text) {
  const words = (String(text).toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || []).map((w) => w.slice(0, 24));
  const uniq = [...new Set(words)].slice(0, 12);
  return uniq.length ? uniq.map((w) => `${w}:*`).join(' | ') : null;
}

const RETRIEVE_PER_QUERY = 8;
const LEXICAL_LIMIT = 12;
const RRF_K = 60;
const RERANK_CANDIDATES = 24;
const RERANK_KEEP = 8;
const RERANK_MIN_SCORE = 4;

async function retrieve(question, audiences) {
  const lists = [];
  let vectorOk = false;
  let lexicalOk = false;

  try {
    const queries = await expandQueries(question);
    const embeddings = await embedTexts(queries);
    for (const emb of embeddings) lists.push(await searchKbChunks(emb, RETRIEVE_PER_QUERY, audiences));
    vectorOk = true;
  } catch (err) {
    console.error(`[kb] vector search unavailable, falling back to lexical: ${err.message}`);
  }

  const tsq = toPrefixTsQuery(question);
  if (tsq) {
    try {
      lists.push(await searchKbChunksLexical(tsq, LEXICAL_LIMIT, audiences));
      lexicalOk = true;
    } catch (err) {
      console.error(`[kb] lexical search failed: ${err.message}`);
    }
  }

  if (!vectorOk && !lexicalOk) {
    throw appError('KB-NOSEARCH');
  }

  const fused = new Map();
  for (const list of lists) {
    list.forEach((h, rank) => {
      const prev = fused.get(h.chunkId);
      const add = 1 / (RRF_K + rank + 1);
      if (prev) prev.rrf += add;
      else fused.set(h.chunkId, { ...h, rrf: add });
    });
  }
  return {
    candidates: [...fused.values()].sort((a, b) => b.rrf - a.rrf).slice(0, RERANK_CANDIDATES),
    degraded: !vectorOk,
  };
}

const pageNote = (h) =>
  h.pageStart != null ? ` (стор. ${h.pageStart}${h.pageEnd && h.pageEnd !== h.pageStart ? `–${h.pageEnd}` : ''})` : '';

async function rerankChunks(question, candidates) {
  if (candidates.length <= 3) return candidates;
  const listing = candidates
    .map((h, i) => `[${i + 1}] ${h.filename}${pageNote(h)}\n${h.content.slice(0, 1200)}`)
    .join('\n\n---\n\n');
  try {
    const { scores } = await chatJson(
      [
        {
          role: 'system',
          content:
            'Ти — суворий відбірник фрагментів для відповіді на питання. Для КОЖНОГО фрагмента постав оцінку 0-10: наскільки він СПРАВДІ містить відповідь (або її частину) на питання. 10 — прямо відповідає; 5 — дотичний, містить корисний контекст; 0-3 — та сама тема, але відповіді немає. Не завищуй оцінки. Поверни JSON {"scores":[{"id":N,"score":0-10}]} для всіх фрагментів.',
        },
        { role: 'user', content: `Питання: ${question}\n\nФрагменти:\n\n${listing}` },
      ],
      RERANK_SCHEMA,
      { label: 'OpenAI KB rerank' }
    );
    const byId = new Map((scores || []).map((s) => [s.id, s.score]));
    const kept = candidates
      .map((h, i) => ({ ...h, relevance: byId.get(i + 1) ?? 0 }))
      .filter((h) => h.relevance >= RERANK_MIN_SCORE)
      .sort((a, b) => b.relevance - a.relevance)
      .slice(0, RERANK_KEEP);
    if (!kept.length) console.log(`[kb] rerank dropped all ${candidates.length} candidates as irrelevant`);
    return kept;
  } catch (err) {
    console.error(`[kb] rerank failed, using fused order: ${err.message}`);
    return candidates.slice(0, RERANK_KEEP);
  }
}


const MAX_EVIDENCE_DOCS = 3;
const MAX_RANGES_PER_DOC = 2;

function mergeRanges(ranges) {
  const sorted = ranges.map(([a, b]) => [Math.min(a, b), Math.max(a, b)]).sort((x, y) => x[0] - y[0]);
  if (!sorted.length) return [];
  const merged = [sorted[0].slice()];
  for (const [a, b] of sorted.slice(1)) {
    const last = merged[merged.length - 1];
    if (a <= last[1] + 1) last[1] = Math.max(last[1], b);
    else merged.push([a, b]);
  }
  return merged;
}

function answerSources(hits) {
  const byDoc = new Map();
  for (const h of hits) {
    if (!byDoc.has(h.docId)) byDoc.set(h.docId, { docId: h.docId, filename: h.filename, ranges: [] });
    if (h.pageStart != null) byDoc.get(h.docId).ranges.push([h.pageStart, h.pageEnd ?? h.pageStart]);
  }
  return [...byDoc.values()].slice(0, MAX_EVIDENCE_DOCS).map((d) => ({
    docId: d.docId,
    filename: d.filename,
    ranges: mergeRanges(d.ranges).slice(0, MAX_RANGES_PER_DOC),
  }));
}

async function answerStructured(question, hits) {
  const context = hits.length
    ? hits.map((h, i) => `[${i + 1}] Файл: ${h.filename}${pageNote(h)}\n${h.content}`).join('\n\n---\n\n')
    : '(релевантних фрагментів не знайдено)';
  return chatJson(
    [
      { role: 'system', content: await kbAnswerPrompt() },
      { role: 'user', content: `Питання: ${question}\n\nФрагменти посібників:\n\n${context}` },
    ],
    ANSWER_SCHEMA,
    { label: 'OpenAI KB answer', attempts: 3, delayMs: 2000 }
  );
}

async function answerQuestion(question, role) {
  const { candidates, degraded } = await retrieve(question, audiencesForRole(role));
  const hits = await rerankChunks(question, candidates);
  const { answer, usedSources, usedGeneralKnowledge } = await answerStructured(question, hits);

  const used = (usedSources || []).map((i) => hits[i - 1]).filter(Boolean);
  let text = String(answer || '').trim();
  if (usedGeneralKnowledge) {
    text += used.length
      ? '\n\nℹ️ Частину відповіді доповнено із загальних знань (не з посібників).'
      : '\n\nℹ️ Відповідь ґрунтується на загальних знаннях — прямої відповіді в посібниках не знайдено.';
  }
  if (degraded) {
    text +=
      '\n\n⚠️ Семантичний пошук тимчасово недоступний — пошук виконано лише за словами з питання, тому результат може бути неповним. Можливо, варто переформулювати запит або повторити пізніше.';
  }
  return { text, sources: answerSources(used) };
}

async function sendAnswerSources(api, chatId, sources, { replyToMessageId } = {}) {
  let sent = 0;
  for (const s of sources) {
    let doc;
    try {
      doc = await getKbDoc(s.docId);
      if (!doc?.fileId) continue;
      const isPdf = /pdf/i.test(doc.mime || '') || /\.pdf$/i.test(doc.filename);
      if (!isPdf || !s.ranges.length) {
        await api.sendDocument(chatId, doc.fileId, {
          ...(replyToMessageId ? { reply_parameters: { message_id: replyToMessageId, allow_sending_without_reply: true } } : {}),
        });
        sent += 1;
        continue;
      }
      for (const [from, to] of s.ranges) {
        if (await sendDocExcerpt(api, chatId, doc, from, to, { replyToMessageId })) sent += 1;
      }
    } catch (err) {
      console.error(`[kb] sending excerpt of doc ${s.docId} failed: ${err.message}`);
    }
  }
  return sent;
}


async function ingestPages(filename, pages, uploadedBy, fileId, mime, audience = 'mechanic') {
  const chunks = chunkDocument(pages);
  if (chunks.length === 0) throw new Error('порожній текст');
  const embeddings = await embedTexts(chunks.map((c) => embedInput(filename, c)));
  const docId = await insertKbDoc(filename, uploadedBy, fileId, mime, audience);
  await insertKbChunks(
    docId,
    chunks.map((c, ord) => ({ ord, content: c.content, embedding: embeddings[ord], pageStart: c.pageStart, pageEnd: c.pageEnd }))
  );
  return { docId, chunkCount: chunks.length };
}

async function ingestText(filename, text, uploadedBy, fileId, mime, audience = 'mechanic') {
  return ingestPages(filename, [{ page: null, text }], uploadedBy, fileId, mime, audience);
}

async function askAudienceForUpload(ctx) {
  const doc = ctx.message.document;
  if (!doc) return;
  const name = doc.file_name || `file-${doc.file_unique_id}`;

  if (doc.file_size && doc.file_size > MAX_UPLOAD_BYTES) {
    await ctx.reply(`❌ "${name}" завеликий (${Math.round(doc.file_size / 1024 / 1024)} МБ). Ліміт Telegram для ботів — 20 МБ.`);
    return;
  }

  ctx.session.pendingKbDoc = { fileId: doc.file_id, name, mime: doc.mime_type };
  await ctx.reply(`📎 «${name}» — для кого цей файл у базі знань?`, { reply_markup: audienceKeyboard('kb:aud:') });
}

async function ingestPendingDoc(ctx, pending, audience) {
  const { fileId, name, mime } = pending;
  await ctx.reply(`⏳ Файл «${name}» (${AUDIENCE_LABEL[audience]}) обробляється… Для великих файлів це може зайняти до хвилини.`);
  try {
    const result = await withProgress(ctx.api, ctx.chat.id, 'typing', async () => {
      const buffer = await downloadOriginal(fileId);
      const pages = await extractPages(buffer, name);
      const textLength = pages.reduce((n, p) => n + (p.text ? p.text.length : 0), 0);
      if (!textLength || !pages.some((p) => p.text && p.text.trim())) return null;
      const author = ctx.from.username ? `@${ctx.from.username}` : String(ctx.from.id);
      const { chunkCount } = await ingestPages(name, pages, author, fileId, mime, audience);
      return { chunkCount, textLength };
    });
    if (!result) throw appError('PDF-SCANNED');
    await ctx.reply(`✅ Додано «${name}» для ${AUDIENCE_LABEL[audience]} — ${result.chunkCount} фрагм. (~${result.textLength} симв.). Тепер можна ставити питання.`);
  } catch (err) {
    await reportToUser(ctx, err, { action: 'kb_edit', subject: name });
  }
}



async function filesListContent() {
  const docs = await listKbDocs();
  const kb = new InlineKeyboard();
  for (const d of docs) kb.text(`📄 ${d.filename.slice(0, 40)}`, `kb:doc:${d.id}`).row();
  kb.text('➕ Завантажити новий', 'kb:add').row();
  kb.text('« Назад до меню', 'menu');
  const list = docs.length
    ? docs.map((d) => `• «${d.filename}» — ${d.chunkCount} фрагм. · ${AUDIENCE_LABEL[d.audience] || d.audience}`).join('\n')
    : 'поки порожньо.';
  const text = `📚 Файли посібників:\n${list}\n\nОбери файл (відкрити/змінити для кого/видалити) або завантаж новий.`;
  return { text, kb };
}

async function fileDetailContent(id) {
  const d = await getKbDoc(id);
  if (!d) return null;
  const kb = new InlineKeyboard()
    .text('📄 Відкрити файл', `kb:open:${id}`)
    .row()
    .text('🔁 Змінити для кого', `kb:audset:${id}`)
    .row()
    .text('🗑 Видалити', `kb:del:${id}`)
    .row()
    .text('« Файли', 'kb:menu');
  return { text: `📄 «${d.filename}»\nФрагментів: ${d.chunkCount}\nДля кого: ${AUDIENCE_LABEL[d.audience] || d.audience}`, kb };
}

function audienceKeyboard(cbPrefix, back) {
  const kb = new InlineKeyboard()
    .text(AUDIENCE_LABEL.mechanic, `${cbPrefix}mechanic`)
    .text(AUDIENCE_LABEL.manager, `${cbPrefix}manager`)
    .row()
    .text(AUDIENCE_LABEL.both, `${cbPrefix}both`);
  if (back) kb.row().text('« Назад', back);
  return kb;
}

async function showPlain(ctx, text, kb) {
  await showScreen(ctx, text, kb, { parseMode: null });
}

async function promptQuestion(ctx, kbState) {
  if (!kbState.ready) {
    await ctx.reply('База знань тимчасово недоступна.');
    return;
  }
  if ((await countKbChunks()) === 0) {
    await ctx.reply('База знань порожня. Надішліть файл(и) посібника боту (PDF/DOCX/TXT) — вони будуть проіндексовані.');
    return;
  }
  ctx.session.awaiting = { type: 'kb_question' };
  await ctx.reply('📚 База знань. Напишіть ваше питання одним повідомленням.');
}

async function openFiles(ctx, kbState) {
  if (!kbState.ready) {
    await ctx.reply('База знань тимчасово недоступна (немає pgvector).');
    return;
  }
  const { text, kb } = await filesListContent();
  await showPlain(ctx, text, kb);
}

async function docForRole(ctx, id, role) {
  const d = await getKbDoc(id);
  if (!d) {
    await ctx.reply('Файл не знайдено (можливо, вже видалений).');
    return null;
  }
  const allowed = audiencesForRole(role);
  if (allowed && !allowed.includes(d.audience)) {
    await ctx.reply('⛔ Цей файл недоступний для вашої ролі.');
    return null;
  }
  if (!d.fileId) {
    await ctx.reply('Оригінал недоступний (файл додано до оновлення). Перезавантажте його, щоб можна було відкривати.');
    return null;
  }
  return d;
}

async function openKbDocById(ctx, id, role, { replyToMessageId } = {}) {
  const d = await docForRole(ctx, id, role);
  if (!d) return;
  try {
    await ctx.replyWithDocument(d.fileId, {
      caption: d.filename,
      ...(replyToMessageId ? { reply_parameters: { message_id: replyToMessageId, allow_sending_without_reply: true } } : {}),
    });
  } catch (err) {
    console.error(`[kb] open ${d.id} failed: ${err.message}`);
    await ctx.reply(`Не вдалося надіслати файл: ${err.message}`);
  }
}

function registerKnowledgeBase(bot, kbState) {
  const guard = async (ctx) => {
    if (kbState.ready) return true;
    await ctx.reply('База знань тимчасово недоступна (немає pgvector).');
    return false;
  };

  bot.callbackQuery('kb:ask', async (ctx) => {
    await ctx.answerCallbackQuery();
    await promptQuestion(ctx, kbState);
  });

  bot.callbackQuery('kb:menu', async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!(await guard(ctx))) return;
    const { text, kb } = await filesListContent();
    await showPlain(ctx, text, kb);
  });

  bot.callbackQuery('kb:add', async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply('📎 Надішліть документ (PDF, DOCX або TXT) — текст буде витягнуто й додано до бази знань. Можна кілька файлів поспіль.');
  });

  bot.callbackQuery(/^kb:doc:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const content = await fileDetailContent(Number(ctx.match[1]));
    if (!content) {
      await ctx.reply('Файл не знайдено (можливо, вже видалений).');
      return;
    }
    await showPlain(ctx, content.text, content.kb);
  });

  bot.callbackQuery(/^kb:open:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await openKbDocById(ctx, Number(ctx.match[1]), ctx.role);
  });

  bot.callbackQuery(/^kb:del:(\d+)$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    const d = await getKbDoc(id);
    await ctx.answerCallbackQuery();
    if (!d) {
      await ctx.reply('Файл не знайдено.');
      return;
    }
    const kb = new InlineKeyboard()
      .text('✅ Так, видалити', `kb:delok:${id}`)
      .row()
      .text('« Ні, назад', `kb:doc:${id}`);
    await showPlain(ctx, `Видалити «${d.filename}» з бази знань? Це прибере всі його фрагменти.`, kb);
  });

  bot.callbackQuery(/^kb:delok:(\d+)$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    const d = await getKbDoc(id);
    await deleteKbDoc(id);
    await ctx.answerCallbackQuery({ text: 'Видалено' });
    const { text, kb } = await filesListContent();
    await showPlain(ctx, `🗑 Видалено «${d ? d.filename : id}».\n\n${text}`, kb);
  });

  bot.on('message:document', async (ctx) => {
    if (!(await guard(ctx))) return;
    await askAudienceForUpload(ctx);
  });

  bot.callbackQuery(/^kb:aud:(mechanic|manager|both)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const pending = ctx.session.pendingKbDoc;
    if (!pending) {
      await ctx.reply('Немає файлу для додавання — надішліть документ ще раз.');
      return;
    }
    ctx.session.pendingKbDoc = null;
    await ingestPendingDoc(ctx, pending, ctx.match[1]);
  });

  bot.callbackQuery(/^kb:audset:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const id = Number(ctx.match[1]);
    const d = await getKbDoc(id);
    if (!d) {
      await ctx.reply('Файл не знайдено.');
      return;
    }
    await showPlain(ctx, `«${d.filename}» — для кого цей файл?`, audienceKeyboard(`kb:audput:${id}:`, `kb:doc:${id}`));
  });

  bot.callbackQuery(/^kb:audput:(\d+):(mechanic|manager|both)$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    await setKbDocAudience(id, ctx.match[2]);
    await ctx.answerCallbackQuery({ text: 'Змінено' });
    const content = await fileDetailContent(id);
    if (content) await showPlain(ctx, content.text, content.kb);
  });
}

export {
  registerKnowledgeBase,
  answerQuestion,
  promptQuestion,
  openFiles,
  openKbDocById,
  ingestText,
  ingestPages,
  extractText,
  extractPages,
  chunkDocument,
  embedTexts,
  embedInput,
  toPrefixTsQuery,
  answerSources,
  sendAnswerSources,
};
