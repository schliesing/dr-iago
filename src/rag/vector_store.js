/**
 * Qdrant Vector Store Manager for Dr. IAgo
 * Handles all vector operations with Qdrant
 */

const axios = require('axios');
const { generateBatchEmbeddings } = require('./embeddings');

// ─── CONFIG ──────────────────────────────────────────────────────────────
const QDRANT_URL = process.env.QDRANT_URL || 'http://localhost:6334';
const COLLECTION_NAME = 'driago_legal_kb';
const VECTOR_SIZE = parseInt(process.env.EMBEDDING_DIMENSIONS || '768'); // nomic-embed-text = 768

// ─── HTTP CLIENT ─────────────────────────────────────────────────────────
const client = axios.create({
  baseURL: QDRANT_URL,
  timeout: 30000,
  headers: { 'Content-Type': 'application/json' },
});

// ─── COSINE SIMILARITY ───────────────────────────────────────────────────
function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB) + 1e-10);
}

// ─── COLLECTION MANAGEMENT ────────────────────────────────────────────────

/**
 * Create the legal knowledge base collection if it doesn't exist
 */
async function initCollection() {
  try {
    // Check if collection exists
    const res = await client.get(`/collections/${COLLECTION_NAME}`);
    if (res.data?.result) {
      console.log(`[QDRANT] Coleção "${COLLECTION_NAME}" já existe`);
      return true;
    }
  } catch (err) {
    if (err.response?.status !== 404) {
      console.error(`[QDRANT] Erro ao verificar coleção: ${err.message}`);
      return false;
    }
  }

  try {
    // Create collection with HNSW index for fast ANN search
    await client.put(`/collections/${COLLECTION_NAME}`, {
      vectors: {
        size: VECTOR_SIZE,
        distance: 'Cosine',
      },
      optimizers_config: {
        indexing_threshold: 1000,
      },
      hnsw_config: {
        m: 16,
        ef_construct: 200,
      },
    });
    console.log(`[QDRANT] ✅ Coleção "${COLLECTION_NAME}" criada`);
    return true;
  } catch (err) {
    console.error(`[QDRANT] ❌ Erro ao criar coleção: ${err.message}`);
    return false;
  }
}

/**
 * Get collection info
 */
async function getCollectionInfo() {
  try {
    const res = await client.get(`/collections/${COLLECTION_NAME}`);
    return res.data?.result || null;
  } catch (err) {
    return null;
  }
}

/**
 * Delete the collection (for re-indexing)
 */
async function deleteCollection() {
  try {
    await client.delete(`/collections/${COLLECTION_NAME}`);
    console.log(`[QDRANT] ✅ Coleção "${COLLECTION_NAME}" deletada`);
    return true;
  } catch (err) {
    console.error(`[QDRANT] ❌ Erro ao deletar coleção: ${err.message}`);
    return false;
  }
}

// ─── CRUD OPERATIONS ─────────────────────────────────────────────────────

/**
 * Add documents to the collection
 * Expects chunks with text and metadata
 */
async function addDocuments(chunks, batchSize = 50) {
  const total = chunks.length;
  let indexed = 0;

  for (let i = 0; i < total; i += batchSize) {
    const batch = chunks.slice(i, i + batchSize);
    // Truncar textos longos antes de embeddar (nomic-embed-text context limit)
    const MAX_EMBED_CHARS = 1000;
    const texts = batch.map(c => c.text.length > MAX_EMBED_CHARS ? c.text.substring(0, MAX_EMBED_CHARS) : c.text);

    // Generate embeddings for batch
    const embeddings = await generateBatchEmbeddings(texts);

    // Prepare points for Qdrant — usar UUID-like IDs para evitar conflitos
    const baseId = Date.now() + i;
    const points = batch.map((chunk, j) => {
      const pointId = baseId + j;
      return {
        id: pointId,
        vector: embeddings[j],
        payload: {
          chunk_id: chunk.id || `chunk_${pointId}`,
          text: chunk.text,
          doc_id: chunk.docId || 'unknown',
          doc_name: chunk.docName || 'unknown',
          doc_type: chunk.docType || 'document',
          chunk_index: chunk.chunkIndex || j,
        },
      };
    });

    try {
      await client.put(`/collections/${COLLECTION_NAME}/points`, { points });
      indexed += batch.length;
      console.log(`[QDRANT] 📦 Indexados ${indexed}/${total} chunks`);
    } catch (err) {
      console.error(`[QDRANT] ❌ Erro no batch ${i}-${i+batch.length}: ${err.message}`);
    }
  }

  console.log(`[QDRANT] ✅ Total indexado: ${indexed} chunks`);
  return indexed;
}

/**
 * Search for relevant chunks
 */
async function search(query, topK = 5, filters = {}) {
  // Generate query embedding
  const { generateEmbedding } = require('./embeddings');
  const queryVector = await generateEmbedding(query);

  try {
    const searchBody = {
      vector: queryVector,
      limit: topK,
      with_payload: true,
      score_threshold: 0.3, // Minimum similarity score
    };

    // Add filters if provided
    if (filters.doc_type) {
      searchBody.filter = {
        key: 'doc_type',
        match: { value: filters.doc_type },
      };
    }

    const res = await client.post(
      `/collections/${COLLECTION_NAME}/points/search`,
      searchBody
    );

    const results = res.data?.result || [];

    return results.map(hit => ({
      id: hit.id,
      score: hit.score,
      text: hit.payload?.text || '',
      doc_name: hit.payload?.doc_name || 'unknown',
      doc_type: hit.payload?.doc_type || 'document',
      chunk_id: hit.payload?.chunk_id || String(hit.id),
    }));

  } catch (err) {
    console.error(`[QDRANT] ❌ Erro na busca: ${err.message}`);
    return [];
  }
}

/**
 * Search and rerank with diversity (from IAdvogado's advanced_rag)
 */
async function searchWithReranking(query, topK = 5, filters = {}) {
  // Get more results than needed for reranking
  const initialResults = await search(query, topK * 3, filters);

  if (initialResults.length === 0) return [];

  // Group by document to ensure diversity
  const byDoc = new Map();
  for (const result of initialResults) {
    const key = result.doc_name;
    if (!byDoc.has(key)) byDoc.set(key, []);
    byDoc.get(key).push(result);
  }

  // Pick best from each doc and rerank
  const reranked = [];
  for (const [docName, results] of byDoc) {
    // Sort by score within doc
    results.sort((a, b) => b.score - a.score);
    reranked.push(results[0]);
  }

  // Final sort by score
  reranked.sort((a, b) => b.score - a.score);

  return reranked.slice(0, topK);
}

/**
 * Get count of indexed documents
 */
async function getCount() {
  try {
    const res = await client.get(`/collections/${COLLECTION_NAME}`);
    return res.data?.result?.points_count || 0;
  } catch (err) {
    return 0;
  }
}

/**
 * Delete all points (for reindexing)
 */
async function clearAll() {
  try {
    await client.post(`/collections/${COLLECTION_NAME}/points/delete`, { filter: {} });
    console.log(`[QDRANT] ✅ Todos os pontos removidos`);
    return true;
  } catch (err) {
    console.error(`[QDRANT] ❌ Erro ao limpar: ${err.message}`);
    return false;
  }
}

// ─── EXPORTS ─────────────────────────────────────────────────────────────
module.exports = {
  initCollection,
  getCollectionInfo,
  deleteCollection,
  addDocuments,
  search,
  searchWithReranking,
  getCount,
  clearAll,
  cosineSimilarity,
  COLLECTION_NAME,
  VECTOR_SIZE,
};
