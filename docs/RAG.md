# RAG - Retrieval Augmented Generation

## O que é?

O sistema **RAG** permite que o Dr. IAgo busque automaticamente na base jurídica antes de responder. Isso significa que ele não depende mais só do system prompt fixo — ele encontra legislação, jurisprudência e doutrina relevantes **em tempo real**.

## Arquitetura

```
Cliente WhatsApp
      │
      ▼
┌─────────────────┐
│ Dr. IAgo (WA)  │
└────────┬────────┘
         │ mensagem
         ▼
┌─────────────────┐
│  DeepSeek Chat │◄── system prompt + documento (se houver)
└────────┬────────┘
         │
    + RAG (ativa)
         │
         ▼
┌─────────────────┐     768-dim      ┌─────────────────┐
│ Ollama Embedding│ ──────────────► │ Qdrant Vector DB│
│ (nomic-embed)   │  768 floats      │ driago_legal_kb │
└─────────────────┘                  └─────────────────┘
         │
         ▼
┌─────────────────┐
│ Base Jurídica   │ ◄── 8 documentos seed
│ /data/knowledge │     (Lei 14.133, valores, princípios,
└─────────────────┘     modalidades, inexigibilidade,
                         habilitação, contratos, recursos,
                         penalidades)
```

## Arquivos

| Arquivo | Função |
|---------|--------|
| `src/rag/index.js` | Entry point — exporta tudo |
| `src/rag/embeddings.js` | Gera vetores com Ollama (nomic-embed-text) |
| `src/rag/vector_store.js` | Gerencia Qdrant (insert, search, rerank) |
| `src/rag/retriever.js` | Lógica de retrieval + query expansion |
| `src/rag/knowledge_base.js` | Scan, parse, index de documentos |
| `src/rag/rag_pipeline.js` | Pipeline principal (retrieve → prompt) |
| `src/rag/indexer_cli.js` | CLI para indexar a base |
| `data/knowledge/seeds/` | Documentos-base jurídicos |

## Comandos

```bash
# Ver status do RAG
node src/rag/indexer_cli.js --status

# Indexar documentos
node src/rag/indexer_cli.js

# Reindexar tudo do zero
node src/rag/indexer_cli.js --reindex

# Criar seed + indexar
node src/rag/indexer_cli.js --seed --reindex
```

## API (Dashboard Admin)

| Método | Endpoint | Descrição |
|--------|----------|-----------|
| GET | `/api/rag/status` | Status da base RAG |
| POST | `/api/rag/index` | Indexar/reindexar base |
| POST | `/api/rag/seed` | Criar documentos-base |
| POST | `/api/rag/add` | Adicionar documento |
| POST | `/api/rag/test` | Testar busca RAG |
| PUT | `/api/rag/toggle` | Ligar/desligar RAG |
| POST | `/api/rag/agent/test` | Testar agente completo |

## Configuração (.env)

```bash
RAG_ENABLED=true           # Ligar/desligar RAG
RAG_AUTO_INJECT=true       # Auto-injetar contexto nas mensagens
EMBEDDING_MODEL=nomic-embed-text
EMBEDDING_DIMENSIONS=768
EMBEDDING_API_URL=http://localhost:11434/api/embeddings
QDRANT_URL=http://localhost:6334
RAG_TOP_K=4                # Quantos resultados buscar
RAG_CHUNK_SIZE=800         # Tamanho de cada chunk
RAG_CHUNK_OVERLAP=150      # Overlap entre chunks
```

## Como funciona

1. **Query Expansion** — expande a query com termos jurídicos relacionados
2. **Embedding** — gera vetor 768-dim com Ollama (nomic-embed-text)
3. **Search** — busca no Qdrant os K chunks mais similares (cosine similarity)
4. **Re-ranking** — prioriza documentos diversos (não pega 5 do mesmo)
5. **Context Injection** — injeta texto das fontes no system prompt
6. **Generation** — DeepSeek responde com base no contexto injetado
7. **Sources** — appenda as fontes consultadas na resposta

## Expandir a base

Adicione documentos em `data/knowledge/` (ou subpastas):

```
data/knowledge/
├── seeds/           ← documentos-base (não apagar)
├── jurisprudencia/  ← acórdãos, decisões
├── leis/            ← leis específicas
├── modelos/         ← templates de parecer
└── doutrina/        ← artigos, manuais
```

Depois reindexe:
```bash
node src/rag/indexer_cli.js --reindex
```

## Dependências

- **Ollama** rodando em `localhost:11434` com modelo `nomic-embed-text`
- **Qdrant** rodando em `localhost:6334`

Para instalar o modelo de embedding:
```bash
curl http://localhost:11434/api/create -X POST \
  -d '{"name":"nomic-embed-text","from":"nomic-embed-text","keep_alive":"24h"}'
```
