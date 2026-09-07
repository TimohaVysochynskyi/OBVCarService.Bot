import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InputFile } from 'grammy';
import { getRecordingForCall } from '../core/audioStore.js';

// Audio evidence for the report: cut a short clip around a quoted line so the owner can listen and
// verify. Uses SYSTEM ffmpeg (fast, tiny clips). If ffmpeg isn't installed the report still works —
// it just goes text-only (prepareClips returns an empty map). Clips are cut ONCE per report and can
// be re-sent to several recipients (scheduled fan-out).

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const PAD = Number(process.env.AUDIO_CLIP_PAD_SEC || 3); // seconds of context on each side
const MAX_CLIPS_PER_FINDING = 3;
const CAPTION_QUOTE_MAX = 300;
// Без обмеження часу зависший ffmpeg не давав ні результату, ні помилки: «Розгорнути» просто
// не завершувалось ніколи. Нарізка секундного фрагмента - справа мілісекунд, тож хвилини вдосталь.
const FFMPEG_TIMEOUT_MS = Number(process.env.FFMPEG_TIMEOUT_MS || 60_000);
const PROBE_TIMEOUT_MS = 5_000;

// Stable key so the same (call, timecode) maps to one cut clip across findings/recipients.
function clipKey(callId, start, end) {
  return `${callId}:${start}:${end}`;
}

// Cached one-shot preflight: is `ffmpeg` runnable? Cache the promise so we probe at most once.
let ffmpegProbe = null;
function ffmpegAvailable() {
  if (!ffmpegProbe) {
    ffmpegProbe = new Promise((resolve) => {
      try {
        const p = spawn(FFMPEG, ['-version']);
        // Проба кешується на весь процес, тож її зависання зупинило б усі звіти назавжди.
        const timer = setTimeout(() => {
          p.kill('SIGKILL');
          resolve(false);
        }, PROBE_TIMEOUT_MS);
        p.on('error', () => {
          clearTimeout(timer);
          resolve(false);
        });
        p.on('close', (code) => {
          clearTimeout(timer);
          resolve(code === 0);
        });
      } catch {
        resolve(false);
      }
    });
  }
  return ffmpegProbe;
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, args);
    let stderr = '';
    const timer = setTimeout(() => {
      p.kill('SIGKILL');
      const err = new Error(`ffmpeg не завершився за ${Math.round(FFMPEG_TIMEOUT_MS / 1000)}с`);
      err.name = 'TimeoutError';
      reject(err);
    }, FFMPEG_TIMEOUT_MS);
    p.stderr.on('data', (d) => (stderr += d.toString()));
    p.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exit ${code}: ${stderr.slice(-300)}`));
    });
  });
}

// Collect the unique (callId,start,end) clips needed by a report — negatives only, capped per
// finding — preserving which callId each belongs to. Findings live in report.blocks[].findings.
function allFindings(report) {
  if (Array.isArray(report.blocks)) return report.blocks.flatMap((b) => b.findings || []);
  return report.findings || [];
}

function neededClips(report) {
  const seen = new Set();
  const clips = [];
  for (const f of allFindings(report)) {
    if (f.type !== 'error') continue;
    let n = 0;
    for (const ev of f.evidence) {
      if (ev.start == null) continue;
      if (n >= MAX_CLIPS_PER_FINDING) break;
      n += 1;
      const key = clipKey(ev.callId, ev.start, ev.end);
      if (seen.has(key)) continue;
      seen.add(key);
      clips.push({ key, callId: ev.callId, start: ev.start, end: ev.end });
    }
  }
  return clips;
}

// Build a Map(clipKey → mp3 Buffer) for a report's negative findings. Downloads each source
// recording once (cached per call), cuts every needed clip with ffmpeg. Any failure (no ffmpeg,
// recording gone, cut error) just omits that clip → the report shows the text quote without audio.
// Повертає { clips, missing }: `missing` - код класу, ЧОМУ аудіо немає, або null.
// Раніше все просто ковталось у порожню мапу, і директор отримував звіт без аудіо-доказів, ніде
// не бачачи причини - ні що на сервері немає ffmpeg, ні що Binotel уже видалив записи.
async function prepareClips(report) {
  const clips = new Map();
  const wanted = neededClips(report);
  if (!wanted.length) return { clips, missing: null };

  if (!(await ffmpegAvailable())) {
    console.warn('[audioClip] ffmpeg not available — report will be text-only (no audio clips)');
    return { clips, missing: 'FFM-MISSING' };
  }

  let noRecording = 0;
  let cutFailed = 0;

  let dir;
  try {
    dir = await mkdtemp(join(tmpdir(), 'obv-clip-'));
    const sources = new Map(); // callId → path of the full mp3 (local archive, or null if unavailable)

    for (const c of wanted) {
      try {
        if (!sources.has(c.callId)) {
          sources.set(c.callId, await sourceRecording(c.callId, dir));
        }
        const src = sources.get(c.callId);
        if (!src) {
          noRecording += 1;
          continue; // no local file and Binotel has nothing → skip
        }

        const from = Math.max(0, c.start - PAD);
        const dur = Math.max(1, (Number(c.end ?? c.start) - c.start) + 2 * PAD);
        const out = join(dir, `${c.key.replace(/[^\w.-]/g, '_')}.mp3`);
        await runFfmpeg(['-y', '-ss', String(from), '-i', src, '-t', String(dur), '-c:a', 'libmp3lame', '-q:a', '5', out]);
        clips.set(c.key, await readFile(out));
      } catch (err) {
        cutFailed += 1;
        console.error(`[audioClip] clip ${c.key} failed: ${err.message}`);
      }
    }
  } catch (err) {
    cutFailed += 1;
    console.error(`[audioClip] prepareClips failed: ${err.message}`);
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  // Причину показуємо лише коли аудіо справді бракує, і беремо найзмістовнішу: «записів немає»
  // конкретніше за «нарізка впала», а частковий успіх узагалі не варто коментувати.
  let missing = null;
  if (!clips.size && wanted.length) missing = noRecording >= cutFailed ? 'SYS-NOFILE' : 'FFM-FAIL';
  return { clips, missing };
}

// Path of the full recording to cut from. Recordings are archived locally at ingest
// (core/audioStore.js), so the normal case needs NO download at all — ffmpeg reads the stored file
// in place. Only calls from before audio archiving (or a failed store) fall back to Binotel, and
// what's downloaded is archived on the way so the next clip is local too.
async function sourceRecording(callId, dir) {
  const audio = await getRecordingForCall(callId);
  if (!audio) return null;
  if (audio.path) return audio.path; // stored on disk — ffmpeg reads it in place, nothing to copy

  // Downloaded but not archivable (disk problem): cut from a temp copy rather than lose the evidence.
  const path = join(dir, `src-${String(callId).replace(/[^\w.-]/g, '_')}.mp3`);
  await writeFile(path, audio.buffer);
  return path;
}

// Send one prepared clip as a Telegram audio message with a short caption (the quote + time).
// replyToMessageId (optional) threads it back to the report message it was revealed from.
async function sendClip(api, chatId, buf, ev, { replyToMessageId } = {}) {
  const quote = ev.quote.length > CAPTION_QUOTE_MAX ? `${ev.quote.slice(0, CAPTION_QUOTE_MAX)}…` : ev.quote;
  const caption = `🎧 «${quote}»`;
  const extra = { caption };
  if (replyToMessageId) extra.reply_parameters = { message_id: replyToMessageId, allow_sending_without_reply: true };
  await api.sendAudio(chatId, new InputFile(buf, `dialog-${ev.callId}.mp3`), extra);
}

export { prepareClips, clipKey, sendClip, ffmpegAvailable };
