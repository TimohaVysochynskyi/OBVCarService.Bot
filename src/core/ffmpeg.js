import { spawn } from 'node:child_process';

// The project's single ffmpeg policy. Two callers cut audio — the Telegram evidence clips
// (bot/audioClip.js) and the published report's clips (bot/globalReportAudio.js) — and they must
// agree on the binary, the timeouts and the availability probe, or one of them silently behaves
// differently on a server where ffmpeg is missing or wedged.

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
// Without a limit a wedged ffmpeg gave neither a result nor an error: the operation simply never
// finished. Cutting a few seconds of audio is a matter of milliseconds, so a minute is plenty.
const FFMPEG_TIMEOUT_MS = Number(process.env.FFMPEG_TIMEOUT_MS || 60_000);
const PROBE_TIMEOUT_MS = 5_000;

// Cached one-shot preflight: is `ffmpeg` runnable? The promise is cached, so we probe at most once
// per process — which is also why the probe itself needs a timeout: a hang here would stall every
// report forever.
let probe = null;
function ffmpegAvailable() {
  if (!probe) {
    probe = new Promise((resolve) => {
      try {
        const p = spawn(FFMPEG, ['-version']);
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
  return probe;
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

// Cut [from, from+duration] out of `src` into `out` as mp3. Sources are already 32 kbps mono, so
// re-encoding costs nothing and guarantees a clean, seekable clip.
// ⚠️ `-f mp3` is not redundant: ffmpeg picks the container from the output EXTENSION, so writing to
// a temporary name like `clip.mp3.part` — which is how the caller avoids leaving a half-written
// file behind — fails with "Invalid argument" unless the format is stated outright.
async function cutMp3(src, out, from, duration) {
  await runFfmpeg([
    '-y',
    '-ss', String(from),
    '-i', src,
    '-t', String(duration),
    '-c:a', 'libmp3lame',
    '-q:a', '5',
    '-f', 'mp3',
    out,
  ]);
}

export { ffmpegAvailable, runFfmpeg, cutMp3, FFMPEG, FFMPEG_TIMEOUT_MS };
