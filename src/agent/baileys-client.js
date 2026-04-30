/**
 * Baileys Client — DR.IAGO
 * Conexão WhatsApp direta via @whiskeysockets/baileys.
 * Conexão WhatsApp direta via @whiskeysockets/baileys.
 * Reconnect automático, session persistence em arquivo,
 * e emite eventos diretamente (sem webhook intermediário).
 *
 * v2 — corregido: logout detection, heartbeat, 503 handling, listener management
 */
const { makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, makeCacheableSignalKeyStore } = require('@whiskeysockets/baileys');
const { setSockRef: setDocSockRef } = require('./document-processor');
const pino = require('pino');
const qrcode = require('qrcode');
const { existsSync, mkdirSync, writeFileSync, rmSync } = require('fs');
const path = require('path');

// ─── SESSION DIR ─────────────────────────────────────────────────────────────
const SESSION_DIR = path.join(__dirname, '../../data/baileys-session');
if (!existsSync(SESSION_DIR)) mkdirSync(SESSION_DIR, { recursive: true });

// ─── LOGGING ─────────────────────────────────────────────────────────────────
const logger = pino({
  level: 'error',
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: { level: (l) => ({ level: l }) }
});

// ─── SOCKET STATE ─────────────────────────────────────────────────────────────
let sock = null;
let isConnected = false;
let connectionListeners = [];
let qrExpiryTimer = null;
let reconnectTimer = null;
let heartbeatTimer = null;
let isRetrying = false;
let retryCount = 0;
let reconnectDelay = 5000;

// ─── HEARTBEAT: detecta socket morto mesmo sem evento de close ───────────────
function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    if (sock && !isConnected) {
      // Socket existe mas não está marcado como connected
      // Verificar se o socket realmente está vivo
      try {
        if (sock.ws && sock.ws.readyState !== 1) {
          // WebSocket não está open (0=CONNECTING, 2=CLOSING, 3=CLOSED)
          console.log('[BAILEYS] 🫀 Heartbeat: socket morto detectado — reconnecting...');
          isConnected = false;
          scheduleReconnect(1000);
        }
      } catch {}
    }
  }, 30_000); // a cada 30s
}

function stopHeartbeat() {
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
}

// ─── QR EXPIRY: renew socket se QR expirou ─────────────────────────────────
function scheduleQrExpiry() {
  if (qrExpiryTimer) clearTimeout(qrExpiryTimer);
  qrExpiryTimer = setTimeout(() => {
    if (!isConnected && sock) {
      console.log('[BAILEYS] ⏰ QR expirou sem scan — renew socket...');
      try { sock.end(); } catch {}
    }
  }, 55_000);
}

// ─── CLEANUP OLD SESSION ──────────────────────────────────────────────────────
function cleanupSession() {
  try { rmSync(SESSION_DIR, { recursive: true, force: true }); } catch {}
  mkdirSync(SESSION_DIR, { recursive: true });
  console.log('[BAILEYS] 🗑️ Sessão limpa — aguardando novo QR');
}

// ─── RECONNECT SCHEDULER ────────────────────────────────────────────────────
function scheduleReconnect(delayMs) {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (isRetrying) return;
  isRetrying = true;

  reconnectTimer = setTimeout(() => {
    isRetrying = false;
    retryCount++;
    console.log(`[BAILEYS] 🔄 Reconectando (tentativa ${retryCount}, delay ${delayMs}ms)...`);
    createSocket();
  }, delayMs);
}

// ─── NOTIFY LISTENERS ────────────────────────────────────────────────────────
function notifyListeners(event) {
  for (const fn of connectionListeners) {
    try { fn(event); } catch {}
  }
}

// ─── DETECT LOGOUT FROM DISCONNECT STATUS ────────────────────────────────────
function getDisconnectType(status) {
  // Baileys disconnect statuses:
  // 401 = logged out / device removed
  // 430 = banned / rate limited
  // 428 = too many attempts
  // 403 = forbidden
  // 500, 502, 503 = server error
  if (status === 401) return 'logged_out';
  if (status === 430) return 'banned';
  if (status === 428) return 'too_many_attempts';
  if (status >= 500) return 'server_error';
  return 'connection_error';
}

// ─── CREATE SOCKET ────────────────────────────────────────────────────────────
async function createSocket() {
  // Limpar socket anterior ANTES de criar novo
  if (sock) {
    stopHeartbeat();
    try { sock.end(); } catch {}
    sock = null;
    isConnected = false;
  }

  console.log('[BAILEYS] 🔌 Iniciando socket...');

  let state, saveCreds;
  try {
    const auth = await useMultiFileAuthState(SESSION_DIR);
    state = auth.state;
    saveCreds = auth.saveCreds;
  } catch (err) {
    console.error('[BAILEYS] ❌ Falha ao carregar sessão:', err.message);
    scheduleReconnect(10_000);
    return;
  }

  let version;
  try {
    const v = await fetchLatestBaileysVersion();
    version = v.version;
    console.log('[BAILEYS] 📱 Versão WA: ' + version.join('.'));
  } catch (err) {
    console.error('[BAILEYS] ❌ Falha ao buscar versão WA:', err.message);
    scheduleReconnect(10_000);
    return;
  }

  const socket = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys),
    },
    printQRInTerminal: false,
    logger,
    connectTimeoutMs: 30_000,
    keepAliveIntervalMs: 30_000,
    retryRequestDelayMs: 5000,
    maxMsgRetryDelayMs: 120_000,
  });

  // Salvar credenciais quando mudarem
  socket.ev.on('creds.update', saveCreds);

  // Salvar creds imediatamente (antes do primeiro QR)
  try { await saveCreds(); } catch {}

  // ── CONNECTION UPDATE ──────────────────────────────────────────────────────
  socket.ev.on('connection.update', ({ connection, lastDisconnect }) => {
    const disconnectStatus = lastDisconnect?.output?.status;
    const disconnectReason = lastDisconnect?.output?.reason || lastDisconnect?.reason || '';
    const reason = disconnectReason || 'none';
    const wasLoggedOut = disconnectStatus === 401 || String(disconnectReason).toLowerCase().includes('logout');

    console.log(`[BAILEYS] 📡 ${connection || '?'} | status:${disconnectStatus} | reason:${reason} | loggedOut:${wasLoggedOut}`);

    // Mostrar erro detalhado se houver
    if (lastDisconnect?.error) {
      const errCode = lastDisconnect.error.code || lastDisconnect.error.output?.status || '?';
      const errMsg = lastDisconnect.error.message || '';
      console.log(`[BAILEYS] 🔍 Erro detalhado: code=${errCode} msg=${errMsg}`);
    }

    if (connection === 'open') {
      isConnected = true;
      retryCount = 0;
      reconnectDelay = 5000;
      clearTimeout(qrExpiryTimer);
      startHeartbeat();

      // Subscrever presença — essencial para receber mensagens
      try {
        socket.sendPresenceUpdate('available').catch(() => {});
        console.log('[BAILEYS] 📻 Presence update enviado');
      } catch {}

      console.log('[BAILEYS] ✅ CONECTADO — DR.IAGO WhatsApp ativo');
      notifyListeners({ type: 'connected' });
      return;
    }

    if (connection === 'close') {
      isConnected = false;
      stopHeartbeat();
      notifyListeners({ type: 'disconnected' });

      const disconnectType = getDisconnectType(disconnectStatus);

      // Device removido / logout — limpar sessão e aguardar QR
      if (disconnectType === 'logged_out' || wasLoggedOut) {
        console.log('[BAILEYS] 🚫 Sessão invalidada pelo WhatsApp — limpando e gerando novo QR...');
        cleanupSession();
        retryCount = 0;
        reconnectDelay = 5000;
        scheduleReconnect(5000);
        return;
      }

      // Banned / rate limited — aguardar mais tempo
      if (disconnectType === 'banned') {
        console.log('[BAILEYS] ⛔ Conta limitada/banned pelo WhatsApp — aguardando 30min...');
        retryCount = 0;
        reconnectDelay = 30 * 60 * 1000;
        scheduleReconnect(reconnectDelay);
        return;
      }

      // Server error (503, 500, etc) — backoff exponencial
      if (disconnectType === 'server_error') {
        retryCount++;
        reconnectDelay = Math.min(5 * 60 * 1000, 5000 * Math.pow(2, retryCount));
        console.log(`[BAILEYS] 🌐 Erro servidor WA (${disconnectStatus}) — retry ${retryCount}, próximo em ${reconnectDelay}ms`);
        scheduleReconnect(reconnectDelay);
        return;
      }

      // Erro de conexão normal — reconnect com backoff
      retryCount++;
      reconnectDelay = Math.min(5 * 60 * 1000, 5000 * Math.pow(2, retryCount));

      // Para many retries, não reconectar imediatamente
      if (retryCount > 10) {
        console.log(`[BAILEYS] ⛔ Muitas reconexões (${retryCount}) — descansando 5min`);
        scheduleReconnect(5 * 60 * 1000);
      } else {
        scheduleReconnect(reconnectDelay);
      }
    }

    // QR Code — salvar em arquivo
    if (connection === 'connecting' && !isConnected) {
      scheduleQrExpiry();
    }
  });

  // ── QR CODE (quando gerado pelo evento) ──────────────────────────────────
  socket.ev.on('qr', (qr) => {
    scheduleQrExpiry();
    const qrPath = path.join(SESSION_DIR, 'qr.png');
    qrcode.toBuffer(qr, { type: 'png', width: 256, margin: 2 })
      .then(png => {
        writeFileSync(qrPath, png);
        console.log('[BAILEYS] 📸 QR gerado — escaneie em 60s');
        notifyListeners({ type: 'qr', path: qrPath });
      })
      .catch(err => console.error('[BAILEYS] ❌ QR:', err.message));
  });

  // ── MESSAGES ──────────────────────────────────────────────────────────────
  socket.ev.on('messages.upsert', async ({ messages, type }) => {
    console.log(`[BAILEYS] 📩 messages.upsert | type:${type} | count:${messages?.length || 0}`);
    for (const msg of messages || []) {
      const remoteJid = msg.key?.remoteJid || '';
      const fromMe = msg.key?.fromMe || false;
      const isGroup = remoteJid.includes('@g.us');
      const msgContent = msg.message || msg;
      const msgType = msg.message ? Object.keys(msg.message).join(',') : 'no_msg';

      // ── Detectar documentos (PDF, etc) ─────────────────────────────────────
      // WhatsApp envia PDFs principalmente como documentWithCaptionMessage (FutureProofMessage)
      // Estrutura: { message: { documentMessage: {...} } } ou { documentMessage: {...} } direto
      const rawDocWithCaption = msgContent.documentWithCaptionMessage;
      // Log da estrutura real para debug
      if (rawDocWithCaption) {
        const dwcKeys = Object.keys(rawDocWithCaption);
        const dwcMsgKeys = rawDocWithCaption?.message ? Object.keys(rawDocWithCaption.message) : [];
        console.log(`[BAILEYS] 📄 documentWithCaption.keys=${dwcKeys.join(',')} | dwc.message.keys=${dwcMsgKeys.join(',')}`);
        // Mostrar URL se existir
        const potentialUrl = rawDocWithCaption?.url || rawDocWithCaption?.message?.documentMessage?.url;
        if (potentialUrl) console.log(`[BAILEYS] 📄 URL presente: ${String(potentialUrl).substring(0, 80)}`);
      }

      // Tentar múltiplas formas de extrair o documentMessage
      let documentMsg = msgContent.documentMessage;
      if (!documentMsg && rawDocWithCaption) {
        // Estrutura padrão: { message: { documentMessage: {...} } }
        documentMsg = rawDocWithCaption?.message?.documentMessage;
        // Fallback direto: rawDocWithCaption JÁ é o documentMessage
        if (!documentMsg && rawDocWithCaption?.mimetype) documentMsg = rawDocWithCaption;
        // Fallback: rawDocWithCaption.documentMessage (achatado)
        if (!documentMsg && rawDocWithCaption?.documentMessage) documentMsg = rawDocWithCaption.documentMessage;
      }
      const imageMsg = msgContent.imageMessage;
      const videoMsg = msgContent.videoMessage;
      const hasDocument = !!documentMsg;
      const hasImage = !!imageMsg;
      const hasVideo = !!videoMsg;

      if (hasDocument) {
        const fname = documentMsg.fileName || documentMsg.title || 'sem nome';
        const mimetype = documentMsg.mimetype || '?';
        console.log(`[BAILEYS] 📄 Documento: ${fname} (${mimetype}) | jid:${remoteJid} | tipo:${msgType}`);
      }

      // Extrair texto (caption) — ignora receipts/confirmações
      let text = '';
      if (msgContent) {
        text = msgContent.conversation
          || msgContent.extendedTextMessage?.text
          || imageMsg?.caption
          || documentMsg?.caption
          || rawDocWithCaption?.caption
          || rawDocWithCaption?.message?.documentMessage?.caption
          || videoMsg?.caption
          || '';
      }
      text = typeof text === 'string' ? text.trim() : '';

      // Ignorar receipts/confirmações do WhatsApp (CJK, emojis, números)
      const isJustReceipt = /^[\u4e00-\u9fff\u3000-\u303f\u3040-\u309f\u30a0-\u30ff\uac00-\uD7AF📌✅👍👎🤖✔✗\d]+$/.test(text);

      // Só processar: mensagens de usuário, não grupos, não próprias
      // Include documentos mesmo sem caption
      if (isGroup || fromMe) {
        console.log(`[BAILEYS] ⛔ Filtrado: grupo=${isGroup} ou fromMe=${fromMe}`);
        continue;
      }
      if (!text && !hasDocument && !hasImage && !hasVideo) {
        console.log(`[BAILEYS] ⛔ Filtrado: sem texto/mídia (tipo:${msgType})`);
        continue;
      }
      if (isJustReceipt && !hasDocument) {
        console.log(`[BAILEYS] ⛔ Filtrado: receipt sem doc`);
        continue;
      }

      console.log(`[BAILEYS] 📨 ${remoteJid} | fromMe:${fromMe} | doc:${hasDocument} | img:${hasImage} | text:"${text.substring(0,50)}"`);

      // Extrair phone
      const rawJid = remoteJid.replace('@c.us', '').replace('@s.whatsapp.net', '').replace('@lid@c.us', '').replace('@lid', '');
      if (!rawJid) continue;

      let resolvedPhone = rawJid;
      if (remoteJid.includes('@lid')) {
        const info = await getContactInfo(remoteJid);
        if (info?.waid) {
          resolvedPhone = info.waid;
          console.log(`[BAILEYS] 🔗 LID ${rawJid} → ${resolvedPhone}`);
        } else {
          console.log(`[BAILEYS] ⚠️ LID não resolvido: ${rawJid} — ignorando msg`);
          continue;
        }
      }

      const finalJid = normalizePhone(resolvedPhone);

      // ── Construir payload com mídia se houver ───────────────────────────────
      const payload = {
        from: finalJid,
        body: text,
        fromMe: false,
        hasMedia: hasDocument || hasImage || hasVideo,
        media: hasDocument ? {
          url: documentMsg.url,
          mimetype: documentMsg.mimetype,
          filename: documentMsg.fileName || documentMsg.title || 'documento.pdf',
          size: documentMsg.fileLength,
        } : hasImage ? {
          url: imageMsg.url,
          mimetype: imageMsg.mimetype,
          filename: imageMsg.fileName || 'imagem.jpg',
          size: imageMsg.fileLength,
        } : hasVideo ? {
          url: videoMsg.url,
          mimetype: videoMsg.mimetype,
          filename: videoMsg.fileName || 'video.mp4',
          size: videoMsg.fileLength,
        } : undefined,
        message: msgContent, // passar mensagem completa para contexto
      };

      try {
        const { handleWhatsAppMessage } = require('../routes/webhooks');
        await handleWhatsAppMessage({ event: 'message', session: 'baileys', data: payload });
      } catch (err) {
        console.error('[BAILEYS] ❌ Erro ao processar mensagem:', err.message);
      }
    }
  });

  sock = socket;

  // Disponibilizar socket para o document-processor (download de mídia)
  setDocSockRef(socket);

  return socket;
}

// ─── INIT ────────────────────────────────────────────────────────────────────
async function initBaileys() {
  console.log('[BAILEYS] 🚀 Init Baileys — DR.IAGO');
  retryCount = 0;
  reconnectDelay = 5000;
  return createSocket();
}

// ─── LISTENERS ────────────────────────────────────────────────────────────────
function addConnectionListener(fn) {
  connectionListeners.push(fn);
}

// ─── SEND MESSAGE ─────────────────────────────────────────────────────────────
function sanitizeText(text) {
  if (!text) return '';
  // Ensure we have a valid string before calling .normalize()
  const str = typeof text === 'string' ? text : String(text);
  // Normalize to NFC (standard form for WhatsApp)
  let clean = str.normalize('NFC');
  // Replace invalid surrogate pairs that cause �
  clean = clean.replace(/[\uD800-\uDFFF]/g, (match) => {
    // If it's an orphaned surrogate, replace with space
    return ' ';
  });
  // Remove CJK characters that leak through
  clean = clean.replace(/[\u4e00-\u9fff\u3000-\u303f\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]+/g, '');
  // Replace replacement character
  clean = clean.replace(/\ufffd/g, '');
  // Remove null bytes
  clean = clean.replace(/\0/g, '');
  return clean.trim();
}

// ─── SPLIT LONG MESSAGE ───────────────────────────────────────────────────────
function splitLongMessage(text, maxChars = 3800) {
  if (text.length <= maxChars) return [text];
  const chunks = [];
  const lines = text.split('\n');
  let current = '';
  for (const line of lines) {
    if ((current.length + line.length + 1) > maxChars && current.length > 0) {
      chunks.push(current.trim());
      current = line;
    } else {
      current += '\n' + line;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  // Fallback: split by chars if still too long
  const final = [];
  for (const chunk of chunks) {
    if (chunk.length <= maxChars) {
      final.push(chunk);
    } else {
      for (let i = 0; i < chunk.length; i += maxChars) {
        final.push(chunk.substring(i, i + maxChars));
      }
    }
  }
  return final;
}

// ─── SEND MESSAGE ─────────────────────────────────────────────────────────────
async function sendMessage(phone, text) {
  if (!sock) {
    console.error('[BAILEYS] ❌ Tentativa de enviar — socket não existe');
    return null;
  }
  if (!isConnected) {
    console.error('[BAILEYS] ❌ Tentativa de enviar — socket desconectado');
    return null;
  }
  try {
    const jid = phone.includes('@c.us') ? phone : normalizePhone(phone);
    const cleanText = sanitizeText(text);
    const chunks = splitLongMessage(cleanText);
    if (chunks.length > 1) {
      console.log('[BAILEYS] 📤 Enviando em ' + chunks.length + ' fragmentos...');
      for (let i = 0; i < chunks.length; i++) {
        const prefix = chunks.length > 1 ? '[' + (i + 1) + '/' + chunks.length + ']\n' : '';
        await sock.sendMessage(jid, { text: prefix + chunks[i] });
        if (i < chunks.length - 1) await new Promise(r => setTimeout(r, 800));
      }
      console.log('[BAILEYS] ✅ Enviados ' + chunks.length + ' fragmentos para ' + phone);
    } else {
      await sock.sendMessage(jid, { text: cleanText });
      console.log('[BAILEYS] ✅ Enviado para ' + phone);
    }
    return true;
  } catch (err) {
    console.error('[BAILEYS] ❌ Erro ao enviar:', err.message);
    if (err.message?.includes('socket') || err.message?.includes('not connected')) {
      isConnected = false;
    }
    return null;
  }
}

async function sendAudio(phone, audioBuffer) {
  if (!sock) {
    console.error('[BAILEYS] ❌ Tentativa de enviar áudio — socket não existe');
    return null;
  }
  if (!isConnected) {
    console.error('[BAILEYS] ❌ Tentativa de enviar áudio — socket desconectado');
    return null;
  }
  if (!audioBuffer || audioBuffer.length === 0) {
    console.warn('[BAILEYS] ⚠️ Buffer de áudio vazio — ignorando');
    return null;
  }
  try {
    const jid = phone.includes('@c.us') ? phone : normalizePhone(phone);
    const base64Audio = audioBuffer.toString('base64');
    const result = await sock.sendMessage(jid, {
      audio: Buffer.from(base64Audio, 'base64'),
      mimetype: 'audio/mpeg',
      ptt: false,
    });
    console.log('[BAILEYS] 🎤 Áudio enviado para ' + phone + ' (' + audioBuffer.length + ' bytes)');
    return result;
  } catch (err) {
    console.error('[BAILEYS] ❌ Erro ao enviar áudio:', err.message);
    if (err.message?.includes('socket') || err.message?.includes('not connected')) {
      isConnected = false;
    }
    return null;
  }
}

async function sendTyping(phone) {
  if (!sock || !isConnected) return;
  try {
    const jid = phone.includes('@c.us') ? phone : normalizePhone(phone);
    await sock.sendPresenceUpdate('composing', jid);
    console.log('[BAILEYS] 💬 Digitando enviado para ' + phone);
  } catch (err) {
    // Ignorar erros de presence — não é crítico
  }
}

// ─── NORMALIZE PHONE ──────────────────────────────────────────────────────────
function normalizePhone(phone) {
  let p = String(phone).replace(/\D/g, '');
  if (!p.startsWith('55')) p = '55' + p;
  if (p.length === 12) p = p.slice(0, 4) + '9' + p.slice(4);
  return p + '@c.us';
}

// ─── STATUS ─────────────────────────────────────────────────────────────────
function getStatus() {
  return {
    connected: isConnected,
    hasSock: !!sock,
    retryCount,
    sessionExists: existsSync(path.join(SESSION_DIR, 'creds.json'))
  };
}

// ─── LID RESOLUTION ───────────────────────────────────────────────────────────
// Reads Baileys session LID→phone mappings from disk
const lidCache = new Map();
const SESSION_LID_DIR = path.join(__dirname, '../../data/baileys-session');

function loadLidCache() {
  try {
    const files = require('fs').readdirSync(SESSION_LID_DIR);
    for (const f of files) {
      if (f.startsWith('lid-mapping-') && f.endsWith('_reverse.json')) {
        const lid = f.replace('lid-mapping-', '').replace('_reverse.json', '');
        const content = require('fs').readFileSync(path.join(SESSION_LID_DIR, f), 'utf8');
        const phone = JSON.parse(content);
        lidCache.set(lid, phone);
      }
    }
    console.log(`[BAILEYS] 📇 LID cache carregado: ${lidCache.size} entries`);
  } catch (err) {
    // Ignore
  }
}
loadLidCache();

async function getContactInfo(jid) {
  // First try cached LID mappings
  const lid = jid.replace('@lid', '').replace('@lid@c.us', '');
  if (lidCache.has(lid)) {
    return { waid: lidCache.get(lid) };
  }
  // Try store contacts
  if (sock?.store?.contacts?.[jid]) {
    return sock.store.contacts[jid];
  }
  // Try onWhatsApp for phone numbers
  if (sock?.onWhatsApp && jid.includes('@c.us')) {
    try {
      const phone = jid.replace('@c.us', '').replace('@s.whatsapp.net', '');
      const results = await sock.onWhatsApp(phone);
      if (results?.[0]?.exists) {
        return { waid: phone };
      }
    } catch (err) {
      // Ignore
    }
  }
  return null;
}

// ─── EXPORTS ─────────────────────────────────────────────────────────────────
module.exports = { initBaileys, sendMessage, sendAudio, sendTyping, normalizePhone, getStatus, addConnectionListener, getContactInfo };
