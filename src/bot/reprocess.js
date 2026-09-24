import {
  countCallsWithText,
  getCallsForReprocess,
  getCallHeadsForReprocess,
  updateCallMap,
  updateCallClassification,
  setCallPurpose,
  setCallBlocker,
  setClientDeclineReason,
  updateManagerName,
  getOperatorRoster,
  clearAllReportSegments,
} from '../core/store.js';
import { analyzeCallBehaviors, ANALYSIS_VERSION } from '../core/analyzeCall.js';
import { classifyCall } from '../core/classifyCall.js';
import { detectDealBlocker, NO_BLOCKER } from '../core/dealBlocker.js';
import { classifyClientDecline } from '../core/clientDecline.js';
import { classifyNonSalesPurpose } from '../core/classifyPersonal.js';
import { identifyManager } from '../core/identifyManager.js';
import { isSales, NON_SALES_PURPOSES } from '../core/callPurpose.js';
import { SHARED_EXTENSIONS, PERSONAL_OPERATORS } from '../core/phoneLines.js';
import { JOBS } from '../core/prompts.js';

// Re-running a stored analysis after the owner edited the prompt behind it.
//
// ⚠️ BLOCKS ARE CUT OVER *ALL* CALLS, newest first, and every job walks that same ordering. So
// "блок 2" is the same 200 conversations whatever is being re-run — otherwise the owner would pick
// block 2 for one prompt and get a different stretch of history than block 2 for another.
// A job then SKIPS the calls it does not apply to (a score re-run ignores non-deals) and says how
// many it skipped, so the numbers on screen always add up.
//
// Only ONE job runs at a time, process-wide. They share one OpenAI rate limit and one budget, and
// nothing good comes of the owner starting five at once from five taps.

const BLOCK = 200;
const PAGE = 50; // how many calls are held in memory at once

// gpt-4o shares a 30k tokens/min account limit with the reports, so its job is paced far slower —
// the blockers backfill measured 429s within seconds at a shorter pause.
const PAUSE_MS = { blocker: 2600 };
const DEFAULT_PAUSE_MS = 400;

const nameFor = (call) => PERSONAL_OPERATORS[String(call.internalNumber)] || call.managerName;

// Which calls a job is about, and what re-running it does to one call.
const RUNNERS = {
  map: {
    applies: () => true,
    async run(call) {
      const res = await analyzeCallBehaviors(call.transcript, call.segments, nameFor(call));
      await updateCallMap(call.generalCallId, {
        behaviors: res,
        analysisVersion: ANALYSIS_VERSION,
        callPurpose: res.callPurpose,
        introName: res.intro?.name ?? null,
        introCompany: res.intro?.company ?? null,
      });
    },
  },

  score: {
    // Effectiveness is only ever scored on deals — that gate is the whole point of the category.
    applies: (call) => isSales(call.callPurpose),
    async run(call) {
      const res = await classifyCall(call.transcript, call.segments);
      await updateCallClassification(call.generalCallId, res);
    },
  },

  blocker: {
    // A closed deal cannot have been blocked by the service, so those are never asked about.
    applies: (call) => call.isSuccess !== true,
    async run(call) {
      const res = await detectDealBlocker(call.transcript, call.segments, nameFor(call));
      // A failed reviewer is NOT "no blocker": leaving NULL keeps the row eligible for a later run,
      // instead of freezing a connection error in as a verified fact.
      if (res.unchecked) return;
      await setCallBlocker(call.generalCallId, res);
    },
  },

  decline: {
    // Only where the service COULD have taken the job — a blocked deal already has its reason.
    applies: (call) => call.isSuccess !== true && (call.dealBlocker == null || call.dealBlocker === NO_BLOCKER),
    async run(call) {
      const reason = await classifyClientDecline(call.transcript);
      if (reason) await setClientDeclineReason(call.generalCallId, reason);
    },
  },

  personal: {
    applies: (call) => NON_SALES_PURPOSES.includes(call.callPurpose),
    async run(call) {
      const purpose = await classifyNonSalesPurpose(call.transcript);
      // ⚠️ Can only move a row BETWEEN the three non-deal categories. It must never turn a call into
      // a deal: that would move conversion under a report the owner has already read.
      if (purpose && NON_SALES_PURPOSES.includes(purpose)) await setCallPurpose(call.generalCallId, purpose);
    },
  },

  identify: {
    applies: (call) => SHARED_EXTENSIONS.includes(String(call.internalNumber)),
    async run(call) {
      const roster = await getOperatorRoster();
      const name = await identifyManager(call.transcript, roster);
      if (name) await updateManagerName(call.generalCallId, name);
    },
  },
};

// --- scope -------------------------------------------------------------------------------------

async function blockCount() {
  return Math.ceil((await countCallsWithText()) / BLOCK);
}

const scopeWindow = (scope, total) =>
  scope.kind === 'block'
    ? { offset: (scope.block - 1) * BLOCK, limit: Math.min(BLOCK, Math.max(0, total - (scope.block - 1) * BLOCK)) }
    : { offset: 0, limit: total };

// What a run would cost and touch, WITHOUT spending anything: reads only the few columns needed to
// decide whether each call is in scope.
async function estimate(job, scope) {
  const runner = RUNNERS[job];
  const meta = JOBS[job];
  const total = await countCallsWithText();
  const { offset, limit } = scopeWindow(scope, total);

  let applicable = 0;
  for (let seen = 0; seen < limit; seen += 500) {
    const heads = await getCallHeadsForReprocess({ limit: Math.min(500, limit - seen), offset: offset + seen });
    if (!heads.length) break;
    applicable += heads.filter((c) => runner.applies(c)).length;
  }

  const pause = PAUSE_MS[job] ?? DEFAULT_PAUSE_MS;
  return {
    inScope: limit,
    applicable,
    usd: applicable * meta.usdPerCall,
    minutes: Math.ceil((applicable * (pause + 1200)) / 60000),
    model: meta.model,
  };
}

// --- the run -----------------------------------------------------------------------------------

let current = null;

const isRunning = () => Boolean(current);
const stop = () => {
  if (current) current.stopped = true;
};

/**
 * Walks the scope, re-runs `job` on every call it applies to, and reports progress.
 * Never throws for a single bad call — one unusable transcript must not abandon the other 199.
 */
async function run({ job, scope, onProgress }) {
  if (current) throw new Error('Один перерахунок уже виконується');
  const runner = RUNNERS[job];
  if (!runner) throw new Error(`Невідомий перерахунок: ${job}`);

  const total = await countCallsWithText();
  const { offset, limit } = scopeWindow(scope, total);
  const pause = PAUSE_MS[job] ?? DEFAULT_PAUSE_MS;

  const state = { job, scope, done: 0, skipped: 0, failed: 0, applicable: 0, stopped: false, startedAt: Date.now() };
  current = state;

  try {
    for (let seen = 0; seen < limit && !state.stopped; seen += PAGE) {
      const calls = await getCallsForReprocess({ limit: Math.min(PAGE, limit - seen), offset: offset + seen });
      if (!calls.length) break;

      for (const call of calls) {
        if (state.stopped) break;
        if (!runner.applies(call)) {
          state.skipped += 1;
          continue;
        }
        state.applicable += 1;
        try {
          await runner.run(call);
          state.done += 1;
        } catch (err) {
          state.failed += 1;
          console.error(`[reprocess:${job}] ${call.generalCallId}: ${err.message}`);
        }
        if (onProgress) await onProgress({ ...state, total: limit });
        if (pause) await new Promise((r) => setTimeout(r, pause));
      }
    }
    return { ...state, total: limit };
  } finally {
    current = null;
  }
}

// Stored report findings are built FROM the per-call analysis, so once that analysis changed they
// describe data that no longer exists. Clearing is separate from rebuilding on purpose: the owner
// is asked about the (paid) rebuild afterwards rather than having it happen silently.
async function invalidateReportCache() {
  await clearAllReportSegments();
}

export { run, estimate, stop, isRunning, blockCount, BLOCK, RUNNERS, invalidateReportCache };
