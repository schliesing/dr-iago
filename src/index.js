require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const express = require('express');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const { getDb } = require('./db/database');
const { router: webhooksRouter } = require('./routes/webhooks');
const { router: apiRouter } = require('./routes/api');

const app = express();
const PORT = process.env.PORT || 3000;
const SERVER_URL = process.env.SERVER_URL || `http://srv1408227.hstgr.cloud:${PORT}`;

// ─── GRACEFUL SHUTDOWN ─────────────────────────────────────────────────────
let isShuttingDown = false;
let consecutiveErrors = 0;
const MAX_CONSECUTIVE_ERRORS = 10;

async function gracefulShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`\n[SHUTDOWN] 🛑 Sinal ${signal} recebido — fechando gracefully...`);

  // Parar de aceitar novas conexões
  server.close(async () => {
    console.log('[SHUTDOWN] ✅ HTTP server fechado');

    // Fechar conexão Baileys
    try {
      const { sock } = require('./agent/baileys-client');
      if (sock?.ws) {
        sock.ws.close();
        console.log('[SHUTDOWN] ✅ Baileys WebSocket fechado');
      }
    } catch (e) { /* ignore */ }

    // Backup do banco antes de sair
    try {
      const { backupDb } = require('./db/database');
      await backupDb();
    } catch (e) { /* ignore */ }

    console.log('[SHUTDOWN] ✅ Todos os recursos fechados. Tchau!');
    process.exit(0);
  });

  // Force exit após 15s
  setTimeout(() => {
    console.error('[SHUTDOWN] ⚠️ Timeout forçado (15s) — saindo');
    process.exit(1);
  }, 15000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// ─── SEGURANÇA ──────────────────────────────────────────────────────────────
// helmet: headers de segurança (X-Frame-Options, X-Content-Type-Options, etc.)
app.use(helmet());

// cors: origens configuráveis via CORS_ORIGINS
const allowedOrigins = (process.env.CORS_ORIGINS || '*').split(',').map(s => s.trim());
app.use(cors({
  origin: allowedOrigins.includes('*') ? '*' : allowedOrigins,
  credentials: true
}));

// Rate limit: 60 requisições/min por IP para webhooks e API
const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitas requisições. Tente novamente em alguns minutos.' }
});
app.use('/webhook', globalLimiter);
app.use('/api', globalLimiter);
app.use(express.json({ limit: '50mb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, '../dashboard/public')));

// Inicializa DB
getDb();
console.log('✅ Banco de dados inicializado');

// Webhooks
app.use('/webhook', webhooksRouter);

// API do dashboard
app.use('/api', apiRouter);

// Consecutive error tracking middleware
app.use((err, req, res, next) => {
  consecutiveErrors++;
  console.error(`[APP] ❌ Erro #${consecutiveErrors}: ${err.message}`);
  if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
    console.error('[APP] 🚨 Muitos erros consecutivos — reiniciando...');
    process.exit(1);
  }
  next(err);
});

// Health check — também mostra consecutivos
app.get('/health', (req, res) => {
  const mem = process.memoryUsage();
  res.json({
    status: 'ok',
    uptime: Math.floor(process.uptime()),
    memory_mb: Math.round(mem.heapUsed / 1024 / 1024),
    memory_rss_mb: Math.round(mem.rss / 1024 / 1024),
    consecutive_errors: consecutiveErrors,
    timestamp: new Date().toISOString(),
    version: '3.1'
  });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../dashboard/public/index.html'));
});

const server = app.listen(PORT, () => {
  console.log(`\n🚀 Dr. IAgo 3.1 rodando na porta ${PORT}`);
  console.log(`📊 Dashboard:          ${SERVER_URL}`);
  console.log(`📲 WhatsApp (Baileys): ${SERVER_URL}`);
  console.log(`🛒 Webhook Kiwify:     ${SERVER_URL}/webhook/kiwify`);

  // Cleanup periódico de contextos expirados (a cada 15 min)
  const { cleanupExpiredContexts } = require('./agent/context-injector');
  setInterval(cleanupExpiredContexts, 15 * 60 * 1000);
  console.log('[CTX] 🕒 Cleanup de contextos expirados agendado (a cada 15min)');

  // Baileys — conexão WhatsApp nativa
  const { initBaileys, addConnectionListener } = require('./agent/baileys-client');
  initBaileys().then(sock => {
    console.log('[APP] 🤖 Baileys inicializado');
    addConnectionListener(event => {
      if (event.type === 'connected') {
        console.log('[APP] ✅ WhatsApp conectado via Baileys');
      } else if (event.type === 'qr') {
        console.log('[APP] 📸 Novo QR gerado — escaneie em 60s');
      }
    });
  }).catch(err => {
    console.error('[APP] ❌ Falha ao iniciar Baileys:', err.message);
  });
});
