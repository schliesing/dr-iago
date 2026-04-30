const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { processMessage, generateTTS, isFirstContact } = require('../agent/minimax');
const { sendMessage, normalizePhone, resolveLid } = require('../agent/evolution');
const { sendAudio, sendTyping } = require('../agent/baileys-client');
const { triggerWebhooks } = require('./api');
const { processDocument } = require('../agent/document-processor');
const { injectDocumentContext } = require('../agent/context-injector');

const MSG_INATIVO = `Olá! 👋

Você ainda não faz parte da nossa lista de assinantes do *Dr. IAgo*, o assistente especializado em licitações e contratos públicos.

🎯 Com o Dr. IAgo você tem acesso a:
✅ Análise de editais em minutos
✅ Revisão de contratos com base na Lei 14.133/2021
✅ Suporte em impugnações e recursos
✅ Base atualizada de legislação e jurisprudência

👉 Assine agora e comece a usar imediatamente:
https://pay.kiwify.com.br/QbYvidM

Qualquer dúvida, estamos à disposição! 😊`;

async function handleWhatsAppMessage(body) {
  try {
    // ── PARSE BODY ───────────────────────────────────────────────────────────────
    const data = body?.payload || body?.data || body;

    // Ignorar mensagens enviadas pelo próprio bot
    if (data?.fromMe === true) return;

    // Extrair número do remetente
    const fromRaw = data?.from || data?.key?.remoteJid || '';
    if (!fromRaw) return;

    // Ignorar grupos
    if (fromRaw.includes('@g.us')) return;

    let phone;
    if (fromRaw.includes('@lid')) {
      const resolved = await resolveLid(fromRaw);
      if (!resolved) {
        console.log('[WEBHOOK] Ignorando @lid nao resolvido: ' + fromRaw);
        return;
      }
      phone = normalizePhone(resolved);
    } else {
      phone = normalizePhone(fromRaw.replace(/@c\.us|@s\.whatsapp\.net/g, ''));
    }
    const phoneDB = phone.replace(/@c\.us$/, '');

    console.log('[WEBHOOK] Mensagem de ' + phone);

    // ── VERIFICAR SE É DOCUMENTO ────────────────────────────────────────────────
    // Baileys envia PDFs como documentMessage — detectar também por message.documentMessage
    const hasMedia = data?.hasMedia === true;
    const mediaType = data?.media?.mimetype || data?.mediaType || '';
    const messageType = data?.message?.documentMessage ? 'document' : '';
    const isDocument = (
      hasMedia && (mediaType.includes('pdf') || mediaType.includes('document') || mediaType.includes('application') || data?.type === 'document')
    ) || (
      messageType === 'document'
    ) || (
      // Também detectar por extensão no filename
      (data?.media?.filename || data?._data?.filename || '').toLowerCase().endsWith('.pdf')
    );

    if (isDocument) {
      // Extrair filename de múltiplas fontes
      const docMsg = data?.message?.documentMessage || data?.documentMessage || {};
      const filename = data?.media?.filename || data?._data?.filename || docMsg?.fileName || docMsg?.title || data?.body || 'documento.pdf';
      console.log('[DOC] Documento recebido de ' + phone + ': ' + filename);

      try {
        // Dar sinal de vida imediato
        await sendTyping(phoneDB);
        await sendMessage(phone, '📄 Recebido! Analisando seu documento... por favor aguarde.');

        const docInfo = await processDocument(data, filename, phone, data?.message);

        if (docInfo) {
          console.log('[DOC] ✅ Documento processado: ' + filename);
          injectDocumentContext(phone, docInfo);
          const replyData = await processMessage(phone, 'Analise este documento: ' + filename);
          const replyText = String(replyData.text || '');
          if (replyText) await sendMessage(phone, replyText);
        } else {
          await sendMessage(phone, '❌ Não consegui processar o documento. Verifique se é um PDF válido.');
        }
      } catch (err) {
        console.error('[DOC] ❌ Erro:', err.message);
        await sendMessage(phone, '❌ Desculpe, tive um problema ao processar o arquivo. Tente novamente.');
      }
      return;
    }

    // ── VERIFICAR SE É IMAGEM (OCR) ─────────────────────────────────────────────
    const hasImage = !!(data?.message?.imageMessage || data?.imageMessage || data?.message?.quotedMessage?.imageMessage);
    const imageMsg = data?.message?.imageMessage || data?.imageMessage || data?.message?.quotedMessage?.imageMessage;
    const hasImageMedia = data?.hasMedia === true && (mediaType.includes('image') || mediaType.includes('jpeg') || mediaType.includes('png'));

    if (hasImage || hasImageMedia) {
      console.log('[IMG] Imagem recebida de ' + phone + ' — executando OCR...');
      try {
        await sendTyping(phoneDB);
        await sendMessage(phone, '🖼️  Recebido! Extraindo texto da imagem...');

        // Importar função de OCR (usa tesseract diretamente, não passa pelo document-processor)
        const { extractTextFromImage } = require('../agent/document-processor');
        const { downloadMedia } = require('../agent/document-processor');

        let imageBuffer;
        if (data?.message?.imageMessage || data?.imageMessage || data?.message?.quotedMessage?.imageMessage) {
          imageBuffer = await downloadMedia(data);
        } else if (data?.media?.url) {
          imageBuffer = await downloadMedia(data.media.url);
        }

        if (!imageBuffer) {
          await sendMessage(phone, '❌ Não consegui acessar a imagem. Tente enviar novamente.');
          return;
        }

        const tempName = 'img_' + phone.replace(/\D/g, '') + '_' + Date.now();
        const extractedText = await extractTextFromImage(imageBuffer, tempName);

        console.log('[IMG] OCR extraiu ' + extractedText.length + ' chars');

        if (extractedText.length < 5) {
          await sendMessage(phone, '🤔 Não consegui identificar texto nessa imagem. Tente enviar como PDF ou digitar o conteúdo.');
          return;
        }

        // Processar o texto extraído como mensagem normal
        const db = getDb();
        const subscriber = db.prepare('SELECT * FROM subscribers WHERE phone = ? OR phone = ?').get(phoneDB, phone);

        if (!subscriber || subscriber.status !== 'active') {
          await sendMessage(phone, MSG_INATIVO);
          return;
        }

        db.prepare("INSERT INTO conversations (phone, role, content, status) VALUES (?, 'user', ?, 'received')").run(phone, '[imagem OCR]: ' + extractedText);
        triggerWebhooks('message:sent', { phone, message: extractedText.substring(0, 200), subscriber_name: subscriber.name }).catch(() => {});

        await sendTyping(phoneDB);
        const replyData = await processMessage(phone, extractedText, null, true);
        const replyText = String(replyData.text || '');
        if (replyText) await sendMessage(phone, replyText);

      } catch (err) {
        console.error('[IMG] ❌ Erro OCR:', err.message);
        await sendMessage(phone, '🤔 Não consegui extrair texto dessa imagem. Pode enviar como documento (PDF/DOCX) ou digitar o conteúdo?');
      }
      return;
    }

    // ── PROCESSAR MENSAGEM DE TEXTO ─────────────────────────────────────────────
    const rawBody = data?.body || data?.message?.conversation || data?.message?.extendedTextMessage?.text || '';
    const text = Array.isArray(rawBody) ? rawBody[0] : (typeof rawBody === 'string' ? rawBody : '');
    if (!text.trim()) return;

    console.log('[MSG] Mensagem de ' + phone + ': ' + text.substring(0, 80));

    const db = getDb();
    const subscriber = db.prepare('SELECT * FROM subscribers WHERE phone = ? OR phone = ?').get(phoneDB, phone);

    if (!subscriber || subscriber.status !== 'active') {
      await sendMessage(phone, MSG_INATIVO);
      db.prepare("INSERT INTO conversations (phone, role, content, status) VALUES (?, 'user', ?, 'blocked')").run(phone, text);
      return;
    }

    const firstContact = isFirstContact(phoneDB);

    db.prepare("INSERT INTO conversations (phone, role, content, status) VALUES (?, 'user', ?, 'received')").run(phone, text);
    triggerWebhooks('message:sent', { phone, message: text.substring(0, 200), subscriber_name: subscriber.name }).catch(() => {});

    // Mostrar "digitando..." para o usuário enquanto processa
    sendTyping(phoneDB);

    const replyData = await processMessage(phone, text);
    const replyText = String(replyData.text || '');

    if (!replyText) return;

    // Tentar TTS se habilitado
    const TTS_ENABLED = process.env.TTS_ENABLED === 'true';
    if (TTS_ENABLED && replyText.length > 5) {
      try {
        const audioBuffer = await generateTTS(replyText);
        if (audioBuffer) {
          await sendAudio(phoneDB, audioBuffer);
          db.prepare("INSERT INTO conversations (phone, role, content, status) VALUES (?, 'assistant', ?, 'sent_audio')").run(phone, '[áudio]');
          console.log('[WEBHOOK] ✅ Enviado como áudio para ' + phoneDB);
        } else {
          await sendMessage(phone, replyText);
          db.prepare("INSERT INTO conversations (phone, role, content, status) VALUES (?, 'assistant', ?, 'sent')").run(phone, replyText);
        }
      } catch (ttsErr) {
        console.warn('[WEBHOOK] ⚠️ TTS falhou, enviando texto:', ttsErr.message);
        await sendMessage(phone, replyText);
        db.prepare("INSERT INTO conversations (phone, role, content, status) VALUES (?, 'assistant', ?, 'sent')").run(phone, replyText);
      }
    } else {
      await sendMessage(phone, replyText);
      db.prepare("INSERT INTO conversations (phone, role, content, status) VALUES (?, 'assistant', ?, 'sent')").run(phone, replyText);
    }

  } catch (err) {
    const phoneRaw = body?.payload?.data?.from || body?.data?.from || body?.from || 'desconhecido';
    console.error(`[WEBHOOK] ❌ Erro ao processar de ${phoneRaw}:`, err.message);
    if (process.env.NODE_ENV !== 'production') {
      console.error('[WEBHOOK] Stack:', err.stack);
    }
    // Não tenta responder erro via WhatsApp em ambiente de produção
    // para evitar loops de retry
  }
}

// ─── KIWIFY WEBHOOK ───────────────────────────────────────────────────────────
router.post('/kiwify', async (req, res) => {
  res.sendStatus(200);

  try {
    const body = req.body;
    const status = body?.order_status;
    const customer = body?.Customer || body?.customer;
    const phone = customer?.mobile || customer?.phone || '';
    const name = customer?.full_name || customer?.name || '';
    const email = customer?.email || '';
    const kiwify_id = body?.order_id || '';

    console.log('🛒 Kiwify webhook: ' + status + ' - ' + name + ' (' + phone + ')');
    if (!phone) return;

    const db = getDb();
    const normalized = phone.replace(/\D/g, '');
    const now = new Date().toISOString();

    if (status === 'paid' || status === 'complete' || status === 'approved') {
      const existing = db.prepare('SELECT * FROM subscribers WHERE phone = ?').get(normalized);
      if (existing) {
        db.prepare("UPDATE subscribers SET status='active', kiwify_id=?, activated_at=?, updated_at=? WHERE phone=?")
          .run(kiwify_id, now, now, normalized);
      } else {
        const result = db.prepare("INSERT INTO subscribers (name, phone, email, status, kiwify_id, origin, activated_at) VALUES (?, ?, ?, 'active', ?, 'kiwify', ?)")
          .run(name, normalized, email, kiwify_id, now);
        triggerWebhooks('subscriber:created', { id: result.lastInsertRowid, name, phone: normalized, status: 'active', origin: 'kiwify' }).catch(() => {});
      }
      console.log('✅ Assinante ativado: ' + name + ' (' + normalized + ')');
    } else if (status === 'refunded' || status === 'chargeback' || status === 'cancelled') {
      db.prepare("UPDATE subscribers SET status='inactive', updated_at=? WHERE phone=? OR kiwify_id=?")
        .run(now, normalized, kiwify_id);
      console.log('⛔ Assinante desativado: ' + name + ' (' + normalized + ')');
    }
  } catch (err) {
    console.error('❌ Erro no webhook Kiwify:', err.message);
    if (process.env.NODE_ENV !== 'production') {
      console.error('Stack:', err.stack);
    }
  }
});

module.exports = { router, handleWhatsAppMessage };
