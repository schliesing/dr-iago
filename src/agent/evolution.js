/**
 * Evolution.js — DR.IAGO
 * Wrapper de envio WhatsApp via Baileys.
 * Encapsula a lógica de transporte para o restantes da app.
 */
const { sendMessage: baileysSend, normalizePhone, getContactInfo } = require('./baileys-client');

async function sendMessage(phone, text) {
  try {
    const result = await baileysSend(phone, text);
    if (result) {
      console.log('✅ Mensagem enviada para ' + phone);
    }
    return result;
  } catch (err) {
    console.error('❌ Erro ao enviar para ' + phone + ':', err.message);
    return null;
  }
}

async function resolveLid(fromRaw) {
  try {
    const info = await getContactInfo(fromRaw);
    if (info?.waid) {
      console.log('[resolveLid] ✅ LID ' + fromRaw + ' → ' + info.waid);
      return info.waid;
    }
  } catch (err) {
    console.warn('[resolveLid] ⚠️ Falha ao resolver LID ' + fromRaw + ': ' + err.message);
  }
  return null;
}

module.exports = { sendMessage, normalizePhone, resolveLid };
