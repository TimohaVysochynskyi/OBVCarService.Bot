import fs from 'node:fs/promises';
import { fetchOk } from '../core/http.js';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { InputFile } from 'grammy';
import { PDFDocument } from 'pdf-lib';
import { withRetry } from '../core/retry.js';


const PAD_PAGES = () => {
  const n = Number(process.env.KB_CLIP_PAD_PAGES);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 1;
};

const cacheDir = () => path.join(os.tmpdir(), 'obv-kb-cache');
const cacheName = (fileId) => `${crypto.createHash('sha1').update(fileId).digest('hex')}.bin`;

const excerptFileIds = new Map();

async function fetchTelegramFile(fileId) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const meta = await withRetry(
    async () => {
      const res = await fetchOk('telegram', 'getFile', `https://api.telegram.org/bot${token}/getFile?file_id=${encodeURIComponent(fileId)}`);
      const data = await res.json();
      if (!data.ok) {
        const err = new Error(`telegram getFile: ${data.description || 'ok:false'}`);
        err.provider = 'telegram';
        err.op = 'getFile';
        err.description = data.description;
        throw err;
      }
      return data.result;
    },
    { attempts: 3, delayMs: 1000, label: 'Telegram getFile' }
  );
  return withRetry(
    async () => {
      const res = await fetchOk('telegram', 'завантаження файлу', `https://api.telegram.org/file/bot${token}/${meta.file_path}`);
      return Buffer.from(await res.arrayBuffer());
    },
    { attempts: 3, delayMs: 1500, label: 'Telegram file download' }
  );
}

async function downloadOriginal(fileId) {
  const file = path.join(cacheDir(), cacheName(fileId));
  try {
    return await fs.readFile(file);
  } catch {
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

const pagesPhrase = (a, b) => (a === b ? `сторінка ${a}` : `сторінки ${a}-${b}`);

function excerptFilename(filename, a, b) {
  const base = (filename || 'документ').replace(/\.pdf$/i, '').slice(0, 60);
  return `${base} ${pagesPhrase(a, b)}.pdf`;
}

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
  const sent = await api.sendDocument(chatId, new InputFile(cut.buffer, name), {
    caption: `📄 ${pagesPhrase(cut.from, cut.to)}`,
    ...(replyParameters ? { reply_parameters: replyParameters } : {}),
  });
  const fid = sent?.document?.file_id;
  if (fid) excerptFileIds.set(key, fid);
  return true;
}

export { downloadOriginal, cutPages, sendDocExcerpt, excerptFilename, pagesPhrase };
