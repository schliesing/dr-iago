/**
 * Embeddings Generator for RAG
 * Uses OpenAI-compatible API (DeepSeek/OpenAI) for embeddings
 */

const axios = require('axios');

// ─── EMBEDDING CONFIG ────────────────────────────────────────────────────
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || 'nomic-embed-text';
const EMBEDDING_API_URL = process.env.EMBEDDING_API_URL || 'http://localhost:11434/api/embeddings';
const EMBEDDING_API_KEY = ''; // Ollama não requer key

// ─── EMBEDDING DIMENSIONS ────────────────────────────────────────────────
const DIMENSIONS = {
  'nomic-embed-text': 768,
  'text-embedding-3-small': 1536,
  'text-embedding-3-large': 3072,
  'text-embedding-ada-002': 1536,
  'deepseek-embed': 1536,
};

// ─── CHUNK CONFIG ─────────────────────────────────────────────────────────
const CHUNK_SIZE = parseInt(process.env.RAG_CHUNK_SIZE || '800');
const CHUNK_OVERLAP = parseInt(process.env.RAG_CHUNK_OVERLAP || '150');

// ─── CACHE ──────────────────────────────────────────────────────────────
const embeddingCache = new Map();
const MAX_CACHE_SIZE = 500;

// ─── GENERATE EMBEDDING ──────────────────────────────────────────────────
/**
 * Generate embedding vector for a text
 * Supports both Ollama (local) and OpenAI-compatible APIs
 */
async function generateEmbedding(text, model = EMBEDDING_MODEL) {
  if (!text || text.trim().length === 0) {
    return new Array(DIMENSIONS[model] || 1536).fill(0);
  }

  // Normalize text
  const normalized = text.trim();

  // Check cache
  const cacheKey = `${model}:${normalized}`;
  if (embeddingCache.has(cacheKey)) {
    return embeddingCache.get(cacheKey);
  }

  // Manage cache size
  if (embeddingCache.size > MAX_CACHE_SIZE) {
    const firstKey = embeddingCache.keys().next().value;
    embeddingCache.delete(firstKey);
  }

  const isOllama = EMBEDDING_API_URL.includes('localhost:11434') || EMBEDDING_API_URL.includes('ollama');

  try {
    let embedding;

    if (isOllama) {
      // Ollama API format
      const response = await axios.post(
        EMBEDDING_API_URL,
        { model, prompt: normalized },
        { timeout: 60000 }
      );
      embedding = response.data.embedding;
    } else {
      // OpenAI-compatible API format
      const response = await axios.post(
        EMBEDDING_API_URL,
        { model, input: normalized },
        {
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${EMBEDDING_API_KEY}`,
          },
          timeout: 30000,
        }
      );
      embedding = response.data.data[0].embedding;
    }

    embeddingCache.set(cacheKey, embedding);
    console.log(`[EMB] ✅ Embedding gerado (${embedding.length} dims)`);
    return embedding;

  } catch (err) {
    console.error(`[EMB] ❌ Erro ao gerar embedding: ${err.message}`);
    return new Array(DIMENSIONS[model] || 1536).fill(0);
  }
}

// ─── GENERATE BATCH EMBEDDINGS ─────────────────────────────────────────
/**
 * Generate embeddings for multiple texts in batch
 */
async function generateBatchEmbeddings(texts, model = EMBEDDING_MODEL) {
  if (!texts || texts.length === 0) return [];

  const isOllama = EMBEDDING_API_URL.includes('localhost:11434') || EMBEDDING_API_URL.includes('ollama');

  // Ollama doesn't support batching - process sequentially
  if (isOllama) {
    const results = [];
    for (const text of texts) {
      const emb = await generateEmbedding(text, model);
      results.push(emb);
    }
    return results;
  }

  try {
    const response = await axios.post(
      EMBEDDING_API_URL,
      { model, input: texts.map(t => t.trim()).filter(t => t.length > 0) },
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${EMBEDDING_API_KEY}`,
        },
        timeout: 120000,
      }
    );

    const embeddings = response.data.data.map(item => item.embedding);
    console.log(`[EMB] ✅ Batch de ${embeddings.length} embeddings gerados`);
    return embeddings;

  } catch (err) {
    console.error(`[EMB] ❌ Erro no batch: ${err.message}`);
    return texts.map(() => new Array(DIMENSIONS[model] || 1536).fill(0));
  }
}

// ─── CHUNK TEXT ──────────────────────────────────────────────────────────
/**
 * Split text into overlapping chunks for embedding
 */
function chunkText(text, size = CHUNK_SIZE, overlap = CHUNK_OVERLAP) {
  if (!text) return [];

  const chunks = [];
  const sentences = text.match(/[^.!?。]+[.!?。]+/g) || [text];

  let currentChunk = '';
  let chunkIndex = 0;

  for (const sentence of sentences) {
    if ((currentChunk + sentence).length <= size) {
      currentChunk += sentence;
    } else {
      if (currentChunk.trim()) {
        chunks.push({
          id: `chunk_${chunkIndex}`,
          text: currentChunk.trim(),
          charStart: text.indexOf(currentChunk),
          charEnd: text.indexOf(currentChunk) + currentChunk.length,
        });
        chunkIndex++;
      }
      // Overlap: keep last part
      currentChunk = currentChunk.slice(-overlap) + sentence;
    }
  }

  // Last chunk
  if (currentChunk.trim()) {
    chunks.push({
      id: `chunk_${chunkIndex}`,
      text: currentChunk.trim(),
      charStart: text.indexOf(currentChunk),
      charEnd: text.indexOf(currentChunk) + currentChunk.length,
    });
  }

  return chunks;
}

// ─── PARSE DOCUMENT ──────────────────────────────────────────────────────
/**
 * Parse text content and create chunks with metadata
 */
function parseDocument(content, metadata = {}) {
  if (!content) return [];

  // Try split by double newline (paragraphs), then single newline, then sentence
  let paragraphs = content.split(/\n\n+/).filter(p => p.trim().length > 50);
  if (paragraphs.length <= 2) {
    paragraphs = content.split(/\n/).filter(p => p.trim().length > 80);
  }
  // If still too few, split by sentence-ending punctuation
  if (paragraphs.length <= 2 && content.length > 2000) {
    paragraphs = content.match(/[^.!?]{20,}[.!?]+/g) || [content];
  }

  // Truncate oversized paragraphs before chunking (nomic-embed-text context limit ~2048 tokens)
  const MAX_PARA_CHARS = 2000;
  const truncatedParas = paragraphs.map(p => p.length > MAX_PARA_CHARS ? p.substring(0, MAX_PARA_CHARS) + ' [trecho truncado]' : p);

  const chunks = [];
  let currentText = '';
  let chunkIndex = 0;

  for (const para of truncatedParas) {
    if ((currentText + '\n\n' + para).length <= CHUNK_SIZE) {
      currentText += (currentText ? '\n\n' : '') + para;
    } else {
      if (currentText.trim()) {
        chunks.push({
          id: `chunk_${metadata.docId || 'doc'}_${chunkIndex}`,
          text: currentText.trim(),
          docId: metadata.docId || 'unknown',
          docName: metadata.name || 'unknown',
          docType: metadata.type || 'unknown',
          chunkIndex,
        });
        chunkIndex++;
      }
      currentText = para;
    }
  }

  // Final chunk
  if (currentText.trim()) {
    chunks.push({
      id: `chunk_${metadata.docId || 'doc'}_${chunkIndex}`,
      text: currentText.trim(),
      docId: metadata.docId || 'unknown',
      docName: metadata.name || 'unknown',
      docType: metadata.type || 'unknown',
      chunkIndex,
    });
  }

  return chunks;
}

// ─── CLEAR CACHE ─────────────────────────────────────────────────────────
function clearCache() {
  embeddingCache.clear();
  console.log('[EMB] Cache de embeddings limpo');
}

// ─── EXPORTS ─────────────────────────────────────────────────────────────
module.exports = {
  generateEmbedding,
  generateBatchEmbeddings,
  chunkText,
  parseDocument,
  clearCache,
  CHUNK_SIZE,
  CHUNK_OVERLAP,
  EMBEDDING_MODEL,
};
