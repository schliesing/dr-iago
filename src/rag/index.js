/**
 * RAG Module Entry Point
 * Central export for all RAG functionality
 */

const embeddings = require('./embeddings');
const vectorStore = require('./vector_store');
const retriever = require('./retriever');
const knowledgeBase = require('./knowledge_base');
const ragPipeline = require('./rag_pipeline');

module.exports = {
  // Core modules
  embeddings,
  vectorStore,
  retriever,
  knowledgeBase,
  ragPipeline,

  // Convenience exports
  generateEmbedding: embeddings.generateEmbedding,
  chunkText: embeddings.chunkText,
  parseDocument: embeddings.parseDocument,

  // Retrieval
  retrieve: retriever.retrieve,
  search: vectorStore.search,
  searchWithReranking: vectorStore.searchWithReranking,

  // Knowledge base
  indexKnowledgeBase: knowledgeBase.indexKnowledgeBase,
  addDocument: knowledgeBase.addDocument,
  getStatus: knowledgeBase.getStatus,
  seedDefaultDocuments: knowledgeBase.seedDefaultDocuments,

  // RAG pipeline
  ragPipeline: ragPipeline.ragPipeline,
  enrichWithRag: ragPipeline.enrichWithRag,
  formatSourcesForWhatsApp: ragPipeline.formatSourcesForWhatsApp,
  checkStatus: ragPipeline.checkStatus,
};
