const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { processMessage, generateTTS } = require('../agent/minimax');
const { sendMessage, sendDocument, normalizePhone, resolveLid } = require('../agent/evolution');
const { sendAudio, sendTyping } = require('../agent/baileys-client');
const { triggerWebhooks } = require('./api');
const { processDocument } = require('../agent/document-processor');
const { injectDocumentContext } = require('../agent/context-injector');
const { consultaCNPJ, validarCNPJ } = require('/root/AGENTES/services/brasil_api');
const { gerarRelatorioCNPJ } = require('../agent/cnpj-report');

// ─── ANTI-FLOOD ────────────────────────────────────────────────────────────
// Cada turno do agente custa tokens de LLM. Sem limite por contato, um número
// malicioso esgota o orçamento mandando mensagens em loop. Além disso, o
// MSG_INATIVO sem cooldown permite loop infinito contra outro bot.
const FLOOD_MAX_PER_MINUTE = 10;
const FLOOD_MAX_PER_HOUR = 60;
const MAX_USER_MESSAGE_CHARS = 4000;
const INATIVO_COOLDOWN_MS = 60 * 60 * 1000; // MSG_INATIVO no máximo 1x/hora por número

const floodWindows = new Map(); // phone -> { timestamps: number[], warned: boolean }
const inativoSentAt = new Map(); // phone -> timestamp

function checkFlood(phone) {
  const now = Date.now();
  // sweep ocasional pra não acumular memória
  if (floodWindows.size > 5000) floodWindows.clear();
  const win = floodWindows.get(phone) || { timestamps: [], warned: false };
  win.timestamps = win.timestamps.filter(t => now - t < 60 * 60 * 1000);
  const lastMinute = win.timestamps.filter(t => now - t < 60 * 1000).length;
  if (lastMinute >= FLOOD_MAX_PER_MINUTE || win.timestamps.length >= FLOOD_MAX_PER_HOUR) {
    const shouldWarn = !win.warned;
    win.warned = true;
    floodWindows.set(phone, win);
    return { allowed: false, shouldWarn };
  }
  win.timestamps.push(now);
  win.warned = false;
  floodWindows.set(phone, win);
  return { allowed: true, shouldWarn: false };
}

function shouldSendInativo(phone) {
  const now = Date.now();
  if (inativoSentAt.size > 5000) inativoSentAt.clear();
  const last = inativoSentAt.get(phone) || 0;
  if (now - last < INATIVO_COOLDOWN_MS) return false;
  inativoSentAt.set(phone, now);
  return true;
}

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

// ─── DETECÇÃO DE CNPJ ──────────────────────────────────────────────────────

/**
 * Extrai CNPJs válidos de um texto
 * Estratégia: remove pontuação → acha sequências de 14 dígitos → valida check digits
 * @param {string} text
 * @returns {string[]} Array de CNPJs normalizados (só números)
 */
function extrairCNPJs(text) {
  if (!text) return [];
  const digits = String(text).replace(/\D/g, '');
  const results = [];
  for (let i = 0; i <= digits.length - 14; i++) {
    const candidate = digits.slice(i, i + 14);
    if (validarCNPJ(candidate)) results.push(candidate);
  }
  return results;
}

/**
 * Classifica o tipo de menção ao CNPJ
 * @param {string} text - texto original
 * @param {string} cnpj - CNPJ encontrado
 * @returns {'standalone'|'focus'|'mention'}
 */
function classificarCNPJ(text, cnpj) {
  // Só números e pontuação do texto
  const alphanumericOnly = String(text).replace(/\w/g, ' ').trim().length;
  const justNumbers = String(text).replace(/\D/g, '').length;
  const textLen = text.trim().length;

  // Standalone: texto é só o CNPJ (+ pontuação mínima)
  if (textLen <= 25 && justNumbers >= 12 && justNumbers <= 20) {
    return 'standalone';
  }

  // Focus: CNPJ é o assunto principal (curto, CNPJ mencionado claramente)
  if (textLen <= 100) {
    const cnpjDigits = cnpj.replace(/\D/g, '');
    const textDigits = text.replace(/\D/g, '');
    const ratio = cnpjDigits.length / textDigits.length;
    if (ratio > 0.4) return 'focus';
  }

  return 'mention';
}

/**
 * Processa CNPJ e retorna resposta formatada
 * @param {string} cnpj
 * @returns {Promise<string|null>}
 */
async function processarCNPJ(cnpj) {
  try {
    return await gerarRelatorioCNPJ(cnpj);
  } catch (err) {
    if (err.message.includes('não encontrado') || err.message.includes('404')) {
      return {
        errorText: `❌ CNPJ não encontrado: ${cnpj}\nVerifique o número e tente novamente.`,
      };
    }
    console.error('[CNPJ] Erro ao consultar:', err.message);
    return {
      errorText: 'Tive um problema ao montar o dossiê desse CNPJ agora. Pode tentar novamente em alguns minutos?',
    };
  }
}

function startActivityIndicator(phone, phoneDB, options = {}) {
  const {
    messages = [],
    typingEveryMs = 8000,
  } = options;

  let stopped = false;
  const timers = [];

  const pulseTyping = () => {
    if (stopped) return;
    sendTyping(phoneDB).catch(() => {});
  };

  pulseTyping();
  const typingTimer = setInterval(pulseTyping, typingEveryMs);
  timers.push(typingTimer);

  for (const item of messages) {
    const timer = setTimeout(() => {
      if (stopped) return;
      sendMessage(phone, item.text).catch(() => {});
      pulseTyping();
    }, item.afterMs);
    timers.push(timer);
  }

  return () => {
    stopped = true;
    for (const timer of timers) clearInterval(timer);
  };
}

function getDocumentInstruction(data, filename) {
  const docMsg = data?.message?.documentMessage || data?.documentMessage || {};
  const caption =
    docMsg?.caption ||
    data?.message?.documentWithCaptionMessage?.message?.documentMessage?.caption ||
    data?.message?.documentWithCaptionMessage?.message?.extendedTextMessage?.text ||
    data?.caption ||
    '';

  const body = typeof data?.body === 'string' ? data.body : '';
  const cleanedBody = body && body !== filename ? body : '';
  const instruction = String(caption || cleanedBody || '').trim();

  if (instruction.length > 3) {
    return instruction;
  }

  return 'Faça um resumo executivo deste documento e destaque os principais riscos, exigências e próximos passos.';
}

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

    // ── ANTI-FLOOD ──────────────────────────────────────────────────────────
    const flood = checkFlood(phoneDB);
    if (!flood.allowed) {
      console.warn('[WEBHOOK] 🚨 Flood bloqueado: ' + phoneDB.slice(0, 6) + '***');
      if (flood.shouldWarn) {
        await sendMessage(phone, 'Estou recebendo muitas mensagens suas em sequência. Me manda um resumo do que precisa em uma mensagem só, por favor. 🙏').catch(() => {});
      }
      return;
    }

    // ── VERIFICAR SE É DOCUMENTO ────────────────────────────────────────────────
    // Baileys envia PDFs como documentMessage — detectar também por message.documentMessage
    const hasMedia = data?.hasMedia === true;
    const mediaType = data?.media?.mimetype || data?.mediaType || '';
    const messageType = data?.message?.documentMessage ? 'document' : '';
    const isDocument = (
      hasMedia && (mediaType.includes('pdf') || mediaType.includes('document') || mediaType.includes('application') || mediaType.includes('text/plain') || data?.type === 'document')
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
      const documentInstruction = getDocumentInstruction(data, filename);
      console.log('[DOC] Documento recebido de ' + phone + ': ' + filename);

      let stopActivity = null;
      try {
        await sendMessage(phone, 'Recebi o documento. Vou extrair o texto e analisar com cuidado, já te retorno.');
        stopActivity = startActivityIndicator(phone, phoneDB, {
          messages: [
            { afterMs: 7000, text: 'Ainda estou lendo o arquivo. Vou separar os pontos principais antes de te responder.' },
            { afterMs: 18000, text: 'Já avancei na leitura. Agora estou cruzando exigências, riscos e próximos passos.' },
            { afterMs: 35000, text: 'Esse documento está levando um pouco mais de tempo, mas sigo analisando para não te entregar algo superficial.' },
          ],
        });

        const docInfo = await processDocument(data, filename, phone, data?.message);

        if (docInfo) {
          console.log('[DOC] ✅ Documento processado: ' + filename);
          injectDocumentContext(phone, docInfo);
          await sendMessage(phone, 'Consegui extrair o conteúdo. Agora vou responder exatamente sobre o que você pediu.');
          const replyData = await processMessage(phone, `${documentInstruction}\n\nDocumento: ${filename}`, docInfo);
          const replyText = String(replyData.text || '');
          if (replyText) await sendMessage(phone, replyText);
        } else {
          await sendMessage(phone, '❌ Não consegui processar o documento. Verifique se é um PDF válido.');
        }
      } catch (err) {
        console.error('[DOC] ❌ Erro:', err.message);
        await sendMessage(phone, '❌ Desculpe, tive um problema ao processar o arquivo. Tente novamente.');
      } finally {
        if (stopActivity) stopActivity();
      }
      return;
    }

    // ── VERIFICAR SE É IMAGEM (OCR) ─────────────────────────────────────────────
    const hasImage = !!(data?.message?.imageMessage || data?.imageMessage || data?.message?.quotedMessage?.imageMessage);
    const imageMsg = data?.message?.imageMessage || data?.imageMessage || data?.message?.quotedMessage?.imageMessage;
    const hasImageMedia = data?.hasMedia === true && (mediaType.includes('image') || mediaType.includes('jpeg') || mediaType.includes('png'));

    if (hasImage || hasImageMedia) {
      console.log('[IMG] Imagem recebida de ' + phone + ' — executando OCR...');
      let stopActivity = null;
      try {
        await sendMessage(phone, 'Recebi a imagem. Vou tentar extrair o texto e analisar para você.');
        stopActivity = startActivityIndicator(phone, phoneDB, {
          messages: [
            { afterMs: 8000, text: 'Ainda estou fazendo a leitura da imagem. Se o texto estiver pequeno, isso pode levar um pouco mais.' },
            { afterMs: 22000, text: 'Já estou com a análise em andamento. Vou te responder com o que der para identificar com segurança.' },
          ],
        });

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
          if (shouldSendInativo(phoneDB)) await sendMessage(phone, MSG_INATIVO);
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
      } finally {
        if (stopActivity) stopActivity();
      }
      return;
    }

    // ── PROCESSAR MENSAGEM DE TEXTO ─────────────────────────────────────────────
    const rawBody = data?.body || data?.message?.conversation || data?.message?.extendedTextMessage?.text || '';
    let text = Array.isArray(rawBody) ? rawBody[0] : (typeof rawBody === 'string' ? rawBody : '');
    if (!text.trim()) return;
    // corte por code points pra não partir emoji em surrogate órfão
    if (text.length > MAX_USER_MESSAGE_CHARS) {
      text = [...text].slice(0, MAX_USER_MESSAGE_CHARS).join('') + '\n[mensagem truncada por exceder o limite]';
    }

    console.log('[MSG] Mensagem de ' + phone + ': ' + text.substring(0, 80));

    const db = getDb();
    const subscriber = db.prepare('SELECT * FROM subscribers WHERE phone = ? OR phone = ?').get(phoneDB, phone);

    if (!subscriber || subscriber.status !== 'active') {
      if (shouldSendInativo(phoneDB)) await sendMessage(phone, MSG_INATIVO);
      db.prepare("INSERT INTO conversations (phone, role, content, status) VALUES (?, 'user', ?, 'blocked')").run(phone, text);
      return;
    }

    // ── DETECÇÃO DE CNPJ ───────────────────────────────────────────────────
    const cnpjs = extrairCNPJs(text);
    let cnpjContext = '';

    if (cnpjs.length > 0) {
      const primaryCNPJ = cnpjs[0];
      const tipo = classificarCNPJ(text, primaryCNPJ);
      console.log(`[CNPJ] Detectado: ${primaryCNPJ} | tipo: ${tipo} | total encontrados: ${cnpjs.length}`);

      if (tipo === 'standalone' || tipo === 'focus') {
        // Consulta direta profunda e responde sem passar pelo processMessage
        await sendTyping(phoneDB);
        await sendMessage(phone, 'Vou montar um dossiê TXT desse CNPJ com cadastro, quadro societário, sinais de risco e buscas públicas. Já te envio.');
        const stopCnpjActivity = startActivityIndicator(phone, phoneDB, {
          messages: [
            { afterMs: 12000, text: 'Já puxei o cadastro. Agora estou cruzando sanções, TCU, PGFN, PNCP e menções públicas.' },
            { afterMs: 30000, text: 'Estou fechando o relatório em TXT com fontes e limites da consulta.' },
          ],
        });

        let resultado;
        try {
          resultado = await processarCNPJ(primaryCNPJ);
        } finally {
          stopCnpjActivity();
        }

        if (resultado?.errorText) {
          await sendMessage(phone, resultado.errorText);
          db.prepare("INSERT INTO conversations (phone, role, content, status) VALUES (?, 'user', ?, 'received')").run(phone, text);
          db.prepare("INSERT INTO conversations (phone, role, content, status) VALUES (?, 'assistant', ?, 'sent')").run(phone, resultado.errorText);
          return;
        }

        if (resultado) {
          const sent = await sendDocument(
            phone,
            resultado.buffer,
            resultado.filename,
            resultado.summary,
            'text/plain'
          );
          if (!sent) {
            await sendMessage(phone, `${resultado.summary}\n\n${resultado.text}`);
          }
          db.prepare("INSERT INTO conversations (phone, role, content, status) VALUES (?, 'user', ?, 'received')").run(phone, text);
          db.prepare("INSERT INTO conversations (phone, role, content, status) VALUES (?, 'assistant', ?, 'sent')").run(phone, `[dossie CNPJ TXT] ${resultado.filename}\n\n${resultado.summary}`);
        }
        return;
      }

      // mention → injeta contexto do CNPJ no prompt da IA
      try {
        const empresa = await consultaCNPJ(primaryCNPJ);
        cnpjContext = `\n\n[CONTEXTO: O usuário mencionou a empresa ${empresa.razao_social} (CNPJ: ${primaryCNPJ.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5')}). Dados: situação=${empresa.situacao.descricao}, atividade=${empresa.atividade_principal.descricao}, endereço=${[empresa.endereco.logradouro, empresa.endereco.bairro, empresa.endereco.municipio, empresa.endereco.uf].filter(Boolean).join(', ')}.]`;
        console.log(`[CNPJ] Contexto injetado para processMessage`);
      } catch (err) {
        console.warn(`[CNPJ] Não foi possível enriquecer contexto: ${err.message}`);
      }
    }

    db.prepare("INSERT INTO conversations (phone, role, content, status) VALUES (?, 'user', ?, 'received')").run(phone, text);
    triggerWebhooks('message:sent', { phone, message: text.substring(0, 200), subscriber_name: subscriber.name }).catch(() => {});

    // Activity indicator: só dispara filler para perguntas longas/complexas.
    // Saudações e mensagens curtas (<= 25 chars) NÃO recebem filler — o agente
    // responde rápido o suficiente e o filler vira ruído.
    const isShortMessage = text.trim().length <= 25;
    const stopActivity = startActivityIndicator(phone, phoneDB, {
      messages: isShortMessage ? [] : [
        { afterMs: 18000, text: 'Estou cruzando os dados pra te responder com precisão. Já te mando.' },
        { afterMs: 45000, text: 'Quase lá — só fechando os pontos críticos da resposta.' },
      ],
    });

    let replyData;
    let replyText = '';
    try {
      replyData = await processMessage(phone, text + cnpjContext);
      replyText = String(replyData.text || '');
    } finally {
      stopActivity();
    }

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
// Sem validação de assinatura, qualquer um que conheça a URL pode forjar um
// POST {order_status:'paid'} e se ativar como assinante de graça — ou desativar
// assinantes legítimos com {order_status:'refunded'}.
const crypto = require('crypto');

function validateKiwifySignature(req) {
  const secret = process.env.KIWIFY_WEBHOOK_SECRET;
  if (!secret) {
    console.warn('[KIWIFY] ⚠️ KIWIFY_WEBHOOK_SECRET ausente — webhook SEM validação de assinatura!');
    return true; // não quebra produção sem o secret configurado
  }
  const signature = String(req.query?.signature || '');
  if (!signature || !req.rawBody) return false;
  const expected = crypto.createHmac('sha1', secret).update(req.rawBody).digest('hex');
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

router.post('/kiwify', async (req, res) => {
  if (!validateKiwifySignature(req)) {
    console.warn('[KIWIFY] 🚨 Assinatura inválida — webhook rejeitado (IP: ' + req.ip + ')');
    return res.status(401).json({ error: 'invalid_signature' });
  }
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
