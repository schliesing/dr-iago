#!/usr/bin/env node
/**
 * CLI para indexar a base jurídica do Dr. IAgo
 * Uso: node scripts/index_knowledge_base.js [--reindex] [--seed]
 */

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { indexKnowledgeBase, seedDefaultDocuments, getStatus } = require('./knowledge_base');
const { checkStatus } = require('./rag_pipeline');

// ─── PARSE ARGS ─────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const reindex = args.includes('--reindex') || args.includes('-r');
const seed = args.includes('--seed') || args.includes('-s');
const status = args.includes('--status') || args.includes('--info');
const help = args.includes('--help') || args.includes('-h');

// ─── HELP ──────────────────────────────────────────────────────────────────
if (help) {
  console.log(`
📚 Indexador da Base Jurídica - Dr. IAgo

Uso:
  node src/rag/indexer_cli.js [opções]

Opções:
  --seed       Criar documentos-base com conteúdo jurídico
  --reindex    Limpar e reindexar toda a base
  --status     Mostrar status atual da base
  --help       Mostrar esta ajuda

Exemplos:
  # Indexar documentos existentes
  node src/rag/indexer_cli.js

  # Criar seed + indexar
  node src/rag/indexer_cli.js --seed

  # Reindexar tudo do zero
  node src/rag/indexer_cli.js --reindex --seed

  # Ver status
  node src/rag/indexer_cli.js --status
`);
  process.exit(0);
}

// ─── MAIN ───────────────────────────────────────────────────────────────────
async function main() {
  console.log('╔════════════════════════════════════════════╗');
  console.log('║  📚 Indexador da Base Jurídica - Dr. IAgo  ║');
  console.log('╚════════════════════════════════════════════╝\n');

  // Status
  if (status) {
    const kbStatus = await checkStatus();
    console.log('📊 Status da Base RAG:');
    console.log(`   RAG Habilitado: ${kbStatus.ragEnabled ? '✅' : '❌'}`);
    console.log(`   Vector DB: ${kbStatus.vectorDb}`);
    console.log(`   Collection: ${kbStatus.collection}`);
    console.log(`   Chunks indexados: ${kbStatus.indexedChunks || 0}`);
    console.log(`   Documentos: ${kbStatus.indexedDocs || 0}`);
    console.log(`   Pronto: ${kbStatus.ready ? '✅' : '❌'}`);

    if (kbStatus.byType) {
      console.log('\n   Por categoria:');
      for (const [type, count] of Object.entries(kbStatus.byType)) {
        console.log(`     - ${type}: ${count}`);
      }
    }

    if (kbStatus.error) {
      console.log(`\n   ⚠️  Erro: ${kbStatus.error}`);
    }
    return;
  }

  // Seed default documents
  if (seed) {
    console.log('🌱 Criando documentos-base...\n');
    const count = await seedDefaultDocuments();
    console.log(`✅ ${count} documentos-base criados\n`);
  }

  // Index
  console.log('🚀 Indexando base jurídica...\n');
  const result = await indexKnowledgeBase({
    reindex,
    verbose: true,
  });

  console.log('\n╔════════════════════════════════════════════╗');
  console.log('║              ✅ INDEXAÇÃO COMPLETA          ║');
  console.log('╚════════════════════════════════════════════╝');
  console.log(`   Documentos processados: ${result.documents}`);
  console.log(`   Chunks gerados: ${result.chunks}`);
  console.log(`   Ignorados: ${result.skipped}`);
  console.log('');
  console.log('💡 Para testar:');
  console.log('   node src/rag/indexer_cli.js --status');
}

main().catch(console.error);
