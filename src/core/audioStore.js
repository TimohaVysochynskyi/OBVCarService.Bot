import { mkdir, writeFile, readFile, rename, stat, statfs, unlink } from 'node:fs/promises';
import { fetchOk } from './http.js';
import { dirname, join, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getCallRecordUrl } from './binotel.js';
import { getCallAudio } from './store.js';
import { withRetry } from './retry.js';


const DEFAULT_ROOT = fileURLToPath(new URL('../../data/recordings', import.meta.url));

function storageRoot() {
  const configured = process.env.AUDIO_STORAGE_DIR;
  if (!configured) return DEFAULT_ROOT;
  return isAbsolute(configured) ? configured : resolve(process.cwd(), configured);
}

const safeId = (generalCallId) => String(generalCallId).replace(/[^\w.-]/g, '_');

function monthFolder(startTime) {
  const d = startTime ? new Date(startTime) : null;
  if (!d || Number.isNaN(d.getTime())) return 'unknown';
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

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

async function fetchRecording(generalCallId) {
  const url = await getCallRecordUrl(generalCallId);
  if (!url) return null;
  return withRetry(
    async () => {
      const res = await fetchOk('recording', `завантаження запису ${generalCallId}`, url);
      return Buffer.from(await res.arrayBuffer());
    },
    { attempts: 3, delayMs: 1000, label: `download recording ${generalCallId}` }
  );
}

async function saveRecording(generalCallId, startTime, buffer) {
  const relPath = relPathFor(generalCallId, startTime);
  const path = absolutePath(relPath);
  const existing = await fileSize(path);
  if (existing === buffer.length) return { relPath, path, bytes: existing };
  await writeAtomic(path, buffer);
  return { relPath, path, bytes: buffer.length };
}

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

async function getRecordingForCall(generalCallId) {
  const row = await getCallAudio(generalCallId).catch(() => null);
  return getRecording({
    generalCallId,
    startTime: row?.startTime,
    audioPath: row?.audioPath,
  });
}

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
