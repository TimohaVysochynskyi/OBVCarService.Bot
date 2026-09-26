import 'dotenv/config';
import { migrateKb, getKbDocsWithFile, replaceKbDocChunks } from '../core/store.js';
import { extractPages, chunkDocument, embedTexts, embedInput } from '../bot/kb.js';
import { downloadOriginal } from '../bot/kbClip.js';


async function main() {
  const only = process.argv.slice(2).map(Number).filter(Number.isInteger);
  await migrateKb();

  const docs = (await getKbDocsWithFile()).filter((d) => !only.length || only.includes(d.id));
  if (!docs.length) {
    console.log('[kb:reindex] нема документів з file_id — нічого робити');
    return;
  }
  console.log(`[kb:reindex] документів до переіндексації: ${docs.length}`);

  let ok = 0;
  for (const doc of docs) {
    const t0 = Date.now();
    try {
      const buffer = await downloadOriginal(doc.fileId);
      const pages = await extractPages(buffer, doc.filename);
      const chunks = chunkDocument(pages);
      if (!chunks.length) throw new Error('порожній текст після витягу');
      const embeddings = await embedTexts(chunks.map((c) => embedInput(doc.filename, c)));
      await replaceKbDocChunks(
        doc.id,
        chunks.map((c, ord) => ({
          ord,
          content: c.content,
          embedding: embeddings[ord],
          pageStart: c.pageStart,
          pageEnd: c.pageEnd,
        }))
      );
      const withPages = chunks.filter((c) => c.pageStart != null).length;
      console.log(
        `[kb:reindex] #${doc.id} «${doc.filename}»: ${doc.chunkCount} → ${chunks.length} фрагм. ` +
          `(зі сторінками: ${withPages}, сторінок у файлі: ${pages.length}) за ${Math.round((Date.now() - t0) / 1000)}с`
      );
      ok += 1;
    } catch (err) {
      console.error(`[kb:reindex] #${doc.id} «${doc.filename}» ПОМИЛКА: ${err.message}`);
    }
  }
  console.log(`[kb:reindex] готово: ${ok}/${docs.length}`);
  return ok === docs.length;
}

main()
  .then((allOk) => process.exit(allOk ? 0 : 1))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
