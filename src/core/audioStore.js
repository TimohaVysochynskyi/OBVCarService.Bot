import { mkdir, writeFile, readFile, rename, stat, statfs, unlink } from 'node:fs/promises';
import { dirname, join, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getCallRecordUrl } from './binotel.js';
import { getCallAudio } from './store.js';
import { withRetry } from './retry.js';

// Local archive of call recordings. Until 2026-07-30 audio was never stored: the ingest fetched a
// Binotel record URL, streamed it straight into the transcriber and dropped it. Everything that
// needed audio afterwards (report clips, "Прослухати запис" in the archive, any re-transcription)
// re-downloaded it from Binotel — which means the audio only existed for as long as Binotel chose to
// keep it, and every listen cost two API calls. The client requires all recordings to be KEPT, so
// the ingest now downloads once, writes the file here, and transcribes from the same bytes.
//
// Layout: <root>/YYYY-MM/<generalCallId>.mp3 — month folders keep any single directory small (~600
// files/month at current volume) and make "give me July" trivial for a human or a backup job. The
// relative path is recorded in calls.audio_path so consumers never have to guess it.
//
// Sizing (measured on the live account 2026-07-30): Binotel serves 32 kbps mono mp3, ~4 KB per
// second of call, ~268 KB for an average 67-second call. The whole existing history (806 calls,
// 15.0 hours) is ~216 MB, and volume runs ~19 calls/day → ~150 MB/month, ~1.8 GB/year. Re-encoding
// would be pointless at 32 kbps, so the original file is stored byte-for-byte.

const DEFAULT_ROOT = fileURLToPath(new URL('../../data/recordings', import.meta.url));

function storageRoot() {
  const configured = process.env.AUDIO_STORAGE_DIR;
  if (!configured) return DEFAULT_ROOT;
  return isAbsolute(configured) ? configured : resolve(process.cwd(), configured);
}

// A general_call_id is a Binotel numeric id, but it lands in a filesystem path — never let anything
// but [A-Za-z0-9._-] through, so a surprising value can't escape the storage root.
const safeId = (generalCallId) => String(generalCallId).replace(/[^\w.-]/g, '_');

// Month folder from the call's start time. An unparseable/missing start time still has to be stored
// somewhere, so it goes to "unknown" rather than being dropped.
function monthFolder(startTime) {
  const d = startTime ? new Date(startTime) : null;
  if (!d || Number.isNaN(d.getTime())) return 'unknown';
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

// Relative path (the value stored in calls.audio_path) — stable for a given (id, startTime).
function relPathFor(generalCallId, startTime) {
  return `${monthFolder(startTime)}/${safeId(generalCallId)}.mp3`;
}

const absolutePath = (relPath) => join(storageRoot(), relPath);

async function fileSize(path) {
  try {
    const s = await stat(path);
    return s.isFile() ? s.size : null;
  } catch {
    return null;
  }
}

// Write atomically: a partial file left behind by a crash/full disk would otherwise look like a
// valid stored recording forever (fileSize > 0), and every later consumer would read truncated
// audio. Writing to .part and renaming means the final path only ever exists complete.
async function writeAtomic(path, buffer) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.part`;
  try {
    await writeFile(tmp, buffer);
    await rename(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

// Download the recording bytes for a call from Binotel. Returns null when Binotel has no recording
// URL for it at all (which is a real, permanent answer — see backfillAudio.js).
async function fetchRecording(generalCallId) {
  const url = await getCallRecordUrl(generalCallId);
  if (!url) return null;
  return withRetry(
    async () => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`download recording ${generalCallId}: HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    },
    { attempts: 3, delayMs: 1000, label: `download recording ${generalCallId}` }
  );
}

// Persist bytes for a call. Idempotent: an already-stored file of the same size is left alone.
// Returns { relPath, path, bytes }.
async function saveRecording(generalCallId, startTime, buffer) {
  const relPath = relPathFor(generalCallId, startTime);
  const path = absolutePath(relPath);
  const existing = await fileSize(path);
  if (existing === buffer.length) return { relPath, path, bytes: existing };
  await writeAtomic(path, buffer);
  return { relPath, path, bytes: buffer.length };
}

// The ingest entry point: get the recording ONCE, keep it, and hand the bytes back for transcription.
// Reuses an already-stored file (so a pending-queue retry doesn't re-download), otherwise fetches
// from Binotel and stores it.
//
// Storing is best-effort and NEVER fatal: if the disk is full or read-only we still return the
// buffer, so a storage problem degrades to "this call wasn't archived" instead of "this call was
// lost". The caller records that outcome (audio_status) and the poller alerts on low disk space.
async function storeRecording(generalCallId, startTime) {
  const relPath = relPathFor(generalCallId, startTime);
  const path = absolutePath(relPath);

  const existing = await fileSize(path);
  if (existing) {
    return { buffer: await readFile(path), relPath, path, bytes: existing, reused: true };
  }

  const buffer = await fetchRecording(generalCallId);
  if (!buffer) return { buffer: null, relPath: null, path: null, bytes: 0, error: 'Binotel не віддав URL запису' };

  try {
    await writeAtomic(path, buffer);
    return { buffer, relPath, path, bytes: buffer.length, reused: false };
  } catch (err) {
    console.error(`[audioStore] failed to store ${generalCallId} at ${path}: ${err.message}`);
    return { buffer, relPath: null, path: null, bytes: buffer.length, error: err.message };
  }
}

// Read a stored recording. `relPath` is calls.audio_path when known; otherwise the path is derived
// from (id, startTime). Returns null when nothing is stored — callers fall back to Binotel.
async function readStoredRecording({ generalCallId, startTime, audioPath } = {}) {
  const relPath = audioPath || (generalCallId ? relPathFor(generalCallId, startTime) : null);
  if (!relPath) return null;
  const path = absolutePath(relPath);
  if (!(await fileSize(path))) return null;
  try {
    return { buffer: await readFile(path), path, relPath };
  } catch (err) {
    console.error(`[audioStore] failed to read ${path}: ${err.message}`);
    return null;
  }
}

// Local-first accessor for everything that needs audio AFTER ingest (report clips, archive
// playback, re-transcription scripts). Falls back to Binotel when the file isn't stored yet, and
// stores what it downloads so the next read is local. Returns null if audio is unavailable entirely.
async function getRecording({ generalCallId, startTime, audioPath } = {}) {
  const local = await readStoredRecording({ generalCallId, startTime, audioPath });
  if (local) return { ...local, source: 'local' };

  const buffer = await fetchRecording(generalCallId);
  if (!buffer) return null;
  let stored = null;
  try {
    stored = await saveRecording(generalCallId, startTime, buffer);
  } catch (err) {
    console.error(`[audioStore] backfill-on-read failed for ${generalCallId}: ${err.message}`);
  }
  return { buffer, path: stored?.path ?? null, relPath: stored?.relPath ?? null, source: 'binotel' };
}

// Same as getRecording, but resolves the stored path from the DB row first — the convenient entry
// point for anything that only has a call id (report clips, archive playback, the re-analysis
// scripts). Looking the row up matters: the archive path is derived from the call's START TIME, so a
// caller that guesses without it would look in the wrong month folder and needlessly re-download.
async function getRecordingForCall(generalCallId) {
  const row = await getCallAudio(generalCallId).catch(() => null);
  return getRecording({
    generalCallId,
    startTime: row?.startTime,
    audioPath: row?.audioPath,
  });
}

// Free space on the volume holding the archive, in MB (null if it can't be determined). Used by the
// poller to warn before "keep everything forever" quietly runs the disk out.
async function freeSpaceMb() {
  try {
    const root = storageRoot();
    await mkdir(root, { recursive: true });
    const s = await statfs(root);
    return Math.floor((s.bsize * s.bavail) / (1024 * 1024));
  } catch (err) {
    console.warn(`[audioStore] free space check skipped: ${err.message}`);
    return null;
  }
}

export {
  storageRoot,
  relPathFor,
  absolutePath,
  fetchRecording,
  saveRecording,
  storeRecording,
  readStoredRecording,
  getRecording,
  getRecordingForCall,
  freeSpaceMb,
};
