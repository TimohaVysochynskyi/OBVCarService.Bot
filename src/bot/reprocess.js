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


const BLOCK = 200;
const PAGE = 50;

const PAUSE_MS = { blocker: 2600 };
const DEFAULT_PAUSE_MS = 400;

const nameFor = (call) => PERSONAL_OPERATORS[String(call.internalNumber)] || call.managerName;

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
    applies: (call) => isSales(call.callPurpose),
    async run(call) {
      const res = await classifyCall(call.transcript, call.segments);
      await updateCallClassification(call.generalCallId, res);
    },
  },

  blocker: {
    applies: (call) => call.isSuccess !== true,
    async run(call) {
      const res = await detectDealBlocker(call.transcript, call.segments, nameFor(call));
      if (res.unchecked) return;
      await setCallBlocker(call.generalCallId, res);
    },
  },

  decline: {
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


async function blockCount() {
  return Math.ceil((await countCallsWithText()) / BLOCK);
}

const scopeWindow = (scope, total) =>
  scope.kind === 'block'
    ? { offset: (scope.block - 1) * BLOCK, limit: Math.min(BLOCK, Math.max(0, total - (scope.block - 1) * BLOCK)) }
    : { offset: 0, limit: total };

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


let current = null;

const isRunning = () => Boolean(current);
const stop = () => {
  if (current) current.stopped = true;
};

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

async function invalidateReportCache() {
  await clearAllReportSegments();
}

export { run, estimate, stop, isRunning, blockCount, BLOCK, RUNNERS, invalidateReportCache };
