import { createHash } from 'node:crypto';
import { mkdir, rename, stat, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getRecordingForCall } from '../core/audioStore.js';
import { ffmpegAvailable, cutMp3 } from '../core/ffmpeg.js';

// Audio evidence for the PUBLISHED report. Unlike the Telegram clips (bot/audioClip.js), which are
// cut into memory and sent once, these are files on disk that the page links to — so they are cut
// once and reused by every later report. That is what makes regenerating the document cheap: the
// expensive parts (the model's findings, and now the clips) are both cached.
//
// Clips cover BOTH strengths and weaknesses. In Telegram only the negatives got audio, because a
// chat message with fifty audio files is unusable; a page has room, and "listen to what he did
// right" is worth as much to the owner as the other half.

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const AUDIO_DIR = 'audio';
const PAD = Number(process.env.AUDIO_CLIP_PAD_SEC || 3);
const MAX_CLIP_SEC = 90; // a runaway end timecode must not cut half the call

function siteDir() {
  const configured = process.env.REPORT_SITE_DIR;
  if (configured) return resolve(configured);
  return join(REPO_ROOT, 'data', 'report-site');
}

// Deterministic name: the same (call, timecode) is always the same file, which is what lets a
// repeat run skip ffmpeg entirely and what keeps the audio folder from growing a duplicate per run.
function clipName(callId, start, end) {
  const key = `${callId}:${start}:${end}`;
  return `${createHash('sha1').update(key).digest('hex').slice(0, 16)}.mp3`;
}

async function exists(path) {
  try {
    const info = await stat(path);
    return info.isFile() && info.size > 0;
  } catch {
    return false;
  }
}

function everyExample(report) {
  const out = [];
  for (const manager of report.managers || []) {
    for (const kind of ['strengths', 'weaknesses']) {
      for (const finding of manager[kind] || []) {
        for (const example of finding.examples || []) out.push(example);
      }
    }
  }
  return out;
}

// Full recording to cut from. Calls archived at ingest are read in place — no download at all.
// Only pre-archive calls fall back to Binotel, and what comes back is archived on the way.
async function sourceRecording(callId, tmp) {
  const audio = await getRecordingForCall(callId);
  if (!audio) return null;
  if (audio.path) return audio.path;
  const path = join(tmp, `src-${String(callId).replace(/[^\w.-]/g, '_')}.mp3`);
  await writeFile(path, audio.buffer);
  return path;
}

// Annotates each example in place with `audio` (a path relative to the page) and `audioSeconds`.
// Never throws: an example without audio simply renders as the quote alone, which is still evidence.
async function attachClips(report, { dir = siteDir() } = {}) {
  const stats = { wanted: 0, cut: 0, reused: 0, noTimecode: 0, noRecording: 0, failed: 0 };
  const examples = everyExample(report);
  if (!examples.length) return stats;

  const withTime = examples.filter((e) => e.callId != null && e.start != null);
  stats.noTimecode = examples.length - withTime.length;
  stats.wanted = withTime.length;
  if (!withTime.length) return stats;

  if (!(await ffmpegAvailable())) {
    console.warn('[globalReportAudio] ffmpeg недоступний — сторінка буде без аудіо');
    stats.failed = withTime.length;
    return stats;
  }

  const audioDir = join(dir, AUDIO_DIR);
  await mkdir(audioDir, { recursive: true });

  let tmp;
  try {
    tmp = await mkdtemp(join(tmpdir(), 'obv-site-clip-'));
    const sources = new Map();

    for (const example of withTime) {
      const name = clipName(example.callId, example.start, example.end);
      const out = join(audioDir, name);
      const span = Math.max(1, Math.min(MAX_CLIP_SEC, Number(example.end ?? example.start) - example.start + 2 * PAD));

      try {
        if (await exists(out)) {
          stats.reused += 1;
        } else {
          if (!sources.has(example.callId)) {
            sources.set(example.callId, await sourceRecording(example.callId, tmp));
          }
          const src = sources.get(example.callId);
          if (!src) {
            stats.noRecording += 1;
            continue;
          }
          // Written aside and renamed: a run killed mid-cut would otherwise leave a truncated file
          // that every later run treats as a finished clip and never re-cuts.
          const part = `${out}.part`;
          await cutMp3(src, part, Math.max(0, example.start - PAD), span);
          await rename(part, out);
          stats.cut += 1;
        }
        example.audio = `${AUDIO_DIR}/${name}`;
        example.audioSeconds = Math.round(span);
      } catch (err) {
        stats.failed += 1;
        console.error(`[globalReportAudio] ${example.callId}@${example.start} не вирізався: ${err.message}`);
      }
    }
  } catch (err) {
    console.error(`[globalReportAudio] нарізка впала: ${err.message}`);
  } finally {
    if (tmp) await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }

  return stats;
}

export { attachClips, siteDir, clipName, AUDIO_DIR };
