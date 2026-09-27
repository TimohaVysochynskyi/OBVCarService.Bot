import { spawn } from 'node:child_process';
import { config } from '../../shared/config.js';


const FFMPEG = config.audio.ffmpegPath;
const FFMPEG_TIMEOUT_MS = config.audio.ffmpegTimeoutMs;
const PROBE_TIMEOUT_MS = 5_000;

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

export { ffmpegAvailable, cutMp3, FFMPEG_TIMEOUT_MS };
