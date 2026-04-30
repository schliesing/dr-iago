---
name: rag
description: "Skill for the Rag area of driago. 25 symbols across 6 files."
---

# Rag

25 symbols | 6 files | Cohesion: 93%

## When to Use

- Working with code in `src/`
- Understanding how initCollection, addDocuments, search work
- Modifying rag-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `src/rag/knowledge_base.js` | readDocument, indexKnowledgeBase, addDocument, scanDirectory, scan (+3) |
| `src/rag/vector_store.js` | initCollection, addDocuments, search, searchWithReranking, clearAll (+1) |
| `src/rag/retriever.js` | expandLegalQuery, retrieve, formatContext, buildRagPrompt |
| `src/rag/embeddings.js` | generateEmbedding, generateBatchEmbeddings, parseDocument |
| `src/rag/rag_pipeline.js` | checkStatus, ragPipeline, enrichWithRag |
| `src/rag/indexer_cli.js` | main |

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `initCollection` | Function | `src/rag/vector_store.js` | 37 |
| `addDocuments` | Function | `src/rag/vector_store.js` | 107 |
| `search` | Function | `src/rag/vector_store.js` | 151 |
| `searchWithReranking` | Function | `src/rag/vector_store.js` | 197 |
| `clearAll` | Function | `src/rag/vector_store.js` | 240 |
| `readDocument` | Function | `src/rag/knowledge_base.js` | 104 |
| `indexKnowledgeBase` | Function | `src/rag/knowledge_base.js` | 139 |
| `addDocument` | Function | `src/rag/knowledge_base.js` | 208 |
| `generateEmbedding` | Function | `src/rag/embeddings.js` | 34 |
| `generateBatchEmbeddings` | Function | `src/rag/embeddings.js` | 97 |
| `parseDocument` | Function | `src/rag/embeddings.js` | 183 |
| `getCount` | Function | `src/rag/vector_store.js` | 228 |
| `checkStatus` | Function | `src/rag/rag_pipeline.js` | 125 |
| `scanDirectory` | Function | `src/rag/knowledge_base.js` | 45 |
| `scan` | Function | `src/rag/knowledge_base.js` | 48 |
| `detectType` | Function | `src/rag/knowledge_base.js` | 88 |
| `getStatus` | Function | `src/rag/knowledge_base.js` | 229 |
| `seedDefaultDocuments` | Function | `src/rag/knowledge_base.js` | 251 |
| `main` | Function | `src/rag/indexer_cli.js` | 48 |
| `expandLegalQuery` | Function | `src/rag/retriever.js` | 30 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `Main → DetectType` | intra_community | 6 |
| `Main → GetCount` | intra_community | 4 |
| `EnrichWithRag → ExpandLegalQuery` | intra_community | 4 |
| `EnrichWithRag → FormatContext` | intra_community | 4 |
| `AddDocument → GenerateEmbedding` | intra_community | 4 |
| `Main → InitCollection` | cross_community | 3 |
| `Main → ClearAll` | cross_community | 3 |
| `Main → ReadDocument` | cross_community | 3 |
| `SearchWithReranking → GenerateEmbedding` | intra_community | 3 |

## How to Explore

1. `gitnexus_context({name: "initCollection"})` — see callers and callees
2. `gitnexus_query({query: "rag"})` — find related execution flows
3. Read key files listed above for implementation details
