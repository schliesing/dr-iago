#!/usr/bin/env node
/**
 * Indexador: lê docs do SQLite knowledge_docs → Qdrant
 * Uso: node scripts/index_sqlite_to_qdrant.js [--reindex]
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { getDb } = require('../src/db/database');
const { addDocuments, initCollection, deleteCollection } = require('../src/rag/vector_store');
const { generateEmbedding, parseDocument } = require('../src/rag/embeddings');

const DOC_TYPE_MAP = {
  'Lei 14.133': 'lei_14133',
  'Lei 8.666': 'lei_8666',
  'Lei Complementar 123': 'lc_123',
  'Lei 10.520': 'lei_10520',
  'Decreto': 'decreto',
  'Instrução Normativa': 'in_seges',
  'TCU': 'tcu',
  'STJ': 'stj',
  'STF': 'stf',
  'Jurisprudência': 'jurisprudencia',
  'seed': 'doutrina',
};

function detectType(filename) {
  const upper = filename.toUpperCase();
  for (const [key, type] of Object.entries(DOC_TYPE_MAP)) {
    if (upper.includes(key.toUpperCase())) return type;
  }
  return 'documento';
}

function stripHtml(html) {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function main() {
  const args = process.argv.slice(2);
  const reindex = args.includes('--reindex');

  console.log('╔════════════════════════════════════════════╗');
  console.log('║  📚 Indexador SQLite → Qdrant - Dr. IAgo  ║');
  console.log('╚════════════════════════════════════════════╝\n');

  if (reindex) {
    console.log('[IDX] 🗑️ Deletando coleção e recriando...');
    await deleteCollection();
    await sleep(2000); // esperar Qdrant processar delete
    await initCollection();
  } else {
    await initCollection();
  }

  const db = getDb();
  const docs = db.prepare('SELECT id, original_name, content FROM knowledge_docs').all();
  console.log(`[IDX] 📄 ${docs.length} documentos encontrados no SQLite\n`);

  let totalChunks = 0;
  let totalIndexed = 0;
  let errors = 0;

  for (const doc of docs) {
    try {
      const text = stripHtml(doc.content);
      if (!text || text.length < 50) {
        console.log(`[IDX] ⏭️  Ignorando (conteúdo curto): ${doc.original_name}`);
        continue;
      }

      const type = detectType(doc.original_name);
      const docId = `sqlite_${doc.id}_${doc.original_name.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 30)}`;

      const chunks = parseDocument(text, {
        docId,
        name: doc.original_name,
        type,
      });

      if (chunks.length > 0) {
        const added = await addDocuments(chunks);
        totalChunks += chunks.length;
        totalIndexed++;
        console.log(`[IDX] ✅ ${doc.original_name} → ${chunks.length} chunks`);
      } else {
        console.log(`[IDX] ⚠️  Sem chunks: ${doc.original_name}`);
      }
    } catch (err) {
      errors++;
      console.error(`[IDX] ❌ Erro em ${doc.original_name}: ${err.message}`);
    }
  }

  console.log(`\n╔════════════════════════════════════════════╗`);
  console.log(`║              ✅ INDEXAÇÃO COMPLETA          ║`);
  console.log(`╚════════════════════════════════════════════╝`);
  console.log(`   Documentos indexados: ${totalIndexed}/${docs.length}`);
  console.log(`   Total chunks: ${totalChunks}`);
  console.log(`   Erros: ${errors}`);
}

main().catch(console.error);
