const axios = require('axios');
const { getDb } = require('../db/database');

const MAX_HISTORY = 10; // últimas 10 mensagens por conversa
const MAX_KNOWLEDGE_CHARS = 8000; // limite de contexto dos documentos

async function getSystemPrompt() {
  const db = getDb();
  const config = db.prepare("SELECT value FROM system_config WHERE key = 'system_prompt'").get();
  return config ? config.value : '';
}

function getKnowledgeContext() {
  const db = getDb();
  const docs = db.prepare("SELECT original_name, content FROM knowledge_docs ORDER BY uploaded_at DESC LIMIT 10").all();
  if (!docs.length) return '';

  let context = '\n\n--- BASE DE CONHECIMENTO ---\n';
  let totalChars = 0;

  for (const doc of docs) {
    const excerpt = doc.content.substring(0, 2000);
    if (totalChars + excerpt.length > MAX_KNOWLEDGE_CHARS) break;
    context += `\n[${doc.original_name}]:\n${excerpt}\n`;
    totalChars += excerpt.length;
  }

  return context;
}

function getConversationHistory(phone) {
  const db = getDb();
  const rows = db.prepare(
    "SELECT role, content FROM conversations WHERE phone = ? ORDER BY created_at DESC LIMIT ?"
  ).all(phone, MAX_HISTORY);
  return rows.reverse();
}

function saveMessage(phone, role, content) {
  const db = getDb();
  db.prepare("INSERT INTO conversations (phone, role, content) VALUES (?, ?, ?)").run(phone, role, content);
  // Limpar histórico antigo (manter só 50 por usuário)
  db.prepare(`
    DELETE FROM conversations WHERE phone = ? AND id NOT IN (
      SELECT id FROM conversations WHERE phone = ? ORDER BY created_at DESC LIMIT 50
    )
  `).run(phone, phone);
}

async function processMessage(phone, userMessage) {
  const systemPrompt = await getSystemPrompt();
  const knowledgeContext = getKnowledgeContext();
  const history = getConversationHistory(phone);

  saveMessage(phone, 'user', userMessage);

  const messages = [
    ...history,
    { role: 'user', content: userMessage }
  ];

  try {
    const response = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: 'claude-haiku-4-5-20251022',
        max_tokens: 1024,
        system: systemPrompt + knowledgeContext,
        messages
      },
      {
        headers: {
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json'
        },
        timeout: 30000
      }
    );

    const reply = response.data.content[0].text;
    saveMessage(phone, 'assistant', reply);

    // Quebrar mensagens longas para o WhatsApp
    if (reply.length > 4000) {
      return reply.substring(0, 3997) + '...';
    }

    return reply;
  } catch (err) {
    console.error('Erro na API Anthropic:', err.response?.data || err.message);
    return 'Desculpe, tive um problema técnico momentâneo. Pode repetir sua mensagem?';
  }
}

module.exports = { processMessage };
