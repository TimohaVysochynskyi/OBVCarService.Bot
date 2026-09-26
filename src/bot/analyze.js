import { withRetry } from '../core/retry.js';
import { definePrompt } from '../core/prompts.js';
import { parseModelJson } from '../core/errors.js';
import { fetchOk } from '../core/http.js';
import { findQuote, normalize } from '../core/quoteMatch.js';
import { SALES_STAGES } from '../core/stages.js';
import { dialogueMetrics } from '../core/dialogueMetrics.js';
import { NON_SALES_PURPOSES } from '../core/callPurpose.js';


const MIN_EVIDENCE = 2;
const MAX_PHRASES = 5;
const reduceModel = () => process.env.OPENAI_REPORT_MODEL || 'gpt-4o';

const getAnalyzePrompt = definePrompt({
  key: 'reportGuidance',
  storeKey: 'analyze_prompt',
  group: 'report',
  button: '🧠 Тон і формулювання висновків',
  title: '🧠 *Тон і формулювання висновків*',
  about:
    'Яким тоном AI пише висновки у звіті: саме твердження, чому це шкодить записам, що робити. ' +
    '⚠️ Правило «мінімум 2 підтверджені приклади» і заборона вигаданих цитат тримає код.',
});

const mergePrompt = definePrompt({
  key: 'reportMerge',
  group: 'report',
  button: '🧩 Зведення висновків за період',
  title: '🧩 *Зведення висновків за період*',
  about:
    'Як AI зливає денні висновки в один список за весь період. ' +
    'Підстановки: {МЕНЕДЖЕР} — імʼя, {МАКСИМУМ} — скільки пунктів лишати. ' +
    '⚠️ Дублікати доказів прибирає код незалежно від цього тексту.',
});

const verifyPrompt = definePrompt({
  key: 'reportVerify',
  group: 'report',
  button: '🔎 Рецензент доказів',
  title: '🔎 *Рецензент доказів*',
  about:
    'Суворий прохід, що відкидає цитати, які насправді не доводять твердження. ' +
    '⚠️ Послабите його — у звіт почнуть проходити притягнуті приклади.',
});

const FINDINGS_SCHEMA = {
  name: 'evidence_findings',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      findings: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['strength', 'error'] },
            claim: { type: 'string' },
            why_hurts_booking: { type: 'string' },
            action: { type: 'string' },
            evidence_ids: { type: 'array', items: { type: 'string' } },
          },
          required: ['type', 'claim', 'why_hurts_booking', 'action', 'evidence_ids'],
          additionalProperties: false,
        },
      },
      recommended_phrases: { type: 'array', items: { type: 'string' } },
    },
    required: ['findings', 'recommended_phrases'],
    additionalProperties: false,
  },
};

const RELEVANCE_SCHEMA = {
  name: 'evidence_relevance',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      findings: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            index: { type: 'integer' },
            supporting: { type: 'array', items: { type: 'integer' } },
          },
          required: ['index', 'supporting'],
          additionalProperties: false,
        },
      },
    },
    required: ['findings'],
    additionalProperties: false,
  },
};

function dialogueCandidates(call) {
  const segs = Array.isArray(call.segments) ? call.segments : null;
  if (!segs?.length) return [];
  const { interruptions, longPauses, thresholdSec } = dialogueMetrics(segs);
  const out = [];
  for (const it of interruptions) {
    if (!it.quote) continue;
    out.push({
      type: 'error',
      stage: SALES_STAGES[0],
      label: 'перебив клієнта на півслові',
      quote: it.quote,
      start: it.start,
      end: it.end,
      segIndex: it.segIndex,
      note: `клієнт не договорив: «${it.clientText}»`,
    });
  }
  for (const p of longPauses) {
    if (!p.quote) continue;
    out.push({
      type: 'error',
      stage: SALES_STAGES[0],
      label: `пауза ${p.pauseSec}с перед відповіддю (поріг ${thresholdSec}с)`,
      quote: p.quote,
      start: p.start,
      end: p.end,
      segIndex: p.segIndex,
      note:
        `клієнт сказав: «${p.clientText}», менеджер відповів лише через ${p.pauseSec}с` +
        (p.prevManagerText ? `; попередня репліка менеджера: «${p.prevManagerText}»` : ''),
    });
  }
  return out;
}

function buildCandidates(calls) {
  const candidates = [];
  const byId = new Map();
  calls.forEach((c) => {
    if (NON_SALES_PURPOSES.includes(c.callPurpose)) return;
    const items = [...(c.behaviors?.items || []), ...dialogueCandidates(c)];
    items.forEach((it) => {
      if (!it?.quote) return;
      const id = `e${candidates.length}`;
      const cand = {
        id,
        callId: c.generalCallId,
        startTime: c.startTime,
        segments: c.segments || null,
        type: it.type === 'strength' ? 'strength' : 'error',
        stage: it.stage || SALES_STAGES[0],
        label: it.label || '',
        quote: it.quote,
        start: it.start ?? null,
        end: it.end ?? null,
        segIndex: it.segIndex ?? null,
        note: it.note || null,
      };
      candidates.push(cand);
      byId.set(id, cand);
    });
  });
  return { candidates, byId };
}

function renderCandidate(c) {
  return `[${c.id}] (${c.type}/${c.stage}) ${c.label} | "${c.quote}"${c.note ? ` | ${c.note}` : ''}`;
}

function verifyCandidate(c) {
  const note = c.note || null;
  if (Array.isArray(c.segments) && c.segments.length) {
    const hit = findQuote(c.segments, c.quote, { requireRole: 'manager' });
    if (!hit) return null;
    return { callId: c.callId, startTime: c.startTime, quote: c.quote, start: hit.start, end: hit.end, note };
  }
  if (String(c.quote).trim().length < 3) return null;
  return { callId: c.callId, startTime: c.startTime, quote: c.quote, start: null, end: null, note };
}

function assembleFindings(rawFindings, calls) {
  const { byId } = buildCandidates(calls);
  const usedIds = new Set();
  const usedQuotes = new Set();
  const findings = [];
  for (const f of rawFindings || []) {
    const type = f.type === 'strength' ? 'strength' : 'error';
    const evidence = [];
    for (const id of f.evidence_ids || []) {
      if (usedIds.has(id)) continue;
      const cand = byId.get(id);
      if (!cand || cand.type !== type) continue;
      const quoteKey = `${cand.callId}|${normalize(cand.quote)}`;
      if (usedQuotes.has(quoteKey)) continue;
      const ev = verifyCandidate(cand);
      if (!ev) continue;
      usedIds.add(id);
      usedQuotes.add(quoteKey);
      evidence.push(ev);
    }
    if (evidence.length < MIN_EVIDENCE) continue;
    findings.push({
      type,
      claim: String(f.claim || '').trim(),
      why: String(f.why_hurts_booking || '').trim(),
      action: String(f.action || '').trim(),
      evidence,
    });
  }
  findings.sort((a, b) => (a.type === b.type ? 0 : a.type === 'error' ? -1 : 1));
  return findings;
}

const MAX_PERIOD_FINDINGS = 6;
const MAX_EVIDENCE_PER_FINDING = 6;

const MERGE_SCHEMA = {
  name: 'merged_findings',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      groups: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            member_indices: { type: 'array', items: { type: 'integer' } },
            type: { type: 'string', enum: ['strength', 'error'] },
            claim: { type: 'string' },
            why_hurts_booking: { type: 'string' },
            action: { type: 'string' },
          },
          required: ['member_indices', 'type', 'claim', 'why_hurts_booking', 'action'],
          additionalProperties: false,
        },
      },
    },
    required: ['groups'],
    additionalProperties: false,
  },
};

function applyMergeGroups(groups, findings) {
  const usedQuotes = new Set();
  const out = [];
  for (const g of groups || []) {
    const members = (g.member_indices || []).map((i) => findings[i]).filter(Boolean);
    if (!members.length) continue;
    const type = g.type === 'strength' ? 'strength' : 'error';
    const evidence = [];
    for (const m of members) {
      if (m.type !== type) continue;
      for (const ev of m.evidence || []) {
        const key = `${ev.callId}|${normalize(ev.quote)}`;
        if (usedQuotes.has(key)) continue;
        usedQuotes.add(key);
        evidence.push(ev);
        if (evidence.length >= MAX_EVIDENCE_PER_FINDING) break;
      }
      if (evidence.length >= MAX_EVIDENCE_PER_FINDING) break;
    }
    if (evidence.length < MIN_EVIDENCE) continue;
    out.push({
      type,
      claim: String(g.claim || members[0].claim || '').trim(),
      why: String(g.why_hurts_booking || members[0].why || '').trim(),
      action: String(g.action || members[0].action || '').trim(),
      evidence,
    });
  }
  out.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'error' ? -1 : 1;
    return b.evidence.length - a.evidence.length;
  });
  return out.slice(0, MAX_PERIOD_FINDINGS);
}

function fallbackMerge(findings) {
  const usedQuotes = new Set();
  const out = [];
  for (const f of [...findings].sort((a, b) => {
    if (a.type !== b.type) return a.type === 'error' ? -1 : 1;
    return (b.evidence?.length || 0) - (a.evidence?.length || 0);
  })) {
    const evidence = [];
    for (const ev of f.evidence || []) {
      const key = `${ev.callId}|${normalize(ev.quote)}`;
      if (usedQuotes.has(key)) continue;
      usedQuotes.add(key);
      evidence.push(ev);
    }
    if (evidence.length < MIN_EVIDENCE) continue;
    out.push({ ...f, evidence: evidence.slice(0, MAX_EVIDENCE_PER_FINDING) });
    if (out.length >= MAX_PERIOD_FINDINGS) break;
  }
  return out;
}

async function mergeFindings(managerName, findings) {
  if (!findings?.length) return [];
  if (findings.length === 1) return fallbackMerge(findings);

  const listing = findings
    .map((f, i) => `[${i}] (${f.type}) ${f.claim} | доказів: ${f.evidence?.length || 0}`)
    .join('\n');
  const system = (await mergePrompt())
    .replace('{МЕНЕДЖЕР}', managerName)
    .replace('{МАКСИМУМ}', String(MAX_PERIOD_FINDINGS));

  try {
    const raw = await withRetry(
      async () => {
        const res = await fetchOk('openai', 'зведення знахідок за період', 'https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: reduceModel(),
            messages: [
              { role: 'system', content: system },
              { role: 'user', content: listing },
            ],
            response_format: { type: 'json_schema', json_schema: MERGE_SCHEMA },
          }),
        });
        return parseModelJson(await res.json(), 'openai', 'зведення знахідок за період');
      },
      { attempts: 2, delayMs: 2000, label: `OpenAI merge ${managerName}` }
    );
    const merged = applyMergeGroups(raw.groups, findings);
    return merged.length ? merged : fallbackMerge(findings);
  } catch (err) {
    console.error(`[analyze] merge failed for ${managerName}, keeping per-day findings: ${err.message}`);
    return fallbackMerge(findings);
  }
}

async function verifyFindingsRelevance(findings) {
  if (!findings.length) return findings;

  const payload = findings.map((f, fi) => ({
    index: fi,
    type: f.type,
    claim: f.claim,
    evidence: f.evidence.map((e, ei) => (e.note ? { i: ei, quote: e.quote, measured: e.note } : { i: ei, quote: e.quote })),
  }));

  const system = await verifyPrompt();

  let out;
  try {
    out = await withRetry(
      async () => {
        const res = await fetchOk('openai', 'перевірка релевантності доказів', 'https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: reduceModel(),
            messages: [
              { role: 'system', content: system },
              { role: 'user', content: JSON.stringify(payload) },
            ],
            response_format: { type: 'json_schema', json_schema: RELEVANCE_SCHEMA },
          }),
        });
        return parseModelJson(await res.json(), 'openai', 'перевірка релевантності доказів');
      },
      { attempts: 2, delayMs: 1500, label: 'OpenAI relevance verify' }
    );
  } catch (err) {
    console.error(`[analyze] relevance verify failed, keeping assembled findings: ${err.message}`);
    return findings;
  }

  const supMap = new Map((out.findings || []).map((r) => [r.index, new Set(r.supporting || [])]));
  const kept = [];
  findings.forEach((f, fi) => {
    const sup = supMap.get(fi);
    if (!sup) return;
    const evidence = f.evidence.filter((_, ei) => sup.has(ei));
    if (evidence.length < MIN_EVIDENCE) return;
    kept.push({ ...f, evidence });
  });
  return kept;
}

async function runReducePass(managerName, candidates, stats) {
  const rate = stats.callCount ? Math.round((stats.successCount / stats.callCount) * 100) : 0;
  const metricsLine =
    `Менеджер: ${managerName}. Дзвінків: ${stats.callCount}, записів/успішних: ${stats.successCount} ` +
    `(конверсія ${rate}%), середній бал: ${stats.avgScore ?? '—'}, найчастіший слабкий етап: ${stats.topWeakStage ?? '—'}.`;

  const guidance = await getAnalyzePrompt();
  const system =
    `${guidance}\n\n` +
    `ФОРМАТ РОБОТИ (обовʼязково):\n` +
    `Тобі дано МЕТРИКИ за період і СПИСОК КАНДИДАТІВ — це вже витягнуті з реальних дзвінків поведінки менеджера з дослівними цитатами, кожна має id.\n` +
    `Згрупуй кандидатів у findings. У кожному finding поле evidence_ids — це id кандидатів (мінімум ${MIN_EVIDENCE}), що підтверджують саме це твердження. Усі докази в одному finding мають бути одного type, що й finding.\n` +
    `Використовуй ТІЛЬКИ id зі списку. НЕ вигадуй цитат і НЕ пиши цитати в тексті — цитати підставить система за id.\n` +
    `Не додавай finding, якщо для нього немає щонайменше ${MIN_EVIDENCE} доказів. Один id не використовуй у двох findings.\n\n` +
    `ОКРЕМО про КУЛЬТУРУ ДІАЛОГУ. Частина кандидатів — це не оцінки моделі, а ЗАМІРИ КОДУ з аудіо:\n` +
    `- «перебив клієнта на півслові» — клієнт не договорив (репліка обірвана), і менеджер почав говорити. Це реальний факт; якщо таких кандидатів кілька, зроби з них окремий finding про те, що менеджер не дослуховує клієнта.\n` +
    `- «пауза Nс перед відповіддю» — скільки клієнт чекав на відповідь. Це помилка ЛИШЕ тоді, коли пауза не виправдана. НЕ вважай помилкою й НЕ включай у finding, якщо з цитати видно, що менеджер попередив про перевірку («секунду», «хвилинку», «зараз уточню/подивлюсь») або якщо клієнт сам замовк/думав.\n` +
    `У claim таких findings пиши саме про поведінку (перебиває / довго не відповідає), а не про цифри.`;

  const user = `${metricsLine}\n\nКАНДИДАТИ:\n` + candidates.map(renderCandidate).join('\n');

  return withRetry(
    async () => {
      const res = await fetchOk('openai', 'аналіз дзвінків за період', 'https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: reduceModel(),
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          response_format: { type: 'json_schema', json_schema: FINDINGS_SCHEMA },
        }),
      });
      return parseModelJson(await res.json(), 'openai', 'аналіз дзвінків за період');
    },
    { attempts: 4, delayMs: 3000, label: `OpenAI reduce ${managerName}` }
  );
}

const evidenceKey = (e) => `${e.callId}|${normalize(e.quote)}`;

function corroborate(runs, passes) {
  const all = [];
  runs.forEach((findings, ri) =>
    findings.forEach((f) => all.push({ f, ri, keys: new Set(f.evidence.map(evidenceKey)) }))
  );
  const clusters = [];
  for (const item of all) {
    let placed = false;
    for (const c of clusters) {
      if (c.type !== item.f.type) continue;
      let shared = 0;
      for (const k of item.keys) if (c.keys.has(k)) shared += 1;
      if (shared >= 2) {
        c.members.push(item);
        item.keys.forEach((k) => c.keys.add(k));
        c.runs.add(item.ri);
        placed = true;
        break;
      }
    }
    if (!placed) clusters.push({ type: item.f.type, keys: new Set(item.keys), members: [item], runs: new Set([item.ri]) });
  }
  const majority = Math.floor(passes / 2) + 1;
  const kept = [];
  for (const c of clusters) {
    if (c.runs.size < majority) continue;
    const rep = c.members.reduce((a, b) => (b.f.evidence.length > a.f.evidence.length ? b : a)).f;
    const seen = new Set();
    const evidence = [];
    for (const m of c.members) {
      for (const e of m.f.evidence) {
        const k = evidenceKey(e);
        if (seen.has(k)) continue;
        seen.add(k);
        evidence.push(e);
      }
    }
    kept.push({ type: rep.type, claim: rep.claim, why: rep.why, action: rep.action, evidence });
  }
  kept.sort((a, b) => (a.type === b.type ? 0 : a.type === 'error' ? -1 : 1));
  return kept;
}

async function reduceFindingsConsistent(managerName, calls, stats, passes = 1) {
  const { candidates } = buildCandidates(calls);
  if (candidates.length < MIN_EVIDENCE) return { findings: [], phrases: [] };

  const n = Math.max(1, passes);
  const raws = [];
  for (let i = 0; i < n; i += 1) raws.push(await runReducePass(managerName, candidates, stats));

  const assembledRuns = raws.map((raw) => assembleFindings(raw.findings, calls));
  const corroborated = n > 1 ? corroborate(assembledRuns, n) : assembledRuns[0];
  const findings = await verifyFindingsRelevance(corroborated);

  const seen = new Set();
  const phrases = [];
  for (const raw of raws) {
    for (const p of raw.recommended_phrases || []) {
      const t = String(p).trim();
      if (!t || seen.has(t)) continue;
      seen.add(t);
      phrases.push(t);
      if (phrases.length >= MAX_PHRASES) break;
    }
    if (phrases.length >= MAX_PHRASES) break;
  }
  return { findings, phrases };
}

async function reduceFindings(managerName, calls, stats) {
  return reduceFindingsConsistent(managerName, calls, stats, 1);
}

export {
  mergeFindings,
  applyMergeGroups,
  MAX_PERIOD_FINDINGS,
  reduceFindings,
  reduceFindingsConsistent,
  assembleFindings,
  corroborate,
  MIN_EVIDENCE,
  MAX_PHRASES,
  getAnalyzePrompt,
};
