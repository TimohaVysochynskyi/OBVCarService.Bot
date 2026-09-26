import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InputFile } from 'grammy';
import { getRecordingForCall } from '../core/audioStore.js';
import { ffmpegAvailable, cutMp3 } from '../core/ffmpeg.js';


const PAD = Number(process.env.AUDIO_CLIP_PAD_SEC || 3);
const MAX_CLIPS_PER_FINDING = 3;
const CAPTION_QUOTE_MAX = 300;

function clipKey(callId, start, end) {
  return `${callId}:${start}:${end}`;
}

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
    const sources = new Map();

    for (const c of wanted) {
      try {
        if (!sources.has(c.callId)) {
          sources.set(c.callId, await sourceRecording(c.callId, dir));
        }
        const src = sources.get(c.callId);
        if (!src) {
          noRecording += 1;
          continue;
        }

        const from = Math.max(0, c.start - PAD);
        const dur = Math.max(1, (Number(c.end ?? c.start) - c.start) + 2 * PAD);
        const out = join(dir, `${c.key.replace(/[^\w.-]/g, '_')}.mp3`);
        await cutMp3(src, out, from, dur);
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
  let missing = null;
  if (!clips.size && wanted.length) missing = noRecording >= cutFailed ? 'SYS-NOFILE' : 'FFM-FAIL';
  return { clips, missing };
}

async function sourceRecording(callId, dir) {
  const audio = await getRecordingForCall(callId);
  if (!audio) return null;
  if (audio.path) return audio.path;

  const path = join(dir, `src-${String(callId).replace(/[^\w.-]/g, '_')}.mp3`);
  await writeFile(path, audio.buffer);
  return path;
}

async function sendClip(api, chatId, buf, ev, { replyToMessageId } = {}) {
  const quote = ev.quote.length > CAPTION_QUOTE_MAX ? `${ev.quote.slice(0, CAPTION_QUOTE_MAX)}…` : ev.quote;
  const caption = `🎧 «${quote}»`;
  const extra = { caption };
  if (replyToMessageId) extra.reply_parameters = { message_id: replyToMessageId, allow_sending_without_reply: true };
  await api.sendAudio(chatId, new InputFile(buf, `dialog-${ev.callId}.mp3`), extra);
}

export { prepareClips, clipKey, sendClip };
