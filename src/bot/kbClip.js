import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { InputFile } from 'grammy';
import { PDFDocument } from 'pdf-lib';
import { withRetry } from '../core/retry.js';

// Knowledge-base answers cite pages, not whole books: this module cuts JUST the cited pages out of
// the original PDF and sends that as a small document. Same idea as audioClip.js for calls (send
// the fragment that proves the claim, not the 40-minute recording).
//
// Two caches, because a 300-page textbook is tens of MB:
//  - the ORIGINAL bytes are cached on disk by file_id, so repeated cuts don't re-download it;
//  - the cut PDF's Telegram file_id is cached in memory, so a second tap on the same page range
//    resends instantly with no download and no ffmpeg-style work at all.

const PAD_PAGES = () => {
  const n = Number(process.env.KB_CLIP_PAD_PAGES);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 1;
};

const cacheDir = () => path.join(os.tmpdir(), 'obv-kb-cache');
const cacheName = (fileId) => `${crypto.createHash('sha1').update(fileId).digest('hex')}.bin`;

// docId:pageStart:pageEnd -> Telegram file_id of the already-cut excerpt.
const excerptFileIds = new Map();

async function fetchTelegramFile(fileId) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const meta = await withRetry(
    async () => {
      const res = await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${encodeURIComponent(fileId)}`);
      const data = await res.json();
      if (!data.ok) throw new Error(`getFile failed: ${data.description || res.status}`);
      return data.result;
    },
    { attempts: 3, delayMs: 1000, label: 'Telegram getFile' }
  );
  return withRetry(
    async () => {
      const res = await fetch(`https://api.telegram.org/file/bot${token}/${meta.file_path}`);
      if (!res.ok) throw new Error(`file download failed: HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    },
    { attempts: 3, delayMs: 1500, label: 'Telegram file download' }
  );
}

// Original document bytes for a Telegram file_id, disk-cached across clicks AND across bot
// restarts (tmpdir survives a pm2 reload). Cache write failures are non-fatal.
async function downloadOriginal(fileId) {
  const file = path.join(cacheDir(), cacheName(fileId));
  try {
    return await fs.readFile(file);
  } catch {
    /* not cached yet */
  }
  const buffer = await fetchTelegramFile(fileId);
  try {
    await fs.mkdir(cacheDir(), { recursive: true });
    await fs.writeFile(file, buffer);
  } catch (err) {
    console.error(`[kb] could not cache original: ${err.message}`);
  }
  return buffer;
}

// Copy pages [from..to] (1-based, inclusive, padded and clamped to the document) into a new PDF.
// Returns { buffer, from, to } with the range actually taken, or null if the range is unusable.
async function cutPages(buffer, from, to) {
  const src = await PDFDocument.load(buffer, { ignoreEncryption: true });
  const total = src.getPageCount();
  const pad = PAD_PAGES();
  const a = Math.max(1, Math.min(total, (from ?? 1) - pad));
  const b = Math.max(a, Math.min(total, (to ?? from ?? 1) + pad));
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  const out = await PDFDocument.create();
  const indices = [];
  for (let p = a; p <= b; p += 1) indices.push(p - 1);
  const copied = await out.copyPages(src, indices);
  for (const page of copied) out.addPage(page);
  return { buffer: Buffer.from(await out.save()), from: a, to: b };
}

// Spelled out, never abbreviated (owner's call): "сторінки 26-29" / "сторінка 26".
const pagesPhrase = (a, b) => (a === b ? `сторінка ${a}` : `сторінки ${a}-${b}`);

// Filename for the excerpt: the original name (without extension, trimmed) + the page range, so a
// mechanic who saves it still knows what book it came from.
function excerptFilename(filename, a, b) {
  const base = (filename || 'документ').replace(/\.pdf$/i, '').slice(0, 60);
  return `${base} ${pagesPhrase(a, b)}.pdf`;
}

// Send the cited pages of a doc as a small PDF. doc is a kb_docs row ({ id, filename, fileId }).
// replyToMessageId threads it under the answer the button sits on. Returns true when sent.
async function sendDocExcerpt(api, chatId, doc, pageStart, pageEnd, { replyToMessageId } = {}) {
  const replyParameters = replyToMessageId
    ? { message_id: replyToMessageId, allow_sending_without_reply: true }
    : undefined;
  const key = `${doc.id}:${pageStart}:${pageEnd}`;
  const cachedId = excerptFileIds.get(key);
  if (cachedId) {
    await api.sendDocument(chatId, cachedId, { ...(replyParameters ? { reply_parameters: replyParameters } : {}) });
    return true;
  }

  const original = await downloadOriginal(doc.fileId);
  const cut = await cutPages(original, pageStart, pageEnd);
  if (!cut) return false;
  const name = excerptFilename(doc.filename, cut.from, cut.to);
  // Caption is JUST the page range: the document name is already visible on the file itself, so
  // repeating it in the message is noise.
  const sent = await api.sendDocument(chatId, new InputFile(cut.buffer, name), {
    caption: `📄 ${pagesPhrase(cut.from, cut.to)}`,
    ...(replyParameters ? { reply_parameters: replyParameters } : {}),
  });
  const fid = sent?.document?.file_id;
  if (fid) excerptFileIds.set(key, fid);
  return true;
}

export { downloadOriginal, cutPages, sendDocExcerpt, excerptFilename, pagesPhrase };
