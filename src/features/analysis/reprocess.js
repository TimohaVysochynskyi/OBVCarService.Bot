import {
  cancelRunningJob,
  countCallsWithText,
  createJob,
  finishJob,
  getCallHeadsForReprocess,
  getCallsForReprocess,
  getRecentJobs,
  getRunningJob,
  saveJobProgress,
  setCallBlocker,
  setCallPurpose,
  setClientDeclineReason,
  updateCallClassification,
  updateCallMap,
} from './repo.js';
import { getOperatorRoster, updateManagerName } from '../operators/repo.js';
import { clearAllReportSegments } from '../reporting/repo.js';
import { analyzeCallBehaviors, ANALYSIS_VERSION } from './analyzeCall.js';
import { classifyCall } from './classifyCall.js';
import { detectDealBlocker, NO_BLOCKER } from './dealBlocker.js';
import { classifyClientDecline } from './clientDecline.js';
import { classifyNonSalesPurpose } from './classifyPersonal.js';
import { identifyManager } from './identifyManager.js';
import { isSales, NON_SALES_PURPOSES } from '../../domain/call/purpose.js';
import { SHARED_EXTENSIONS, PERSONAL_OPERATORS } from '../../domain/call/phoneLines.js';
import { JOBS } from '../prompts/registry.js';


const BLOCK = 200;
const PAGE = 50;

const PAUSE_MS = { blocker: 0 };
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


const PROGRESS_EVERY = 1;

let stopping = false;

const isRunning = async () => Boolean(await getRunningJob());

async function stop() {
  stopping = true;
  return cancelRunningJob();
}

async function startRun({ job, scope, chatId, messageId }) {
  const runner = RUNNERS[job];
  if (!runner) throw new Error(`Невідомий перерахунок: ${job}`);
  const total = await countCallsWithText();
  const { offset, limit } = scopeWindow(scope, total);
  try {
    return await createJob({ kind: job, params: { scope, offset, limit }, total: limit, chatId, messageId });
  } catch (err) {
    if (/jobs_single_running/.test(err.message)) throw new Error('Один перерахунок уже виконується');
    throw err;
  }
}

async function runJob(row, { onProgress } = {}) {
  const runner = RUNNERS[row.kind];
  if (!runner) {
    await finishJob(row.id, { status: 'failed', error: `Невідомий перерахунок: ${row.kind}` });
    return null;
  }

  const { offset = 0, limit = row.total ?? 0 } = row.params || {};
  const pause = PAUSE_MS[row.kind] ?? DEFAULT_PAUSE_MS;
  const state = {
    job: row.kind,
    scope: row.params?.scope,
    done: row.done,
    skipped: row.skipped,
    failed: row.failed,
    cursor: row.cursor,
    stopped: false,
    startedAt: new Date(row.createdAt).getTime(),
    total: limit,
  };
  stopping = false;

  try {
    while (state.cursor < limit && !state.stopped) {
      const take = Math.min(PAGE, limit - state.cursor);
      const calls = await getCallsForReprocess({ limit: take, offset: offset + state.cursor });
      if (!calls.length) break;

      for (const call of calls) {
        if (stopping) {
          state.stopped = true;
          break;
        }
        if (runner.applies(call)) {
          try {
            await runner.run(call);
            state.done += 1;
          } catch (err) {
            state.failed += 1;
            console.error(`[reprocess:${row.kind}] ${call.generalCallId}: ${err.message}`);
          }
        } else {
          state.skipped += 1;
        }
        state.cursor += 1;

        if (state.cursor % PROGRESS_EVERY === 0) {
          const alive = await saveJobProgress(row.id, state);
          if (!alive) {
            state.stopped = true;
            break;
          }
        }
        if (onProgress) await onProgress({ ...state });
        if (pause && !state.stopped) await new Promise((r) => setTimeout(r, pause));
      }
    }
  } catch (err) {
    await finishJob(row.id, { status: 'failed', error: err.message });
    throw err;
  }

  await saveJobProgress(row.id, state);
  await finishJob(row.id, { status: state.stopped ? 'cancelled' : 'done' });
  return { ...state, stopped: state.stopped };
}

async function resumeJob({ onProgress } = {}) {
  const row = await getRunningJob();
  if (!row) return null;
  console.log(`[reprocess] продовжую перерахунок «${row.kind}» з позиції ${row.cursor}/${row.total}`);
  return runJob(row, { onProgress });
}

async function invalidateReportCache() {
  await clearAllReportSegments();
}

export {
  getRunningJob,
  getRecentJobs,
  startRun,
  runJob,
  resumeJob,
  estimate,
  stop,
  isRunning,
  blockCount,
  BLOCK,
  RUNNERS,
  invalidateReportCache,
};
