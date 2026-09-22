import { spawn } from 'node:child_process';
import { copyFile, mkdir, readdir, writeFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderGlobalReport } from './globalReportHtml.js';
import { attachClips, siteDir, AUDIO_DIR } from './globalReportAudio.js';

// The report is a small static site, not a single file any more:
//
//   <REPORT_SITE_DIR>/
//     index.html          rewritten on every build
//     assets/app.css      built from tailwind/input.css, committed
//     assets/app.js       page behaviour
//     audio/<hash>.mp3    evidence clips — ACCUMULATE and are reused across builds
//
// The same directory is both what gets zipped for Telegram today and what a web server points at
// once the subdomain exists, so there is no second layout to keep in step.

const HERE = dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = join(HERE, 'site');
const STATIC_FILES = ['app.css', 'app.js'];
const ASSETS_DIR = 'assets';

async function copyStatic(dir) {
  const out = join(dir, ASSETS_DIR);
  await mkdir(out, { recursive: true });
  for (const name of STATIC_FILES) {
    const from = join(STATIC_DIR, name);
    try {
      await copyFile(from, join(out, name));
    } catch (err) {
      // app.css is a BUILD artefact. If it is missing the page renders as unstyled text, which is
      // worse than an honest failure, so say exactly what to run.
      const hint = name === 'app.css' ? ' — зібрати його: npm run build:css' : '';
      throw new Error(`не знайдено ${from}${hint}: ${err.message}`);
    }
  }
}

async function audioStats(dir) {
  try {
    const files = await readdir(join(dir, AUDIO_DIR));
    let bytes = 0;
    for (const f of files) {
      if (!f.endsWith('.mp3')) continue;
      bytes += (await stat(join(dir, AUDIO_DIR, f))).size;
    }
    return { files: files.filter((f) => f.endsWith('.mp3')).length, bytes };
  } catch {
    return { files: 0, bytes: 0 };
  }
}

// Writes the whole site into `dir` (default REPORT_SITE_DIR) and returns what happened, so the
// caller can tell the owner whether the audio actually made it in.
async function buildSite(report, { dir = siteDir() } = {}) {
  await mkdir(dir, { recursive: true });
  const clips = await attachClips(report, { dir });
  await copyStatic(dir);
  await writeFile(join(dir, 'index.html'), renderGlobalReport(report), 'utf8');
  return { dir, clips, audio: await audioStats(dir) };
}

function run(cmd, args, opts) {
  return new Promise((resolve_, reject) => {
    const p = spawn(cmd, args, opts);
    let stderr = '';
    p.stderr.on('data', (d) => (stderr += d.toString()));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve_() : reject(new Error(`${cmd} exit ${code}: ${stderr.slice(-300)}`))));
  });
}

// Zips the directory's CONTENTS (not the directory itself), so the owner unpacks straight into a
// folder with index.html at its root rather than one wrapper deep.
async function zipSite(dir, zipPath) {
  await run('zip', ['-r', '-q', resolve(zipPath), '.'], { cwd: dir });
  return zipPath;
}

export { buildSite, zipSite, ASSETS_DIR, STATIC_DIR };
