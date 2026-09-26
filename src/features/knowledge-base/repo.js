import { pool } from '../../platform/db/pool.js';

async function migrateKb() {
  await pool.query('CREATE EXTENSION IF NOT EXISTS vector');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS kb_docs (
      id SERIAL PRIMARY KEY,
      filename TEXT NOT NULL,
      uploaded_by TEXT,
      file_id TEXT,
      mime TEXT,
      chunk_count INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    -- Telegram file_id lets us resend the original document ("open file") without storing bytes.
    ALTER TABLE kb_docs ADD COLUMN IF NOT EXISTS file_id TEXT;
    ALTER TABLE kb_docs ADD COLUMN IF NOT EXISTS mime TEXT;

    -- Audience = which employee role a manual is FOR: 'mechanic' | 'manager' | 'both'. Filters KB
    -- answers so a mechanic never gets a manager's sales manual and vice versa (director/marketer
    -- see everything). NOT NULL DEFAULT 'mechanic' also backfills pre-existing rows to 'mechanic'
    -- (per the client's request that current files belong to mechanics).
    ALTER TABLE kb_docs ADD COLUMN IF NOT EXISTS audience TEXT NOT NULL DEFAULT 'mechanic';

    CREATE TABLE IF NOT EXISTS kb_chunks (
      id SERIAL PRIMARY KEY,
      doc_id INTEGER NOT NULL REFERENCES kb_docs(id) ON DELETE CASCADE,
      ord INTEGER NOT NULL,
      content TEXT NOT NULL,
      embedding vector(1536),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS kb_chunks_embedding_idx ON kb_chunks USING hnsw (embedding vector_cosine_ops);

    -- Page range a chunk came from (PDF only; NULL for DOCX/TXT which have no pages). Lets a KB
    -- answer cite the exact page(s). Chunks ingested before this column stay NULL (no page shown).
    ALTER TABLE kb_chunks ADD COLUMN IF NOT EXISTS page_start INTEGER;
    ALTER TABLE kb_chunks ADD COLUMN IF NOT EXISTS page_end INTEGER;

    -- Lexical half of the hybrid search. Vector search alone misses exact technical terms (a part
    -- name, a spec number) because the embedding smears them into the surrounding topic; FTS nails
    -- them. Config is 'simple' (no Ukrainian stemmer ships with Postgres) — morphology is handled by
    -- turning query words into prefix terms (двигун:*), see searchKbChunksLexical.
    ALTER TABLE kb_chunks ADD COLUMN IF NOT EXISTS tsv tsvector
      GENERATED ALWAYS AS (to_tsvector('simple', content)) STORED;
    CREATE INDEX IF NOT EXISTS kb_chunks_tsv_idx ON kb_chunks USING gin (tsv);
  `);
}

const vecToStr = (arr) => `[${arr.join(',')}]`;

async function insertKbDoc(filename, uploadedBy, fileId, mime, audience = 'mechanic') {
  const { rows } = await pool.query(
    'INSERT INTO kb_docs (filename, uploaded_by, file_id, mime, audience) VALUES ($1, $2, $3, $4, $5) RETURNING id',
    [filename, uploadedBy || null, fileId || null, mime || null, audience]
  );
  return rows[0].id;
}

const CHUNK_INSERT_BATCH = 100;

async function insertChunkRows(client, docId, chunks) {
  for (let i = 0; i < chunks.length; i += CHUNK_INSERT_BATCH) {
    const batch = chunks.slice(i, i + CHUNK_INSERT_BATCH);
    const values = [];
    const params = [];
    for (const c of batch) {
      const n = params.length;
      values.push(`($${n + 1}, $${n + 2}, $${n + 3}, $${n + 4}::vector, $${n + 5}, $${n + 6})`);
      params.push(docId, c.ord, c.content, vecToStr(c.embedding), c.pageStart ?? null, c.pageEnd ?? null);
    }
    await client.query(
      `INSERT INTO kb_chunks (doc_id, ord, content, embedding, page_start, page_end) VALUES ${values.join(', ')}`,
      params
    );
  }
  await client.query('UPDATE kb_docs SET chunk_count = $2 WHERE id = $1', [docId, chunks.length]);
}

async function insertKbChunks(docId, chunks) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await insertChunkRows(client, docId, chunks);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function replaceKbDocChunks(docId, chunks) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM kb_chunks WHERE doc_id = $1', [docId]);
    await insertChunkRows(client, docId, chunks);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function searchKbChunks(queryEmbedding, k = 6, audiences = null) {
  const params = [vecToStr(queryEmbedding), k];
  let filter = '';
  if (audiences && audiences.length) {
    params.push(audiences);
    filter = `WHERE d.audience = ANY($3)`;
  }
  const { rows } = await pool.query(
    `SELECT c.id AS "chunkId", c.content, c.page_start AS "pageStart", c.page_end AS "pageEnd",
            d.filename, d.id AS "docId", (c.embedding <=> $1::vector) AS dist
     FROM kb_chunks c JOIN kb_docs d ON d.id = c.doc_id
     ${filter}
     ORDER BY c.embedding <=> $1::vector
     LIMIT $2`,
    params
  );
  return rows;
}

async function searchKbChunksLexical(tsQuery, k = 12, audiences = null) {
  const params = [tsQuery, k];
  let filter = '';
  if (audiences && audiences.length) {
    params.push(audiences);
    filter = 'AND d.audience = ANY($3)';
  }
  const { rows } = await pool.query(
    `SELECT c.id AS "chunkId", c.content, c.page_start AS "pageStart", c.page_end AS "pageEnd",
            d.filename, d.id AS "docId", ts_rank_cd(c.tsv, q) AS score
     FROM kb_chunks c JOIN kb_docs d ON d.id = c.doc_id, to_tsquery('simple', $1) q
     WHERE c.tsv @@ q ${filter}
     ORDER BY score DESC
     LIMIT $2`,
    params
  );
  return rows;
}

async function listKbDocs() {
  const { rows } = await pool.query(
    `SELECT id, filename, chunk_count AS "chunkCount", audience, created_at AS "createdAt"
     FROM kb_docs ORDER BY created_at DESC`
  );
  return rows;
}

async function countKbChunks() {
  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM kb_chunks');
  return rows[0].n;
}

async function getKbDoc(id) {
  const { rows } = await pool.query(
    `SELECT id, filename, file_id AS "fileId", mime, chunk_count AS "chunkCount", audience, created_at AS "createdAt"
     FROM kb_docs WHERE id = $1`,
    [id]
  );
  return rows[0] || null;
}

async function getKbDocsWithFile() {
  const { rows } = await pool.query(
    `SELECT id, filename, file_id AS "fileId", mime, audience, chunk_count AS "chunkCount"
     FROM kb_docs WHERE file_id IS NOT NULL ORDER BY id`
  );
  return rows;
}

async function setKbDocAudience(id, audience) {
  await pool.query('UPDATE kb_docs SET audience = $2 WHERE id = $1', [id, audience]);
}

async function deleteKbDoc(id) {
  await pool.query('DELETE FROM kb_docs WHERE id = $1', [id]);
}

export {
  migrateKb,
  insertKbDoc,
  insertKbChunks,
  replaceKbDocChunks,
  searchKbChunks,
  searchKbChunksLexical,
  listKbDocs,
  countKbChunks,
  getKbDoc,
  getKbDocsWithFile,
  setKbDocAudience,
  deleteKbDoc,
};
