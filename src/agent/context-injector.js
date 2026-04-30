/**
 * Dr. IAgo Context Injector v2
 * Manages per-phone document context lifecycle
 * NOW PERSISTENT: survives restarts via SQLite
 */

const { getDb } = require('../db/database');

// In-memory cache for fast reads (SQLite is source of truth)
const contextCache = new Map();

// ─── CREATE DOCUMENT CONTEXT ──────────────────────────────────────────────
function createDocumentContext(documentInfo) {
  if (!documentInfo || !documentInfo.content) {
    return '';
  }

  return `
=== DOCUMENTO ENVIADO PELO CLIENTE ===
Arquivo: ${documentInfo.filename}
Data: ${new Date(documentInfo.extractedAt).toLocaleString('pt-BR')}
Tamanho original: ${documentInfo.originalSize} caracteres

CONTEÚDO DO DOCUMENTO:
${documentInfo.content}

=== FIM DO DOCUMENTO ===

INSTRUÇÃO: Analise EXCLUSIVAMENTE o conteúdo acima. Responda com base no que está no documento. Cite trechos específicos quando aplicável. Se não encontrar algo no documento, responda com o que for encontrado — não diga "não encontrei".
`;
}

// ─── INJECT DOCUMENT CONTEXT ─────────────────────────────────────────────
function injectDocumentContext(phone, documentInfo) {
  if (!phone || !documentInfo) {
    console.warn('[CTX] Tentativa de injetar contexto invalido');
    return null;
  }

  const docContext = createDocumentContext(documentInfo);
  const now = new Date().toISOString();
  // Context expires in 2 hours
  const expiresAt = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();

  const db = getDb();

  // Persist to SQLite
  db.prepare(`
    INSERT OR REPLACE INTO document_contexts (phone, filename, context, size, injected_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(phone, documentInfo.filename, docContext, docContext.length, now, expiresAt);

  // Update in-memory cache
  contextCache.set(phone, {
    filename: documentInfo.filename,
    context: docContext,
    injected_at: now,
    expires_at: expiresAt,
    size: docContext.length
  });

  console.log(`[CTX] ✅ Contexto injetado para ${phone}: ${documentInfo.filename} (${docContext.length} chars) - expira em 2h`);
  return docContext;
}

// ─── GET INJECTED CONTEXT ───────────────────────────────────────────────
function getInjectedContext(phone) {
  if (!phone) return null;

  // Check in-memory cache first
  if (contextCache.has(phone)) {
    const entry = contextCache.get(phone);
    // Check if expired
    if (entry.expires_at && new Date(entry.expires_at) < new Date()) {
      console.log(`[CTX] Contexto expirado para ${phone}, limpando...`);
      clearDocumentContext(phone);
      return null;
    }
    return entry.context;
  }

  // Load from SQLite
  const db = getDb();
  const row = db.prepare('SELECT * FROM document_contexts WHERE phone = ?').get(phone);

  if (!row) {
    return null;
  }

  // Check if expired
  if (row.expires_at && new Date(row.expires_at) < new Date()) {
    console.log(`[CTX] Contexto expirado (SQLite) para ${phone}, limpando...`);
    clearDocumentContext(phone);
    return null;
  }

  // Populate in-memory cache
  contextCache.set(phone, {
    filename: row.filename,
    context: row.context,
    injected_at: row.injected_at,
    expires_at: row.expires_at,
    size: row.size
  });

  console.log(`[CTX] Contexto restaurado do SQLite para ${phone}: ${row.filename}`);
  return row.context;
}

// ─── ENRICH SYSTEM PROMPT ─────────────────────────────────────────────────
function enrichSystemPrompt(baseSystemPrompt, phone, userQuestion = null) {
  const documentContext = getInjectedContext(phone);

  if (!documentContext) {
    return baseSystemPrompt;
  }

  // Se o usuário fez uma PERGUNTA sobre o documento já processado:
  // usa extração inteligente por palavras-chave
  if (userQuestion && userQuestion.trim().length > 3) {
    const { queryDocument } = require('./document-processor');
    const queryResult = queryDocument(phone, userQuestion);
    if (queryResult && queryResult.passages) {
      const smartContext = `
=== DOCUMENTO ENVIADO PELO CLIENTE ===
Arquivo: ${queryResult.filename}

--- TRECHOS RELEVANTES PARA SUA PERGUNTA ---
${queryResult.passages}

--- RESUMO DO DOCUMENTO ---
${queryResult.summary}

=== FIM DO DOCUMENTO ===

INSTRUÇÃO: Responda APENAS com base nos trechos acima. CiteTextos específicos do documento quando aplicável.`;
      console.log(`[CTX] 🔍 Contexto inteligente injetado para pergunta: "${userQuestion.substring(0, 50)}..."`);
      return `${baseSystemPrompt}\n\n${smartContext}`;
    }
  }

  // Fallback: contexto padrão (primeira vez que envia documento)
  return `${baseSystemPrompt}\n\n${documentContext}`;
}

// ─── CLEAR DOCUMENT CONTEXT ──────────────────────────────────────────────
function clearDocumentContext(phone) {
  if (!phone) return;

  // Remove from SQLite
  const db = getDb();
  db.prepare('DELETE FROM document_contexts WHERE phone = ?').run(phone);

  // Remove from memory
  if (contextCache.has(phone)) {
    const removed = contextCache.get(phone);
    contextCache.delete(phone);
    console.log(`[CTX] ✅ Contexto removido para ${phone}: ${removed.filename}`);
  }
}

// ─── GET CONTEXT INFO ────────────────────────────────────────────────────
function getContextInfo(phone) {
  // Try cache first
  if (contextCache.has(phone)) {
    const entry = contextCache.get(phone);
    return {
      phone,
      hasContext: true,
      filename: entry.filename,
      size: entry.size,
      injected_at: entry.injected_at,
      expires_at: entry.expires_at,
      source: 'memory'
    };
  }

  // Try SQLite
  const db = getDb();
  const row = db.prepare('SELECT * FROM document_contexts WHERE phone = ?').get(phone);

  if (!row) {
    return { phone, hasContext: false };
  }

  return {
    phone,
    hasContext: true,
    filename: row.filename,
    size: row.size,
    injected_at: row.injected_at,
    expires_at: row.expires_at,
    source: 'sqlite'
  };
}

// ─── HAS DOCUMENT CONTEXT ──────────────────────────────────────────────
function hasDocumentContext(phone) {
  return getInjectedContext(phone) !== null;
}

// ─── CLEAR ALL CONTEXTS ──────────────────────────────────────────────────
function clearAllContexts() {
  const db = getDb();
  const count = db.prepare('SELECT COUNT(*) as c FROM document_contexts').get().c;
  db.prepare('DELETE FROM document_contexts').run();
  contextCache.clear();
  console.log(`[CTX] Todos os ${count} contextos foram removidos`);
}

// ─── EXPIRE OLD CONTEXTS (call periodically) ─────────────────────────────
function cleanupExpiredContexts() {
  const db = getDb();
  const result = db.prepare('DELETE FROM document_contexts WHERE expires_at IS NOT NULL AND expires_at < ?').run(new Date().toISOString());
  if (result.changes > 0) {
    console.log(`[CTX] ${result.changes} contextos expirados removidos`);
  }
  // Clear from memory too
  for (const [phone, entry] of contextCache.entries()) {
    if (entry.expires_at && new Date(entry.expires_at) < new Date()) {
      contextCache.delete(phone);
    }
  }
}

// ─── EXPORTS ──────────────────────────────────────────────────────────────
module.exports = {
  createDocumentContext,
  injectDocumentContext,
  getInjectedContext,
  enrichSystemPrompt,
  clearDocumentContext,
  getContextInfo,
  hasDocumentContext,
  clearAllContexts,
  cleanupExpiredContexts
};
