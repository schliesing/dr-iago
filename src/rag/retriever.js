/**
 * RAG Retriever - Core retrieval logic
 * Combines vector search with legal-specific filtering
 */

const { search, searchWithReranking } = require('./vector_store');

// ─── RETRIEVAL CONFIG ─────────────────────────────────────────────────────
const DEFAULT_TOP_K = 3;
const MIN_SCORE = parseFloat(process.env.RAG_MIN_SCORE || '0.65');
const CONTEXT_MAX_CHARS = 6000; // Max chars to inject into prompt

// ─── LEGAL CATEGORIES ─────────────────────────────────────────────────────
const LEGAL_CATEGORIES = {
  'lei_14133': 'Lei 14.133/2021 (Nova Lei de Licitações)',
  'lei_8666': 'Lei 8.666/93 (Licitações - Revogada)',
  'lc_123': 'Lei Complementar 123/2006 (ME/EPP)',
  'lei_10520': 'Lei 10.520/2002 (Pregão)',
  'tcu': 'Jurisprudência TCU',
  'stj': 'Jurisprudência STJ',
  'stf': 'Jurisprudência STF',
  'decreto': 'Decretos Regulamentadores',
  'in_seges': 'Instruções Normativas SEGES',
  'doutrina': 'Doutrina',
  'modelo': 'Modelos/Templates',
};

// ─── QUERY EXPANSION ─────────────────────────────────────────────────────
/**
 * Expand legal query with related terms
 */
function expandLegalQuery(query) {
  const expansions = {
    'dispensa': ['dispensa por valor', 'art. 75', 'emergencial', 'inexigibilidade'],
    'inexigibilidade': ['art. 74', 'fornecedor único', 'profissional especializado'],
    'pregão': ['pregao eletrônico', 'art. 4o', 'sessão', 'lances'],
    'contrato': ['ajuste', 'aditivo', 'reequilíbrio', 'reenquadramento'],
    'aditivo': ['alteração contratual', 'prorrogação', 'acréscimo', 'supressão'],
    'reequilíbrio': ['reequilibrio econômico-financeiro', 'reajuste', 'revisão'],
    'habilitação': ['habilitacao', 'documentação', 'qualificação técnica', 'certidões'],
    'impugnação': ['impugnacao', 'recurso', 'esclarecimento', 'questionamento'],
    'valor': ['preço', 'estimado', 'referência', 'pesquisa mercado', 'orçamento'],
    'prazo': ['vigência', 'execução', 'entrega', 'condições'],
    'multa': ['sanção', 'penalidade', 'advertência', 'nulidade'],
    'recurso': ['apelo', 'impugnação', 'manifestação', 'contrarrazões'],
    'segredo': ['sigilo', 'confidencial', 'reservado'],
    'ata': ['registro', 'arp', 'SRP', 'sistema registro preços'],
    ' SRP': ['sistema registro preços', 'ata', 'adesão'],
    ' RDC': ['regime diferenciado', 'contratações', 'inciso XXI'],
    'fiscal': ['fiscalização', 'acompanhamento', 'gestor', 'vistoria'],
    'rescisão': ['rescisorio', 'distrato', 'encerramento', 'distrato'],
  };

  const lowerQuery = query.toLowerCase();
  const expanded = [query];

  for (const [keyword, related] of Object.entries(expansions)) {
    if (lowerQuery.includes(keyword)) {
      expanded.push(...related);
    }
  }

  return [...new Set(expanded)];
}

// ─── RETRIEVE ─────────────────────────────────────────────────────────────
/**
 * Main retrieval function
 * Returns formatted context for the query
 */
async function retrieve(query, options = {}) {
  const {
    topK = DEFAULT_TOP_K,
    maxChars = CONTEXT_MAX_CHARS,
    useReranking = true,
    category = null,
  } = options;

  // Expand query with legal terms
  const expandedQueries = expandLegalQuery(query);
  console.log(`[RAG] 🔍 Query expandida: ${expandedQueries.length} variações`);

  let results = [];

  // Search with the original query only — expanded queries menambah latência
  // Sem reranking para velocidade (usa search direto)
  const searchFn = useReranking ? searchWithReranking : search;
  const hits = await searchFn(query, topK, category ? { doc_type: category } : {});
  results.push(...hits);

  // Deduplicate by chunk_id
  const seen = new Set();
  results = results.filter(r => {
    if (seen.has(r.chunk_id)) return false;
    seen.add(r.chunk_id);
    return true;
  });

  // Sort by score
  results.sort((a, b) => b.score - a.score);

  // Filter by minimum score
  const beforeFilter = results.length;
  results = results.filter(r => r.score >= MIN_SCORE);
  if (results.length < beforeFilter) {
    console.log(`[RAG] 🔽 Filtrados ${beforeFilter - results.length} resultados com score < ${MIN_SCORE}`);
  }

  // Limit to topK
  results = results.slice(0, topK);

  console.log(`[RAG] 📚 ${results.length} resultados encontrados`);

  // Format context
  const context = formatContext(results, maxChars);

  return {
    query,
    expandedQueries,
    results,
    context,
    stats: {
      totalFound: results.length,
      avgScore: results.length > 0
        ? (results.reduce((sum, r) => sum + r.score, 0) / results.length).toFixed(3)
        : 0,
      sources: [...new Set(results.map(r => r.doc_name))],
      categories: [...new Set(results.map(r => r.doc_type))],
    },
  };
}

// ─── FORMAT CONTEXT ───────────────────────────────────────────────────────
/**
 * Format retrieval results into a context string for the LLM
 */
function formatContext(results, maxChars = CONTEXT_MAX_CHARS) {
  if (!results || results.length === 0) {
    return '';
  }

  let context = `=== CONTEXTO JURÍDICO RELEVANTE ===

${results.map((r, i) => {
  const category = LEGAL_CATEGORIES[r.doc_type] || r.doc_type;
  return `[Fonte ${i + 1}] ${category}
Documento: ${r.doc_name}
Relevância: ${(r.score * 100).toFixed(1)}%

${r.text}

---`;
}).join('\n\n')}

=== FIM DO CONTEXTO ===

INSTRUÇÕES DE USO:
- As fontes acima são relevantes para a consulta jurídica
- Priorize cite a legislação e jurisprudência das fontes
- Se alguma fonte contradiz a consulta, mencione a divergência
- Para artigos específicos, cite o número do artigo quando disponível`;

  // Truncate if too long
  if (context.length > maxChars) {
    context = context.substring(0, maxChars) + '\n\n[... contexto truncado ...]';
  }

  return context;
}

// ─── BUILD RAG PROMPT ─────────────────────────────────────────────────────
/**
 * Build a RAG-enhanced prompt for the LLM
 */
function buildRagPrompt(userQuery, retrievedContext, systemPrompt) {
  const ragSystem = `Você é o Dr. IAgo, assistente jurídico especializado em licitações e contratos públicos.

${retrievedContext ? retrievedContext + '\n\n' : ''}CAPACIDADES ANALÍTICAS:
- Interprete o documento enviado pelo cliente (se houver)
- Use o contexto jurídico acima para fundamentar respostas
- Cite artigos específicos da legislação quando aplicável
- Indique riscos, irregularidades e recomendações
- Seja objetivo e técnico

LIMITAÇÕES:
- Se o contexto acima não cobrir a pergunta, diga claramente
- Não invente artigos ou dispositivos que não estejam nas fontes
- Quando houver divergência entre normas, priorize a mais recente`;

  return `${ragSystem}

${systemPrompt ? '\n\nCUSTOMIZAÇÕES DO SISTEMA:\n' + systemPrompt : ''}

--- MENSAGEM DO CLIENTE ---
${userQuery}
---`;
}

// ─── EXPORTS ─────────────────────────────────────────────────────────────
module.exports = {
  retrieve,
  expandLegalQuery,
  formatContext,
  buildRagPrompt,
  LEGAL_CATEGORIES,
  DEFAULT_TOP_K,
  CONTEXT_MAX_CHARS,
};
