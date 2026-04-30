/**
 * MiniMax API — DR.IAGO
 * Usa MiniMax M2.7 via API Anthropic-compatible.
 */
const axios = require('axios');
const { getDb } = require('../db/database');
const { enrichSystemPrompt, clearDocumentContext, hasDocumentContext } = require('./context-injector');
const { ragPipeline } = require('../rag/rag_pipeline');

const MAX_HISTORY = 50;

// ─── GREETING DETECTION ───────────────────────────────────────────────────
const GREETING_PATTERNS = [
  /^(oi|olá|ola|olá!|ola!|oi!|eae|e aí|eai|éaí|eaí|hey|hi|hello|yo|bom dia|boa tarde|boa noite|td bem|tudo bem|td bom|tudo bom|como vai|como vai\?|como tá|tudo certo|blz|beleza|salve|opa|e aí\b)/i,
  /^.{0,5}$/, // very short messages (0-5 chars) — almost certainly greetings
];

function isGreeting(text) {
  if (!text) return false;
  const trimmed = text.trim();
  if (GREETING_PATTERNS[0].test(trimmed)) return true;
  if (GREETING_PATTERNS[1].test(trimmed)) return true;
  return false;
}

// ─── TYPING NOTIFICATION ─────────────────────────────────────────────────
// Enviado pelo caller via sendTyping(phone) do baileys-client
// Esta função agora é controlada pelo webhooks.js diretamente
const MAX_KNOWLEDGE_CHARS = 8000;

// ─── MINIMAX CONFIG ──────────────────────────────────────────────────────────
const MINIMAX_API_KEY = process.env.MINIMAX_API_KEY || '';
const MINIMAX_BASE_URL = 'https://api.minimax.io/anthropic';
const MINIMAX_MODEL = 'MiniMax-M2.7';

if (!MINIMAX_API_KEY) {
  console.error('[MINIMAX] ❌ MINIMAX_API_KEY não encontrada no .env!');
}

// ─── TTS CONFIG ─────────────────────────────────────────────────────────────
const TTS_ENABLED = process.env.TTS_ENABLED === 'true';
const TTS_API_KEY = process.env.MINIMAX_API_KEY || '';
const TTS_URL = 'https://api.minimax.io/v1/t2a_v2';
const TTS_VOICE_ID = process.env.TTS_VOICE_ID || 'female-tianmei';
const TTS_MODEL = 'speech-02-hd';
const TTS_MAX_CHARS = 500; // limite por chunk de áudio

// ─── SYSTEM PROMPT ──────────────────────────────────────────────────────────
async function getSystemPrompt() {
  const db = getDb();
  const config = db.prepare("SELECT value FROM system_config WHERE key = 'system_prompt'").get();
  return config ? config.value : '';
}

// ─── FIRST CONTACT CHECK ───────────────────────────────────────────────────
function isFirstContact(phone) {
  const db = getDb();
  // Normalize: remove @c.us suffix if present
  const normalized = String(phone).replace(/@c\.us$/, '');
  const row = db.prepare("SELECT COUNT(*) as c FROM conversations WHERE phone = ? OR phone = ?").get(normalized, normalized + '@c.us');
  return row.c === 0;
}

// ─── KEYWORD EXTRACTION ───────────────────────────────────────────────────
function extractKeywords(text) {
  const stopWords = new Set(['o','a','os','as','um','uma','de','da','do','em','no','na','por','para','com','sem','ao','à','e','é','que','se','não','nao','sim','mas','ou','como','mais','muito','já','também','tem','são','foi','ser','ter','esse','essa','este','esta','isso','isto','quem','qual','quando','onde','porque']);
  const words = text.toLowerCase()
    .replace(/[^\w\sáàâãéêíóôõúüç]/gi, ' ')
    .split(/\s+/)
    .filter(w => w.length > 3 && !stopWords.has(w));
  return [...new Set(words)].slice(0, 8);
}

// ─── KNOWLEDGE CONTEXT (FALLBACK) ─────────────────────────────────────────
function getKnowledgeContext(userMessage) {
  if (!userMessage) {
    return getRecentKnowledge();
  }

  const keywords = extractKeywords(userMessage);
  if (!keywords.length) {
    return getRecentKnowledge();
  }

  const db = getDb();
  const searchTerms = keywords.map(k => `%${k}%`);
  const caseClauses = keywords.map(() => 'CASE WHEN content LIKE ? THEN 1 ELSE 0 END').join(' + ');
  const whereClause = searchTerms.map(() => 'content LIKE ?').join(' OR ');

  const docs = db.prepare(`
    SELECT original_name, content,
           (${caseClauses}) as relevance
    FROM knowledge_docs
    WHERE ${whereClause}
    ORDER BY relevance DESC, uploaded_at DESC
    LIMIT 5
  `).all(...[...searchTerms, ...searchTerms]);

  if (!docs.length) {
    return getRecentKnowledge();
  }

  let context = '\n\n--- BASE DE CONHECIMENTO (busca por: ' + keywords.join(', ') + ') ---\n';
  let totalChars = 0;

  for (const doc of docs) {
    const excerpt = doc.content.substring(0, 2500);
    if (totalChars + excerpt.length > MAX_KNOWLEDGE_CHARS) break;
    context += `\n[${doc.original_name}]:\n${excerpt}\n`;
    totalChars += excerpt.length;
  }

  console.log(`[KNOW] Busca por "${keywords.join(', ')}" → ${docs.length} docs encontrados`);
  return context;
}

function getRecentKnowledge() {
  const db = getDb();
  const docs = db.prepare("SELECT original_name, content FROM knowledge_docs ORDER BY uploaded_at DESC LIMIT 5").all();
  if (!docs.length) return '';

  let context = '\n\n--- BASE DE CONHECIMENTO ---\n';
  let totalChars = 0;

  for (const doc of docs) {
    const excerpt = doc.content.substring(0, 2500);
    if (totalChars + excerpt.length > MAX_KNOWLEDGE_CHARS) break;
    context += `\n[${doc.original_name}]:\n${excerpt}\n`;
    totalChars += excerpt.length;
  }

  return context;
}

// ─── CONVERSATION HISTORY ──────────────────────────────────────────────────
function getConversationHistory(phone) {
  const db = getDb();
  const normalized = String(phone).replace(/@c\.us$/, '');
  const rows = db.prepare(
    "SELECT role, content FROM conversations WHERE phone = ? OR phone = ? ORDER BY created_at DESC LIMIT ?"
  ).all(normalized, normalized + '@c.us', MAX_HISTORY);
  return rows.reverse();
}

function saveMessage(phone, role, content) {
  const db = getDb();
  const normalized = String(phone).replace(/@c\.us$/, '');
  db.prepare("INSERT INTO conversations (phone, role, content) VALUES (?, ?, ?)").run(normalized, role, content);
  db.prepare(`
    DELETE FROM conversations WHERE phone = ? AND id NOT IN (
      SELECT id FROM conversations WHERE phone = ? ORDER BY created_at DESC LIMIT 50
    )
  `).run(normalized, normalized);
}

// ─── TEXT CLEANING ────────────────────────────────────────────────────────
function removeAsterisks(text) {
  if (!text) return text;
  const original = text;
  const cleaned = text.replace(/\*/g, '');
  if (original !== cleaned) {
    console.log(`[CLEAN] Asteriscos removidos (${original.length} → ${cleaned.length} chars)`);
  }
  return cleaned;
}

/**
 * Converte markdown (##, ###, **, -, *, >, __) para formato WhatsApp.
 * ##título → **TÍTULO** (negrito)
 * ###sub → *Subtítulo* (itálico)
 * **bold** → *bold* (asteriscos → itálico WhatsApp)
 * - item → • item (liste com bullets)
 * > citação → ↳ citação
 * __underline__ → _underline_
 * ``` ``` → removes code blocks
 * --- → ═══ (separador visual)
 */
function markdownToWhatsApp(text) {
  if (!text) return text;
  let t = text;

  // Código e blocos de código → remove
  t = t.replace(/```[\s\S]*?```/g, '');
  t = t.replace(/`[^`]+`/g, '');

  // Separadores → linha visual
  t = t.replace(/^---+$/gm, '══════════════════');
  t = t.replace(/^\*\*\*+$/gm, '══════════════════');

  // Títulos Markdown → negrito tudo maiúsculas
  // ## TÍTULO → **TÍTULO**
  t = t.replace(/^#{1,3}\s+(.+)$/gm, (_, title) => '**' + title.trim().toUpperCase() + '**');

  // Negrito **texto** → *texto* (WhatsApp usa * pra itálico, _ pra negrito não existe)
  t = t.replace(/\*\*(.+?)\*\*/g, '*$1*');

  // Itálico *texto* ou _texto_ → *texto*
  t = t.replace(/\*(.+?)\*/g, '*$1*');
  t = t.replace(/_([^_]+)_/g, '*$1*');

  // Listas: - item ou * item → • item
  t = t.replace(/^[\s]*[-*•]\s+/gm, '• ');

  // Citação > texto → ↳ texto
  t = t.replace(/^>\s*/gm, '↳ ');

  // Múltiplas quebras de linha → no máximo 2
  t = t.replace(/\n{3,}/g, '\n\n');

  // Linha única vazia com espaços → limpa
  t = t.replace(/^[ \t]+$/gm, '');

  // Espaços extras
  t = t.replace(/ {2,}/g, ' ');

  return t.trim();
}

function cleanText(text) {
  if (!text) return text;
  const original = text;
  let cleaned = text.normalize('NFC');
  cleaned = cleaned.replace(/[\u4e00-\u9fff\u3000-\u303f\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af\u1100-\u11ff\u3130-\u318f]+/g, '');
  cleaned = cleaned.replace(/[📌✅👍👎🤖✔✗✓✗🔔🔕🔵🔴🟢]+/g, '');
  // Colapsa ESPAÇOS (não tabs/carriage returns) — preserva quebras de linha
  cleaned = cleaned.replace(/ {2,}/g, ' ');  // 2+ espaços → 1 espaço
  cleaned = cleaned.replace(/[\t\r]{2,}/g, '\t');  // tabs/carriage returns redundantes
  cleaned = cleaned.trim();
  if (original !== cleaned) {
    console.log(`[CLEAN] Texto limpo (${original.length} → ${cleaned.length} chars)`);
  }
  return cleaned;
}

// ─── CIRCUIT BREAKER ─────────────────────────────────────────────────────────
const CIRCUIT = {
  failures: 0,
  state: 'CLOSED', // CLOSED | OPEN | HALF_OPEN
  opensAt: 0,
  RESET_AFTER_MS: 30000, // 30s até tentar novamente
  FAIL_THRESHOLD: 5,
  MAX_RETRIES: 2,
};

function circuitCall(fn) {
  const now = Date.now();
  if (CIRCUIT.state === 'OPEN') {
    if (now < CIRCUIT.opensAt) {
      throw new Error('CIRCUIT_OPEN');
    }
    CIRCUIT.state = 'HALF_OPEN';
    console.log('[CIRCUIT] 🔶 HALF_OPEN — tentando recuperação...');
  }

  return fn().catch(err => {
    CIRCUIT.failures++;
    console.warn(`[CIRCUIT] ❌ Falha ${CIRCUIT.failures}/${CIRCUIT.FAIL_THRESHOLD}`);
    if (CIRCUIT.failures >= CIRCUIT.FAIL_THRESHOLD || err.message === 'CIRCUIT_OPEN') {
      CIRCUIT.state = 'OPEN';
      CIRCUIT.opensAt = now + CIRCUIT.RESET_AFTER_MS;
      console.error('[CIRCUIT] 🔴 OPEN — descansando 30s');
    }
    throw err;
  });
}

function circuitReset() {
  if (CIRCUIT.state === 'HALF_OPEN') {
    CIRCUIT.failures = 0;
    CIRCUIT.state = 'CLOSED';
    console.log('[CIRCUIT] 🟢 CLOSED — recuperação confirmada');
  }
}

// ─── MINIMAX API CALL ─────────────────────────────────────────────────────
async function callMiniMaxWithRetry(messages, maxTokens, maxRetries = 2) {
  let lastError;

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    try {
      console.log(`[MINIMAX] Tentativa ${attempt}/${maxRetries + 1} de chamar API...`);

      const response = await circuitCall(() =>
        axios.post(
          `${MINIMAX_BASE_URL}/v1/messages`,
          {
            model: MINIMAX_MODEL,
            max_tokens: maxTokens,
            messages
          },
          {
            headers: {
              'Authorization': `Bearer ${MINIMAX_API_KEY}`,
              'Content-Type': 'application/json',
              'anthropic-version': '2023-06-01',
              'x-api-key': MINIMAX_API_KEY
            },
            timeout: 60000
          }
        )
      );

      circuitReset();
      console.log('[MINIMAX] ✅ Sucesso na API');
      return response.data;

    } catch (err) {
      lastError = err;
      const status = err.response?.status;
      const data = err.response?.data;
      const message = data?.error?.message || data?.status_msg || err.message;

      console.error(`[MINIMAX] Tentativa ${attempt} falhou: ${status || 'Network'} - ${message}`);

      if ((err.code === 'ECONNABORTED' || !status) && attempt <= maxRetries) {
        console.log(`[MINIMAX] Erro transitorio, aguardando 2s...`);
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }

      if (status === 401 || status === 400) {
        throw err;
      }

      if (attempt === maxRetries + 1) {
        throw err;
      }
    }
  }

  throw lastError;
}

// ─── EXTRACT TEXT FROM RESPONSE ───────────────────────────────────────────
function extractTextFromResponse(response) {
  if (!response.content || !Array.isArray(response.content)) {
    return '';
  }
  const textParts = response.content
    .filter(block => block.type === 'text')
    .map(block => block.text);
  return textParts.join('\n').normalize('NFC');
}

// ─── TTS: MiniMax Text-to-Speech ─────────────────────────────────────────
/**
 * Generate TTS audio from text using MiniMax API.
 * The API returns a task_id — we poll until audio_url is ready,
 * then download and return the MP3 buffer.
 * Returns buffer MP3 audio or null on failure.
 */
async function generateTTS(text, maxChars = TTS_MAX_CHARS) {
  if (!TTS_ENABLED || !TTS_API_KEY) {
    return null;
  }

  async function pollForAudio(taskId, maxWaitMs = 30000) {
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
      try {
        const statusRes = await axios.get(
          `${TTS_URL}?task_id=${taskId}`,
          {
            headers: { 'Authorization': `Bearer ${TTS_API_KEY}` },
            timeout: 10000,
          }
        );
        const data = statusRes.data;
        if (data.status === 'success' && data.audio_url) {
          return data.audio_url;
        }
        if (data.status === 'failed') {
          console.error(`[TTS] ❌ Task failed: ${data.error || 'unknown'}`);
          return null;
        }
        // still processing
        await new Promise(r => setTimeout(r, 2000));
      } catch (err) {
        console.warn(`[TTS] ⚠️ Poll error: ${err.message}`);
        await new Promise(r => setTimeout(r, 3000));
      }
    }
    console.warn('[TTS] ⚠️ Timeout esperando áudio');
    return null;
  }

  async function fetchAudioForChunk(chunk, chunkIdx, total) {
    console.log(`[TTS] 🔊 Gerando áudio ${chunkIdx + 1}/${total} (${chunk.length} chars)...`);

    // Step 1: Request audio generation
    const response = await axios.post(
      TTS_URL,
      {
        model: TTS_MODEL,
        text: chunk,
        stream: false,
        voice_setting: {
          voice_id: TTS_VOICE_ID,
          speed: 1.0,
          pitch: 0,
          volume: 0,
        },
        audio_setting: {
          sample_rate: 32000,
          bitrate: 128000,
          format: 'mp3',
        },
      },
      {
        headers: {
          'Authorization': `Bearer ${TTS_API_KEY}`,
          'Content-Type': 'application/json',
        },
        timeout: 15000,
      }
    );

    // Step 2: Parse response — could be direct audio_url or task_id
    let audioUrl = null;

    const contentType = response.headers['content-type'] || '';
    if (contentType.includes('application/json') || typeof response.data === 'object') {
      const data = response.data;
      if (data.audio_url) {
        audioUrl = data.audio_url;
      } else if (data.task_id) {
        console.log(`[TTS] Task ID: ${data.task_id} — aguardando processamento...`);
        audioUrl = await pollForAudio(data.task_id);
      } else {
        console.warn('[TTS] ⚠️ Resposta inesperada:', JSON.stringify(data).substring(0, 100));
      }
    } else {
      // Direct audio bytes returned
      if (response.data && response.data.byteLength > 100) {
        return Buffer.from(response.data);
      }
    }

    if (!audioUrl) return null;

    // Step 3: Download audio from URL
    const audioRes = await axios.get(audioUrl, {
      responseType: 'arraybuffer',
      timeout: 20000,
    });

    const buf = Buffer.from(audioRes.data);
    console.log(`[TTS] ✅ Audio chunk ${chunkIdx + 1}: ${buf.length} bytes`);
    return buf;
  }

  try {
    // Split text into chunks if too long
    const chunks = [];
    let remaining = text;

    while (remaining.length > maxChars) {
      const splitIdx = remaining.lastIndexOf('. ', maxChars);
      if (splitIdx > maxChars * 0.5) {
        chunks.push(remaining.substring(0, splitIdx + 1).trim());
        remaining = remaining.substring(splitIdx + 1).trim();
      } else {
        chunks.push(remaining.substring(0, maxChars).trim());
        remaining = remaining.substring(maxChars).trim();
      }
    }
    if (remaining) chunks.push(remaining);

    const audioBuffers = [];
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      if (!chunk || chunk.length < 3) continue;
      try {
        const buf = await fetchAudioForChunk(chunk, i, chunks.length);
        if (buf && buf.length > 0) {
          audioBuffers.push(buf);
        }
      } catch (chunkErr) {
        console.warn(`[TTS] ⚠️ Erro no chunk ${i + 1}: ${chunkErr.message}`);
      }
    }

    if (audioBuffers.length === 0) return null;

    const totalLen = audioBuffers.reduce((sum, b) => sum + b.length, 0);
    const result = Buffer.concat(audioBuffers, totalLen);
    console.log(`[TTS] ✅ Audio final: ${result.length} bytes (${chunks.length} chunks)`);
    return result;

  } catch (err) {
    console.error(`[TTS] ❌ Erro geral: ${err.message}`);
    return null;
  }
}

// ─── PROCESS MESSAGE ─────────────────────────────────────────────────────
async function processMessage(phone, userMessage, documentInfo = null, isImageMode = false) {
  const isDocumentMode = documentInfo !== null || hasDocumentContext(phone);
  const firstContact = isFirstContact(phone);

  try {
    console.log(`[MSG] Processando mensagem de ${phone} | modoDocumento: ${isDocumentMode} | primeiroContato: ${firstContact}`);

    // 1. Obter system prompt base
    let baseSystemPrompt = await getSystemPrompt();

    // 1b. Saudação: injetar hint sobre primeira vez ou não (MAS NÃO em modo documento nem imagem OCR)
    if (!isDocumentMode && !isImageMode) {
      if (firstContact) {
        baseSystemPrompt = 'MODO: PRIMEIRO CONTATO — Use esta apresentação:\n"Oi! Tudo bem? 😊 Sou Dr. IAgo, especialista em licitações da LicitaTech. Em que posso te ajudar?"\n\n' + baseSystemPrompt;
      } else {
        baseSystemPrompt = 'MODO: RETORNO — Não se apresente novamente. Use uma saudação casual:\n"Oi! Tudo certo? 😊 Em que posso te ajudar?"\n\n' + baseSystemPrompt;
      }
    }

    // 2. Enriquecer com contexto do documento (se houver) — passa pergunta para extração inteligente
    const systemPrompt = enrichSystemPrompt(baseSystemPrompt, phone, userMessage);

    // 3. Contexto da base de conhecimento via RAG (vector search)
    // Pular RAG para saudações e mensagens curtas — responde mais rápido
    let knowledgeContext = '';
    const skipRag = isGreeting(userMessage);
    if (!isDocumentMode && !skipRag) {
      try {
        const ragResult = await ragPipeline(userMessage, { topK: 3 });
        if (ragResult.context) {
          knowledgeContext = '\n\n--- BASE JURÍDICA (RAG) ---\n' + ragResult.context;
          console.log(`[RAG] ✅ ${ragResult.stats?.totalFound || 0} fontes recuperadas (não expostas ao usuário)`);
        }
      } catch (ragErr) {
        console.warn('[RAG] ⚠️ Erro no pipeline RAG, usando fallback LIKE:', ragErr.message);
        knowledgeContext = getKnowledgeContext(userMessage);
      }
    } else if (skipRag) {
      console.log('[RAG] ⏭️ Pulando RAG — mensagem é saudação/padrão');
    }

    // 4. Histórico de conversa
    const history = getConversationHistory(phone);

    // 5. Montar array de mensagens no formato Anthropic
    const allMessages = [
      { role: 'user', content: systemPrompt + knowledgeContext },
      ...history,
      { role: 'user', content: userMessage }
    ];

    // 6. Chamar MiniMax — mais tokens para modo documento (resposta longa)
    const maxTokens = isDocumentMode ? 1500 : 768;
    const response = await callMiniMaxWithRetry(allMessages, maxTokens, 2);

    // 7. Extrair e limpar resposta
    let reply = extractTextFromResponse(response);
    reply = markdownToWhatsApp(reply);
    reply = removeAsterisks(reply);
    reply = cleanText(reply);

    // 8. Salvar mensagens no histórico
    saveMessage(phone, 'user', userMessage);
    saveMessage(phone, 'assistant', reply);

    // 9. NÃO limpar contexto aqui — o contexto fica até o usuário enviar
    //    outro documento ou uma nova mensagem de texto sem relação com o doc
    //    (o contexto só é limpo pelo cleanup periódico de 2h ou por clearPhoneDocuments)

    // 10. Truncar respostas muito longas
    if (reply.length > 4000) {
      console.log(`[MSG] Mensagem grande (${reply.length}), truncando...`);
      reply = reply.substring(0, 3997) + '...';
    }

    console.log(`[MSG] ✅ Resposta processada (${reply.length} chars)`);

    // 11. Retornar objeto com texto e flag de áudio
    return {
      text: reply,
      audio: null, // preenchido pelo caller se TTS gerar
      isFirstContact: firstContact,
    };

  } catch (err) {
    console.error('[MSG] ❌ Erro ao processar mensagem:', err.response?.data || err.message);

    if (isDocumentMode) {
      clearDocumentContext(phone);
    }

    return {
      text: 'Desculpe, tive um problema técnico momentâneo. Pode repetir sua mensagem?',
      audio: null,
      isFirstContact: firstContact,
    };
  }
}

// ─── SEND REPLY (texto + TTS opcional) ──────────────────────────────────
/**
 * Envia resposta ao usuário — texto ou áudio se TTS disponível
 */
async function sendReply(phone, replyData) {
  const { sendMessage } = require('./evolution');
  const { text, audio, isFirstContact } = replyData;

  if (!text) return;

  if (TTS_ENABLED && audio) {
    console.log(`[TTS] 🎤 Enviando áudio para ${phone}`);
    try {
      const { sendAudio } = require('./baileys-client');
      await sendAudio(phone, audio);
      return; // áudio enviado, não precisa do texto
    } catch (err) {
      console.warn(`[TTS] ⚠️ Falha ao enviar áudio, enviando texto: ${err.message}`);
      await sendMessage(phone, text);
    }
  } else {
    await sendMessage(phone, text);
  }
}

module.exports = {
  processMessage,
  sendReply,
  generateTTS,
  removeAsterisks,
  callMiniMaxWithRetry,
  isFirstContact,
  isGreeting,
};
