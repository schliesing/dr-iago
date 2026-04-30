/**
 * RAG Pipeline - Main RAG integration for Dr. IAgo
 * Orchestrates retrieval + generation for legal queries
 */

const { retrieve, buildRagPrompt } = require('./retriever');
const { getStatus } = require('./knowledge_base');

// ─── CONFIG ───────────────────────────────────────────────────────────────
const RAG_ENABLED = process.env.RAG_ENABLED !== 'false';
const RAG_TOP_K = parseInt(process.env.RAG_TOP_K || '3');
const RAG_MIN_SCORE = parseFloat(process.env.RAG_MIN_SCORE || '0.65'); // era 0.3 — muito permissivo

// ─── RAG PIPELINE ────────────────────────────────────────────────────────
/**
 * Main RAG function: retrieve + build enhanced prompt
 */
async function ragPipeline(userQuery, options = {}) {
  const {
    enabled = RAG_ENABLED,
    topK = RAG_TOP_K,
    injectContext = true,
  } = options;

  if (!enabled) {
    return { context: null, retrievalResults: null };
  }

  console.log(`[RAG] 🔍 Processando query: "${userQuery.substring(0, 80)}..."`);

  try {
    const retrievalResult = await retrieve(userQuery, {
      topK,
      useReranking: true,
    });

    if (!retrievalResult.results || retrievalResult.results.length === 0) {
      console.log('[RAG] ℹ️ Nenhum resultado encontrado na base');
      return {
        context: null,
        retrievalResults: null,
        stats: { totalFound: 0 },
      };
    }

    console.log(`[RAG] ✅ ${retrievalResult.results.length} fontes recuperadas`);
    console.log(`[RAG] 📊 Score médio: ${retrievalResult.stats.avgScore}`);
    console.log(`[RAG] 📚 Fontes: ${retrievalResult.stats.sources.join(', ')}`);

    return {
      context: injectContext ? retrievalResult.context : null,
      retrievalResults: retrievalResult.results,
      expandedQueries: retrievalResult.expandedQueries,
      stats: retrievalResult.stats,
    };

  } catch (err) {
    console.error(`[RAG] ❌ Erro no pipeline: ${err.message}`);
    return { context: null, retrievalResults: null, error: err.message };
  }
}

// ─── ENRICH SYSTEM PROMPT WITH RAG ───────────────────────────────────────
/**
 * Build the full system prompt with RAG context
 */
async function enrichWithRag(userQuery, baseSystemPrompt, options = {}) {
  const ragResult = await ragPipeline(userQuery, options);

  if (!ragResult.context) {
    // No RAG results - return base prompt
    return {
      prompt: baseSystemPrompt,
      ragEnabled: false,
      sources: [],
    };
  }

  const enrichedPrompt = buildRagPrompt(userQuery, ragResult.context, baseSystemPrompt);

  return {
    prompt: enrichedPrompt,
    ragEnabled: true,
    sources: ragResult.stats?.sources || [],
    stats: ragResult.stats,
  };
}

// ─── FORMAT SOURCES FOR WHATSAPP ─────────────────────────────────────────
/**
 * Format retrieved sources for WhatsApp display (short format)
 */
function formatSourcesForWhatsApp(retrievalResults) {
  if (!retrievalResults || retrievalResults.length === 0) {
    return '';
  }

  // Deduplicate by doc_name, keeping highest score per documento
  const docBest = new Map();
  for (const r of retrievalResults) {
    const existing = docBest.get(r.doc_name);
    if (!existing || r.score > existing.score) {
      docBest.set(r.doc_name, r);
    }
  }

  const emojiMap = {
    lei_14133: '⚖️',
    lei_8666: '📜',
    tcu: '🏛️',
    stj: '⚖️',
    stf: '🏛️',
    decreto: '📋',
    lc_123: '💼',
    lei_10520: '🔨',
    doutrina: '📚',
    modelo: '📝',
  };

  const lines = [];
  for (const r of docBest.values()) {
    const emoji = emojiMap[r.doc_type] || '📄';
    const score = (r.score * 100).toFixed(0);
    lines.push(`${emoji} ${r.doc_name} (${score}%)`);
  }

  return `\n\n📚 *Fontes consultadas:*\n${lines.join('\n')}`;
}

// ─── CHECK RAG STATUS ─────────────────────────────────────────────────────
/**
 * Get RAG system status
 */
async function checkStatus() {
  try {
    const kbStatus = await getStatus();
    return {
      ragEnabled: RAG_ENABLED,
      vectorDb: 'Qdrant',
      collection: kbStatus.collection,
      indexedChunks: kbStatus.totalChunks,
      indexedDocs: kbStatus.totalDocuments,
      byType: kbStatus.byType,
      ready: kbStatus.totalChunks > 0,
    };
  } catch (err) {
    return {
      ragEnabled: RAG_ENABLED,
      vectorDb: 'Qdrant',
      collection: 'driago_legal_kb',
      error: err.message,
      ready: false,
    };
  }
}

// ─── EXPORTS ─────────────────────────────────────────────────────────────
module.exports = {
  ragPipeline,
  enrichWithRag,
  formatSourcesForWhatsApp,
  checkStatus,
  RAG_ENABLED,
  RAG_TOP_K,
  RAG_MIN_SCORE,
};
