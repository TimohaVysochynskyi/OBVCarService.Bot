import { InlineKeyboard } from 'grammy';
import { extractText as pdfExtractText, getDocumentProxy } from 'unpdf';
import mammoth from 'mammoth';
import { withRetry } from '../core/retry.js';
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
import { sendLong, withProgress, showScreen } from './ui.js';
import { sendDocExcerpt, downloadOriginal } from './kbClip.js';

const EMBED_MODEL = () => process.env.OPENAI_EMBED_MODEL || 'text-embedding-3-small';
const CHAT_MODEL = () => process.env.OPENAI_ANALYZE_MODEL || 'gpt-4o-mini';
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024; // Telegram bot getFile limit

// KB documents have an audience: which role a manual is FOR. mechanic / manager / both.
const AUDIENCE_LABEL = { mechanic: '🔧 Механікам', manager: '💼 Менеджерам', both: '👥 Обом' };

// Which doc audiences a role may read. Manager/mechanic are restricted to their own manuals (+ the
// "both" ones); director/marketer (admin) get null => no filter, they see everything.
function audiencesForRole(role) {
  if (role === ROLES.MANAGER) return ['manager', 'both'];
  if (role === ROLES.MECHANIC) return ['mechanic', 'both'];
  return null;
}

// --- Text extraction -----------------------------------------------------------------------

// Returns pages: [{ page, text }]. For PDF, page is the 1-based page number (so answers can cite
// exact pages); for DOCX/TXT there is no page concept, so a single { page: null, text } is returned.
async function extractPages(buffer, filename) {
  const ext = (filename.split('.').pop() || '').toLowerCase();
  if (ext === 'pdf') {
    const pdf = await getDocumentProxy(new Uint8Array(buffer));
    const { text } = await pdfExtractText(pdf, { mergePages: false }); // string[] — one per page
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
  throw new Error(`формат .${ext} не підтримується (лише PDF, DOCX, TXT)`);
}

// Merged plain text (backward-compatible helper, e.g. for the exported API / tests).
async function extractText(buffer, filename) {
  const pages = await extractPages(buffer, filename);
  return pages.map((p) => p.text).join('\n\n');
}

// --- Chunking ------------------------------------------------------------------------------
// Chunks are deliberately SMALL (~1300 chars, was 2400): a chunk is both the retrieval unit and
// the citation unit, so a big one drags in off-topic text AND spans several pages, which makes the
// page reference in an answer useless. PDF text also arrives as hard-wrapped lines with running
// heads, so raw page text needs cleaning before it can be split on meaning.

const CHUNK_MAX = 1300;
const CHUNK_OVERLAP = 200;

const rawLines = (text) =>
  String(text || '')
    .replace(/\r/g, '')
    .split('\n')
    .map((l) => l.trim());

// Running heads/feet ("Розділ 3. Двигуни", "В. Ф. Кисликов", a bare page number) repeat on nearly
// every page and pollute both the chunk text and its embedding. A line is boilerplate when it is
// short, sits at the TOP or BOTTOM of its page, and repeats on >=30% of pages (min 5). Frequency
// alone is not enough: body text can legitimately repeat across pages (a standard warning, a table
// row), and stripping that would silently delete content — position is what makes a running head.
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

// PDF extraction breaks a paragraph into one line per rendered row, often hyphenating across them
// ("двига-\nтель"). Join a line onto the previous one when the previous one looks mid-sentence
// (long and not ending in terminal punctuation); otherwise it's a heading/list item/new paragraph.
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

// A paragraph longer than the budget is split on sentence boundaries (never mid-word if avoidable).
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

// pages [{ page, text }] -> flat list of {text, page} units small enough to pack into chunks.
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

// Pack units into chunks, tracking the page range each chunk spans. A small trailing overlap is
// carried into the next chunk so a fact sitting on a boundary is retrievable from one of the two;
// only units that FIT inside the overlap budget are carried (carrying a big trailing unit would
// re-emit it as a near-duplicate chunk). Works for page-less input too (page stays null).
function chunkDocument(pages, { maxChars = CHUNK_MAX, overlap = CHUNK_OVERLAP } = {}) {
  const units = buildUnits(pages);
  const chunks = [];
  const seen = new Set();
  let cur = [];
  let len = 0;

  // Identical chunks are dropped: a paragraph repeated across the document (a disclaimer, a
  // repeated table) would otherwise burn embeddings and crowd out other results with copies of
  // itself. The first occurrence keeps the citation.
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

// --- OpenAI embeddings + chat --------------------------------------------------------------

// What actually gets embedded for a chunk: the document name (and page) prepended to the text.
// An isolated 1300-char excerpt is often ambiguous on its own ("Він складається з двох частин…");
// the title restores the topic, which measurably helps retrieval on multi-manual bases.
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
        const res = await fetch('https://api.openai.com/v1/embeddings', {
          method: 'POST',
          headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: EMBED_MODEL(), input: batch }),
        });
        if (!res.ok) throw new Error(`OpenAI embeddings failed: ${res.status} ${await res.text()}`);
        const data = await res.json();
        return data.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
      },
      { attempts: 3, delayMs: 1500, label: 'OpenAI embeddings' }
    );
    out.push(...embeddings);
  }
  return out;
}

const ANSWER_SYSTEM = `Ти — асистент, що відповідає на запитання працівників автосервісу.

Джерело правди — наведені фрагменти з внутрішніх посібників компанії. Правила:
- Відповідай ПЕРЕДУСІМ на основі наведених фрагментів.
- Якщо фрагменти покривають питання лише частково (або питання загальне, напр. будова/принцип роботи), можеш ДОПОВНИТИ відповідь достовірними загальновідомими знаннями — без вигадок і не суперечачи посібникам. У такому разі постав usedGeneralKnowledge=true.
- Відповідь-заперечення чи заборона (напр. "ми не працюємо з вантажними авто", "неділя — вихідний") — це ТЕЖ повноцінна відповідь, дай її.
- Якщо у фрагментах немає нічого дотичного І ти не можеш дати достовірну загальну відповідь — постав answer="У посібниках немає відповіді на це питання", usedSources=[], usedGeneralKnowledge=false.
- usedSources: номери [N] фрагментів, які РЕАЛЬНО використані у відповіді (лише справді потрібні; не перелічуй усі підряд).
- Відповідь — це ВИСНОВОК своїми словами, стисло й по суті. Не переписуй фрагменти дослівно й довго: система покаже користувачеві самі фрагменти й сторінки окремо, під відповіддю.
- Пиши ПРОСТИМ текстом (без markdown, без зірочок і решіток), тією ж мовою, що й запитання. НЕ додавай список джерел самостійно — його додасть система.`;

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

const htmlEscape = (s) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function chatJson(messages, schema, { label, attempts = 2, delayMs = 1000 } = {}) {
  return withRetry(
    async () => {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: CHAT_MODEL(),
          messages,
          response_format: { type: 'json_schema', json_schema: schema },
        }),
      });
      if (!res.ok) throw new Error(`${label} failed: ${res.status} ${await res.text()}`);
      const data = await res.json();
      return JSON.parse(data.choices[0].message.content);
    },
    { attempts, delayMs, label }
  );
}

// --- Retrieval: hybrid (vector + lexical) -> LLM rerank --------------------------------------
// Vector search alone has two known weaknesses here: the same question phrased differently used to
// miss, and exact technical terms (a part name, a spec) get smeared into the surrounding topic. So:
//   1. multi-query — the model rephrases the question, every variant is embedded and searched;
//   2. lexical FTS pass on the original wording, for the exact-term hits vectors lose;
//   3. Reciprocal Rank Fusion merges all result lists (rank-based, so incomparable scores — cosine
//      distance vs ts_rank — never have to be normalised against each other);
//   4. an LLM rerank pass scores the survivors and drops everything below a relevance floor, so
//      "close in topic, wrong in substance" chunks stop reaching the answering prompt.

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

// Words -> a 'simple'-config tsquery of PREFIX terms OR'ed together ("двигун:* | клапан:*").
// Postgres ships no Ukrainian stemmer, so prefix matching is what makes "двигуна"/"двигуном" hit
// the same lexeme. OR (not AND) keeps recall: ts_rank_cd still ranks multi-term matches higher.
function toPrefixTsQuery(text) {
  const words = (String(text).toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || []).map((w) => w.slice(0, 24));
  const uniq = [...new Set(words)].slice(0, 12);
  return uniq.length ? uniq.map((w) => `${w}:*`).join(' | ') : null;
}

const RETRIEVE_PER_QUERY = 8;
const LEXICAL_LIMIT = 12;
const RRF_K = 60; // standard Reciprocal Rank Fusion damping
const RERANK_CANDIDATES = 24;
const RERANK_KEEP = 8;
const RERANK_MIN_SCORE = 4; // of 10 — below this a chunk is "related topic, not an answer"

// Returns { candidates, degraded }. The two halves fail INDEPENDENTLY on purpose: OpenAI's
// embeddings endpoint went fully down on 2026-07-25 (500 on every embedding model while chat kept
// answering), which under a vector-only design takes the whole knowledge base down with it. The
// lexical half needs nothing but Postgres, so a question still gets answered — degraded, and the
// answer says so. Only losing BOTH is a real failure.
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
    throw new Error('пошук у базі знань недоступний (ні семантичний, ні текстовий) — спробуйте пізніше');
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

// Score candidates 0-10 for whether they actually ANSWER the question, keep the top ones above the
// floor. Returning [] is a valid, meaningful outcome: nothing in the manuals is relevant, and the
// answering step will say so instead of hallucinating around loosely-related text.
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

// --- Evidence block: the cited fragments themselves, not the whole file ----------------------
// The owner's requirement: a user must get the CUT-OUT parts where the answer lives, from every
// file involved — never the full 300-page manual. So the answer carries the quotes inline, plus a
// button per file that sends a mini-PDF of just those pages (kbClip.js).

const MAX_EVIDENCE = 4;
const QUOTE_CHARS = 700;
const MAX_EVIDENCE_DOCS = 3;

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

function pagesLabel(ranges) {
  const merged = mergeRanges(ranges);
  if (!merged.length) return '';
  return `стор. ${merged.map(([a, b]) => (a === b ? `${a}` : `${a}–${b}`)).join(', ')}`;
}

// Trim a quote to a readable length, preferring a sentence boundary over a hard cut.
function trimQuote(text, n = QUOTE_CHARS) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (t.length <= n) return t;
  const cut = t.slice(0, n);
  const at = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  return `${(at > n * 0.5 ? cut.slice(0, at + 1) : cut).trim()}…`;
}

// Group the used hits per document, preserving the order the answer relied on them.
function groupByDoc(hits) {
  const byDoc = new Map();
  for (const h of hits) {
    if (!byDoc.has(h.docId)) byDoc.set(h.docId, { docId: h.docId, filename: h.filename, ranges: [] });
    if (h.pageStart != null) byDoc.get(h.docId).ranges.push([h.pageStart, h.pageEnd ?? h.pageStart]);
  }
  return [...byDoc.values()].slice(0, MAX_EVIDENCE_DOCS);
}

// HTML (blockquote) so long fragments collapse in Telegram instead of burying the answer.
function evidenceBlock(hits) {
  const lines = ['📎 <b>Де це в посібниках:</b>'];
  hits.slice(0, MAX_EVIDENCE).forEach((h, i) => {
    const pg = h.pageStart != null ? ` — ${pagesLabel([[h.pageStart, h.pageEnd ?? h.pageStart]])}` : '';
    lines.push(
      `\n<b>${i + 1}. «${htmlEscape(h.filename)}»</b>${pg}\n<blockquote expandable>${htmlEscape(trimQuote(h.content))}</blockquote>`
    );
  });
  return lines.join('\n');
}

const shortName = (filename) => {
  const base = String(filename || '').replace(/\.(pdf|docx|txt|md)$/i, '');
  return base.length > 26 ? `${base.slice(0, 25)}…` : base;
};

// One row per source document: the page cut-out (mini-PDF) plus a small "whole file" escape hatch
// for when someone needs the wider chapter. Docs without pages (DOCX/TXT) only get the latter.
function evidenceKeyboard(hits) {
  const kb = new InlineKeyboard();
  let rows = 0;
  for (const d of groupByDoc(hits)) {
    const name = shortName(d.filename);
    const merged = mergeRanges(d.ranges).slice(0, 2);
    for (const [a, b] of merged) {
      kb.text(`📄 ${name} · ${a === b ? `стор. ${a}` : `стор. ${a}–${b}`}`, `kb:frag:${d.docId}:${a}:${b}`).row();
      rows += 1;
    }
    kb.text(merged.length ? `📚 весь файл: ${name}` : `📚 ${name} — весь файл`, `kb:full:${d.docId}`).row();
    rows += 1;
  }
  return rows ? kb : null;
}

async function answerStructured(question, hits) {
  const context = hits.length
    ? hits.map((h, i) => `[${i + 1}] Файл: ${h.filename}${pageNote(h)}\n${h.content}`).join('\n\n---\n\n')
    : '(релевантних фрагментів не знайдено)';
  return chatJson(
    [
      { role: 'system', content: ANSWER_SYSTEM },
      { role: 'user', content: `Питання: ${question}\n\nФрагменти посібників:\n\n${context}` },
    ],
    ANSWER_SCHEMA,
    { label: 'OpenAI KB answer', attempts: 3, delayMs: 2000 }
  );
}

// question -> { text, keyboard }: the answer, the fragments it rests on, and buttons that send the
// cut-out pages of each source. role limits which docs are searched (a mechanic never gets a
// manager's manual and vice versa; admins search everything).
async function answerQuestion(question, role) {
  const { candidates, degraded } = await retrieve(question, audiencesForRole(role));
  const hits = await rerankChunks(question, candidates);
  const { answer, usedSources, usedGeneralKnowledge } = await answerStructured(question, hits);

  const used = (usedSources || []).map((i) => hits[i - 1]).filter(Boolean);
  let text = htmlEscape(answer);
  if (used.length) text += `\n\n${evidenceBlock(used)}`;
  if (usedGeneralKnowledge) {
    text += used.length
      ? '\n\nℹ️ Частину відповіді доповнено із загальних знань (не з посібників).'
      : '\n\nℹ️ Відповідь ґрунтується на загальних знаннях — прямої відповіді в посібниках не знайдено.';
  }
  if (degraded) {
    text += '\n\n⚠️ Семантичний пошук тимчасово недоступний — шукав лише за словами з питання, тож міг знайти не все. Спробуйте переформулювати або повторити пізніше.';
  }
  return { text, keyboard: used.length ? evidenceKeyboard(used) : null };
}

// --- Upload ingestion ----------------------------------------------------------------------

// Core ingestion from page-structured text: chunk (with page ranges) -> embed -> store.
// fileId/mime let us later resend the original document or cut pages out of it.
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

// Backward-compatible plain-text entry point (no page info — e.g. tests / a future importer).
async function ingestText(filename, text, uploadedBy, fileId, mime, audience = 'mechanic') {
  return ingestPages(filename, [{ page: null, text }], uploadedBy, fileId, mime, audience);
}

// Step 1 of upload: capture the document and ask WHO it's for. The actual ingestion is deferred
// until the audience is chosen (kb:aud:*), so we stash the file reference in the session.
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

// Step 2 of upload: run the ingestion for the stashed document with the chosen audience.
async function ingestPendingDoc(ctx, pending, audience) {
  const { fileId, name, mime } = pending;
  await ctx.reply(`⏳ Обробляю «${name}» (${AUDIENCE_LABEL[audience]})… Для великих файлів це може зайняти до хвилини.`);
  try {
    // Download + text extraction + chunking + embeddings can take ~30s; keep a "typing"
    // indicator alive for the whole time so the chat doesn't look frozen.
    const result = await withProgress(ctx.api, ctx.chat.id, 'typing', async () => {
      const buffer = await downloadOriginal(fileId);
      const pages = await extractPages(buffer, name);
      const textLength = pages.reduce((n, p) => n + (p.text ? p.text.length : 0), 0);
      if (!textLength || !pages.some((p) => p.text && p.text.trim())) return null;
      const author = ctx.from.username ? `@${ctx.from.username}` : String(ctx.from.id);
      const { chunkCount } = await ingestPages(name, pages, author, fileId, mime, audience);
      return { chunkCount, textLength };
    });
    if (!result) {
      await ctx.reply(`⚠️ З "${name}" не вдалося витягти текст. Якщо це сканований PDF/зображення — потрібне розпізнавання (OCR), скажіть.`);
      return;
    }
    await ctx.reply(`✅ Додано «${name}» для ${AUDIENCE_LABEL[audience]} — ${result.chunkCount} фрагм. (~${result.textLength} симв.). Тепер можна ставити питання.`);
  } catch (err) {
    console.error(`[kb] ingest "${name}" failed: ${err.message}`);
    await ctx.reply(`❌ Не вдалося обробити "${name}": ${err.message}`);
  }
}

// --- Menus / handlers ----------------------------------------------------------------------

// All KB screens render as PLAIN text (no parse_mode): filenames routinely contain characters
// that break Telegram Markdown (e.g. "_"), which previously made the "Files" screen silently
// fail to render. Filenames are shown in «guillemets» instead of markdown.

async function filesListContent() {
  const docs = await listKbDocs();
  const kb = new InlineKeyboard();
  for (const d of docs) kb.text(`📄 ${d.filename.slice(0, 40)}`, `kb:doc:${d.id}`).row();
  kb.text('➕ Завантажити новий', 'kb:add').row();
  kb.text('« Меню', 'menu');
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

// Inline keyboard for choosing/changing a doc's audience. cbPrefix builds the callback per option.
function audienceKeyboard(cbPrefix, back) {
  const kb = new InlineKeyboard()
    .text(AUDIENCE_LABEL.mechanic, `${cbPrefix}mechanic`)
    .text(AUDIENCE_LABEL.manager, `${cbPrefix}manager`)
    .row()
    .text(AUDIENCE_LABEL.both, `${cbPrefix}both`);
  if (back) kb.row().text('« Назад', back);
  return kb;
}

// KB screens render as plain text (filenames contain _ etc. that break Markdown). showScreen
// keeps the active screen at the bottom / in focus (edit-in-place when newest, else resend).
async function showPlain(ctx, text, kb) {
  await showScreen(ctx, text, kb, { parseMode: null });
}

// Prompt the user to type a question (shared by the button, command and quick keyboard).
async function promptQuestion(ctx, kbState) {
  if (!kbState.ready) {
    await ctx.reply('База знань тимчасово недоступна.');
    return;
  }
  if ((await countKbChunks()) === 0) {
    await ctx.reply('База знань порожня. Надішліть файл(и) посібника боту (PDF/DOCX/TXT), і я їх проіндексую.');
    return;
  }
  ctx.session.awaiting = { type: 'kb_question' };
  await ctx.reply('📚 База знань. Напишіть ваше питання одним повідомленням.');
}

// Open the files list as a NEW message (used by the /files command so the native Menu button
// matches the inline menu; the kb:menu callback edits the current message instead).
async function openFiles(ctx, kbState) {
  if (!kbState.ready) {
    await ctx.reply('База знань тимчасово недоступна (немає pgvector).');
    return;
  }
  const { text, kb } = await filesListContent();
  await showPlain(ctx, text, kb);
}

// A doc the caller's role is allowed to read, or null (with the reason already sent to the chat).
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

// Resend the original file. Used by the "whole file" button under an answer and by the legacy
// deep-link (t.me/bot?start=kbdoc_<id>) still present in older chat messages.
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
    await ctx.reply('📎 Надішліть документ (PDF, DOCX або TXT) — я витягну текст і додам у базу знань. Можна кілька файлів поспіль.');
  });

  // Cut-out pages of a source, from under an answer. Available to EVERY role (see access.js:
  // kb:frag / kb:full are gated as kb_ask, not as file management) — audience is checked per doc.
  bot.callbackQuery(/^kb:frag:(\d+):(\d+):(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery({ text: 'Готую сторінки…' });
    const [, idStr, a, b] = ctx.match;
    const d = await docForRole(ctx, Number(idStr), ctx.role);
    if (!d) return;
    const replyToMessageId = ctx.callbackQuery.message?.message_id;
    if (!/pdf/i.test(d.mime || '') && !/\.pdf$/i.test(d.filename)) {
      await openKbDocById(ctx, d.id, ctx.role, { replyToMessageId });
      return;
    }
    try {
      const sent = await withProgress(ctx.api, ctx.chat.id, 'upload_document', () =>
        sendDocExcerpt(ctx.api, ctx.chat.id, d, Number(a), Number(b), { replyToMessageId })
      );
      if (!sent) await ctx.reply('Не вдалося вирізати ці сторінки — надсилаю файл повністю кнопкою «весь файл».');
    } catch (err) {
      console.error(`[kb] excerpt ${d.id} ${a}-${b} failed: ${err.message}`);
      await ctx.reply(`Не вдалося вирізати сторінки: ${err.message}`);
    }
  });

  bot.callbackQuery(/^kb:full:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery({ text: 'Надсилаю файл…' });
    await withProgress(ctx.api, ctx.chat.id, 'upload_document', () =>
      openKbDocById(ctx, Number(ctx.match[1]), ctx.role, { replyToMessageId: ctx.callbackQuery.message?.message_id })
    );
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

  // Audience chosen for a just-uploaded file → run the deferred ingestion.
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

  // Change an existing file's audience: show the picker, then apply and return to the file detail.
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
  trimQuote,
  pagesLabel,
};
