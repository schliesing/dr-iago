const express = require('express');
const { MSG_BOAS_VINDAS } = require('../messages');
const { sendMessage } = require('../agent/evolution');
const { getStatus: getBaileysStatus } = require('../agent/baileys-client');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const cheerio = require('cheerio');
const axios = require('axios');
const { getDb } = require('../db/database');

// Upload em memória
const MAX_UPLOAD_MB = parseInt(process.env.MAX_UPLOAD_MB || '25', 10);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['.pdf', '.txt', '.docx', '.doc', '.html', '.htm'];
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, allowed.includes(ext));
  }
});

// Fail-closed: sem JWT_SECRET forte, qualquer um forjaria token de admin
// (o fallback antigo || 'secret' era uma chave pública conhecida).
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET || JWT_SECRET.length < 20) {
  console.error('[AUTH] ❌ JWT_SECRET ausente ou curto (<20 chars) no .env — abortando boot');
  process.exit(1);
}

// Middleware de autenticação
function authMiddleware(req, res, next) {
  const token = req.cookies?.token || req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Não autorizado' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Token inválido' });
  }
}

// Brute-force: o limiter global (60/min) permitiria 86k tentativas de senha/dia
const rateLimit = require('express-rate-limit');
const loginLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitas tentativas de login. Aguarde 1 minuto.' }
});

// ─── AUTH ────────────────────────────────────────────────────────────────────
// Baileys status — público (sem auth)
router.get('/baileys/status', (req, res) => {
  const status = getBaileysStatus();
  res.json({ whatsapp: status, timestamp: new Date().toISOString() });
});

router.post('/auth/login', loginLimiter, (req, res) => {
  const { username, password } = req.body;
  const db = getDb();
  const user = db.prepare("SELECT * FROM admin_users WHERE username = ?").get(username);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Usuário ou senha incorretos' });
  }
  const token = jwt.sign({ id: user.id, username }, JWT_SECRET, { expiresIn: '12h' });
  res.cookie('token', token, { httpOnly: true, sameSite: 'lax', maxAge: 43200000 });
  res.json({ success: true, token });
});

router.post('/auth/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ success: true });
});

// ─── SUBSCRIBERS ─────────────────────────────────────────────────────────────
router.get('/subscribers', authMiddleware, (req, res) => {
  const db = getDb();
  const { search, status, from, to, origin } = req.query;
  let query = "SELECT * FROM subscribers WHERE 1=1";
  const params = [];
  if (search) {
    query += " AND (name LIKE ? OR phone LIKE ? OR email LIKE ?)";
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }
  if (status) { query += " AND status = ?"; params.push(status); }
  if (origin) { query += " AND origin = ?"; params.push(origin); }
  if (from)   { query += " AND date(activated_at) >= date(?)"; params.push(from); }
  if (to)     { query += " AND date(activated_at) <= date(?)"; params.push(to); }
  query += " ORDER BY created_at DESC";
  res.json(db.prepare(query).all(...params));
});
router.post('/subscribers', authMiddleware, (req, res) => {
  const { name, phone, email, status, origin } = req.body;
  if (!name || !phone) return res.status(400).json({ error: 'Nome e telefone são obrigatórios' });
  const db = getDb();
  const now = new Date().toISOString();
  try {
    const result = db.prepare(
      "INSERT INTO subscribers (name, phone, email, status, origin, activated_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(name, phone.replace(/\D/g, ''), email || null, status || 'active', origin || 'manual', status === 'active' ? now : null);
    
    // Enviar mensagem de boas-vindas para novos assinantes
    if ((origin === 'manual' || !origin) && status === 'active') {
      sendMessage(phone.replace(/\D/g, ''), MSG_BOAS_VINDAS(name)).catch(err => console.error("Erro ao enviar boas-vindas:", err.message));
    }
    
    triggerWebhooks('subscriber:created', { id: result.lastInsertRowid, name, phone, status }).catch(() => {});
    res.json({ id: result.lastInsertRowid, success: true });
  } catch (err) {
    if (err.message.includes('UNIQUE')) return res.status(400).json({ error: 'Telefone já cadastrado' });
    res.status(500).json({ error: err.message });
  }
});
router.put('/subscribers/:id', authMiddleware, (req, res) => {
  const { name, phone, email, status } = req.body;
  const db = getDb();
  const now = new Date().toISOString();
  const current = db.prepare("SELECT * FROM subscribers WHERE id = ?").get(req.params.id);
  if (!current) return res.status(404).json({ error: 'Não encontrado' });
  const activated_at = (status === 'active' && current.status !== 'active') ? now : current.activated_at;
  db.prepare(
    "UPDATE subscribers SET name=?, phone=?, email=?, status=?, activated_at=?, updated_at=? WHERE id=?"
  ).run(name, phone?.replace(/\D/g, '') || current.phone, email || null, status, activated_at, now, req.params.id);
  res.json({ success: true });
});

router.delete('/subscribers/:id', authMiddleware, (req, res) => {
  getDb().prepare("DELETE FROM subscribers WHERE id = ?").run(req.params.id);
  res.json({ success: true });
});

// Estatísticas de um assinante
router.get('/subscribers/:id/stats', authMiddleware, (req, res) => {
  const db = getDb();
  const sub = db.prepare("SELECT * FROM subscribers WHERE id = ?").get(req.params.id);
  if (!sub) return res.status(404).json({ error: 'Não encontrado' });
  const total_msgs = db.prepare("SELECT COUNT(*) as n FROM conversations WHERE phone = ?").get(sub.phone).n;
  const user_msgs  = db.prepare("SELECT COUNT(*) as n FROM conversations WHERE phone = ? AND role = 'user'").get(sub.phone).n;
  const last_contact = db.prepare("SELECT created_at FROM conversations WHERE phone = ? ORDER BY created_at DESC LIMIT 1").get(sub.phone);
  const first_msg = db.prepare("SELECT created_at FROM conversations WHERE phone = ? ORDER BY created_at ASC LIMIT 1").get(sub.phone);
  const msgs_7d = db.prepare("SELECT COUNT(*) as n FROM conversations WHERE phone = ? AND created_at >= datetime('now', '-7 days')").get(sub.phone).n;
  res.json({
    ...sub,
    total_msgs,
    user_msgs,
    assistant_msgs: total_msgs - user_msgs,
    last_contact: last_contact?.created_at || null,
    first_msg: first_msg?.created_at || null,
    msgs_7d,
    response_rate: user_msgs > 0 ? Math.round(((total_msgs - user_msgs) / user_msgs) * 100) : 0
  });
});

// Exportar CSV
router.get('/subscribers/export', authMiddleware, (req, res) => {
  const db = getDb();
  const subs = db.prepare("SELECT name, phone, email, status, origin, activated_at, created_at FROM subscribers ORDER BY created_at DESC").all();
  const BOM = '\uFEFF';
  const header = 'Nome,Telefone,Email,Status,Origem,Ativado em,Cadastrado em\n';
  const rows = subs.map(s => [
    `"${(s.name || '').replace(/"/g, '""')}"`,
    s.phone || '',
    `"${(s.email || '').replace(/"/g, '""')}"`,
    s.status || '',
    s.origin || 'manual',
    s.activated_at ? new Date(s.activated_at).toLocaleDateString('pt-BR') : '',
    s.created_at ? new Date(s.created_at).toLocaleDateString('pt-BR') : ''
  ].join(',')).join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="assinantes-${new Date().toISOString().slice(0,10)}.csv"`);
  res.send(BOM + header + rows);
});

// ─── SYSTEM PROMPT ────────────────────────────────────────────────────────────
router.get('/config/prompt', authMiddleware, (req, res) => {
  const config = getDb().prepare("SELECT value FROM system_config WHERE key = 'system_prompt'").get();
  res.json({ prompt: config?.value || '' });
});

router.put('/config/prompt', authMiddleware, (req, res) => {
  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: 'Prompt não pode ser vazio' });
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare("INSERT OR REPLACE INTO system_config (key, value, updated_at) VALUES ('system_prompt', ?, ?)").run(prompt, now);
  res.json({ success: true });
});

// Testar prompt com DeepSeek
router.post('/config/prompt/test', authMiddleware, async (req, res) => {
  const { prompt, message } = req.body;
  if (!prompt || !message) return res.status(400).json({ error: 'Prompt e mensagem são obrigatórios' });
  try {
    const response = await axios.post(
      'https://api.deepseek.com/chat/completions',
      {
        model: 'deepseek-chat',
        messages: [
          { role: 'system', content: prompt },
          { role: 'user', content: message }
        ],
        max_tokens: 512,
        temperature: 0.7
      },
      {
        headers: {
          'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: 30000
      }
    );
    res.json({ reply: response.data.choices[0].message.content });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao testar: ' + (err.response?.data?.error?.message || err.message) });
  }
});

// ─── KNOWLEDGE DOCS ───────────────────────────────────────────────────────────
router.get('/docs', authMiddleware, (req, res) => {
  const docs = getDb().prepare("SELECT id, original_name, size, uploaded_at FROM knowledge_docs ORDER BY uploaded_at DESC").all();
  res.json(docs);
});

router.post('/docs', authMiddleware, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Arquivo não enviado ou formato inválido' });
  try {
    let content = '';
    const ext = path.extname(req.file.originalname).toLowerCase();
    if (ext === '.pdf') {
      const data = await pdfParse(req.file.buffer);
      content = data.text;
    } else if (ext === '.docx' || ext === '.doc') {
      const result = await mammoth.extractRawText({ buffer: req.file.buffer });
      content = result.value;
    } else if (ext === '.html' || ext === '.htm') {
      const htmlString = req.file.buffer.toString('utf-8');
      const $ = cheerio.load(htmlString);
      $('script').remove();
      $('style').remove();
      content = $.text().trim();
    } else {
      content = req.file.buffer.toString('utf-8');
    }
    const db = getDb();
    const result = db.prepare(
      "INSERT INTO knowledge_docs (filename, original_name, content, size) VALUES (?, ?, ?, ?)"
    ).run(`doc_${Date.now()}${ext}`, req.file.originalname, content, req.file.size);

    let ragIndexed = false;
    if (process.env.RAG_INDEX_UPLOADS !== 'false' && content.trim().length > 0) {
      try {
        const rag = require('../rag');
        const chunks = await rag.addDocument(content, {
          docId: `knowledge_doc_${result.lastInsertRowid}`,
          name: req.file.originalname,
          type: 'documento',
        });
        ragIndexed = chunks > 0;
        console.log(`[DOCS] RAG indexou upload ${req.file.originalname}: ${chunks} chunks`);
      } catch (ragErr) {
        console.warn(`[DOCS] Upload salvo, mas RAG não indexou: ${ragErr.message}`);
      }
    }

    res.json({ id: result.lastInsertRowid, success: true, ragIndexed });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao processar arquivo: ' + err.message });
  }
});

router.delete('/docs/:id', authMiddleware, async (req, res) => {
  const db = getDb();
  const doc = db.prepare("SELECT id, original_name FROM knowledge_docs WHERE id = ?").get(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Documento não encontrado' });

  db.prepare("DELETE FROM knowledge_docs WHERE id = ?").run(req.params.id);

  let ragDeleted = false;
  try {
    const rag = require('../rag');
    ragDeleted = await rag.deleteByDocId(`knowledge_doc_${doc.id}`);
  } catch (ragErr) {
    console.warn(`[DOCS] Documento removido do SQLite, mas RAG não removeu vetores: ${ragErr.message}`);
  }

  res.json({ success: true, ragDeleted });
});

// ─── STATS ────────────────────────────────────────────────────────────────────
router.get('/stats', authMiddleware, (req, res) => {
  const db = getDb();
  const total = db.prepare("SELECT COUNT(*) as n FROM subscribers").get().n;
  const active = db.prepare("SELECT COUNT(*) as n FROM subscribers WHERE status='active'").get().n;
  const inactive = db.prepare("SELECT COUNT(*) as n FROM subscribers WHERE status='inactive'").get().n;
  const docs = db.prepare("SELECT COUNT(*) as n FROM knowledge_docs").get().n;
  const msgs_today = db.prepare("SELECT COUNT(*) as n FROM conversations WHERE date(created_at)=date('now')").get().n;
  res.json({ total, active, inactive, docs, msgs_today });
});

// Dados para gráficos
router.get('/stats/charts', authMiddleware, (req, res) => {
  const db = getDb();

  const subscriberGrowth = db.prepare(`
    SELECT strftime('%Y-%W', created_at) as week,
           COUNT(*) as total
    FROM subscribers
    WHERE created_at >= datetime('now', '-30 days')
    GROUP BY week ORDER BY week
  `).all();

  const msgsPerDay = db.prepare(`
    SELECT date(created_at) as day, COUNT(*) as total
    FROM conversations
    WHERE created_at >= datetime('now', '-7 days') AND role = 'user'
    GROUP BY day ORDER BY day
  `).all();

  const byStatus = db.prepare(`
    SELECT status, COUNT(*) as total FROM subscribers GROUP BY status
  `).all();

  const byMonth = db.prepare(`
    SELECT strftime('%Y-%m', created_at) as month, COUNT(*) as total
    FROM subscribers
    WHERE created_at >= datetime('now', '-6 months')
    GROUP BY month ORDER BY month
  `).all();

  res.json({ subscriberGrowth, msgsPerDay, byStatus, byMonth });
});

// ─── MESSAGE LOGS ─────────────────────────────────────────────────────────────
router.get('/messages', authMiddleware, (req, res) => {
  const db = getDb();
  const { search, page = 1, limit = 20 } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(limit);
  let where = "WHERE 1=1";
  const params = [];
  if (search) {
    where += " AND (c.phone LIKE ? OR c.content LIKE ?)";
    params.push(`%${search}%`, `%${search}%`);
  }
  const total = db.prepare(`SELECT COUNT(*) as n FROM conversations c ${where}`).get(...params).n;
  const msgs  = db.prepare(`SELECT c.*, s.name as subscriber_name FROM conversations c LEFT JOIN subscribers s ON c.phone = s.phone ${where} ORDER BY c.created_at DESC LIMIT ? OFFSET ?`).all(...params, parseInt(limit), offset);
  res.json({ msgs, total, pages: Math.ceil(total / parseInt(limit)), page: parseInt(page) });
});

// ─── BACKUP ───────────────────────────────────────────────────────────────────
router.post('/backup', authMiddleware, async (req, res) => {
  try {
    const backupDir = path.join(__dirname, '../../backups');
    if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });

    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const backupPath = path.join(backupDir, `backup-${ts}.db`);

    const db = getDb();
    await db.backup(backupPath);

    const files = fs.readdirSync(backupDir)
      .filter(f => f.endsWith('.db'))
      .map(f => ({ name: f, time: fs.statSync(path.join(backupDir, f)).mtimeMs }))
      .sort((a, b) => b.time - a.time);

    files.slice(7).forEach(f => fs.unlinkSync(path.join(backupDir, f.name)));

    res.json({ success: true, file: `backup-${ts}.db`, path: backupPath });
  } catch (err) {
    res.status(500).json({ error: 'Erro no backup: ' + err.message });
  }
});

router.get('/backup/list', authMiddleware, (req, res) => {
  try {
    const backupDir = path.join(__dirname, '../../backups');
    if (!fs.existsSync(backupDir)) return res.json([]);
    const files = fs.readdirSync(backupDir)
      .filter(f => f.endsWith('.db'))
      .map(f => {
        const stat = fs.statSync(path.join(backupDir, f));
        return { name: f, size: stat.size, created_at: stat.mtime.toISOString() };
      })
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    res.json(files);
  } catch (err) {
    res.json([]);
  }
});

// ─── CUSTOM WEBHOOKS ──────────────────────────────────────────────────────────
router.get('/webhooks', authMiddleware, (req, res) => {
  res.json(getDb().prepare("SELECT * FROM custom_webhooks ORDER BY created_at DESC").all());
});

router.post('/webhooks', authMiddleware, (req, res) => {
  const { url, description, events } = req.body;
  if (!url) return res.status(400).json({ error: 'URL é obrigatória' });
  try { new URL(url); } catch { return res.status(400).json({ error: 'URL inválida' }); }
  const db = getDb();
  const result = db.prepare(
    "INSERT INTO custom_webhooks (url, description, events) VALUES (?, ?, ?)"
  ).run(url, description || '', events || 'subscriber:created,message:sent');
  res.json({ id: result.lastInsertRowid, success: true });
});

router.put('/webhooks/:id', authMiddleware, (req, res) => {
  const { url, description, events, active } = req.body;
  const db = getDb();
  const wh = db.prepare("SELECT * FROM custom_webhooks WHERE id = ?").get(req.params.id);
  if (!wh) return res.status(404).json({ error: 'Não encontrado' });
  db.prepare("UPDATE custom_webhooks SET url=?, description=?, events=?, active=? WHERE id=?")
    .run(url || wh.url, description ?? wh.description, events || wh.events, active !== undefined ? (active ? 1 : 0) : wh.active, req.params.id);
  res.json({ success: true });
});

router.delete('/webhooks/:id', authMiddleware, (req, res) => {
  getDb().prepare("DELETE FROM custom_webhooks WHERE id = ?").run(req.params.id);
  res.json({ success: true });
});

// ─── WEBHOOK DISPATCHER ───────────────────────────────────────────────────────
async function triggerWebhooks(event, payload) {
  const db = getDb();
  const webhooks = db.prepare(
    "SELECT * FROM custom_webhooks WHERE active = 1 AND events LIKE ?"
  ).all(`%${event}%`);

  for (const wh of webhooks) {
    let attempts = 0;
    let success = false;
    while (attempts < 3 && !success) {
      try {
        await axios.post(wh.url, { event, data: payload, timestamp: new Date().toISOString() }, { timeout: 5000 });
        success = true;
        db.prepare("UPDATE custom_webhooks SET fail_count=0, last_triggered=? WHERE id=?").run(new Date().toISOString(), wh.id);
      } catch {
        attempts++;
        if (attempts < 3) await new Promise(r => setTimeout(r, 1000 * attempts));
      }
    }
    if (!success) {
      const newFails = wh.fail_count + 1;
      db.prepare("UPDATE custom_webhooks SET fail_count=? WHERE id=?").run(newFails, wh.id);
    }
  }
}


// ─── IMPORTAR ASSINANTES (CSV / XLSX) ────────────────────────────────────────
const uploadImport = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (['.csv', '.xlsx', '.xls'].includes(ext)) cb(null, true);
    else cb(new Error('Apenas CSV ou XLSX permitido'));
  }
});

router.post('/subscribers/import', authMiddleware, uploadImport.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado' });
  try {
    const xlsx = require('xlsx');
    const ext = path.extname(req.file.originalname).toLowerCase();
    let rows = [];

    if (ext === '.csv') {
      // Lê CSV
      const text = req.file.buffer.toString('utf-8').replace(/^\uFEFF/, ''); // remove BOM
      const workbook = xlsx.read(text, { type: 'string' });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      rows = xlsx.utils.sheet_to_json(sheet, { defval: '' });
    } else {
      // Lê XLSX/XLS
      const workbook = xlsx.read(req.file.buffer, { type: 'buffer' });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      rows = xlsx.utils.sheet_to_json(sheet, { defval: '' });
    }

    if (!rows.length) return res.status(400).json({ error: 'Planilha vazia ou formato inválido' });

    const db = getDb();
    const now = new Date().toISOString();
    let imported = 0, skipped = 0, errors = [];

    // Detectar colunas automaticamente (case-insensitive)
    const firstRow = rows[0];
    const cols = Object.keys(firstRow);

    function findCol(keys) {
      return cols.find(c => keys.some(k => c.toLowerCase().trim().includes(k))) || null;
    }

    const colName  = findCol(['nome', 'name', 'cliente', 'client']);
    const colPhone = findCol(['telefone', 'phone', 'fone', 'celular', 'whatsapp', 'tel', 'número', 'numero']);
    const colEmail = findCol(['email', 'e-mail', 'mail']);

    if (!colPhone) {
      return res.status(400).json({ 
        error: `Coluna de telefone não encontrada. Colunas disponíveis: ${cols.join(', ')}` 
      });
    }

    for (const row of rows) {
      const rawPhone = String(row[colPhone] || '').trim();
      const name     = colName  ? String(row[colName] || '').trim()  : 'Assinante';
      const email    = colEmail ? String(row[colEmail] || '').trim() : null;

      if (!rawPhone) { skipped++; continue; }

      const phone = rawPhone.replace(/\D/g, '');
      if (phone.length < 8) { skipped++; errors.push(`Telefone inválido: ${rawPhone}`); continue; }

      // Adiciona código do país se não tiver
      const normalizedPhone = phone.startsWith('55') ? phone : '55' + phone;

      try {
        db.prepare(
          "INSERT INTO subscribers (name, phone, email, status, origin, activated_at, created_at, updated_at) VALUES (?, ?, ?, 'active', 'manual', ?, ?, ?)"
        ).run(name || 'Assinante', normalizedPhone, email || null, now, now, now);
        imported++;
      } catch (err) {
        if (err.message.includes('UNIQUE')) {
          skipped++;
        } else {
          errors.push(`${name} (${normalizedPhone}): ${err.message}`);
        }
      }
    }

    console.log(`📊 Importação: ${imported} importados, ${skipped} ignorados`);
    res.json({ 
      success: true, 
      imported, 
      skipped, 
      total: rows.length,
      errors: errors.slice(0, 10)
    });
  } catch (err) {
    console.error('❌ Erro na importação:', err.message);
    res.status(500).json({ error: 'Erro ao processar arquivo: ' + err.message });
  }
});

// ─── RAG ROUTES ─────────────────────────────────────────────────────────────────
let ragRouter = null;
try {
  const rag = require('../rag');
  const router_rag = express.Router();

  // Status do RAG
  router_rag.get('/status', authMiddleware, async (req, res) => {
    try {
      const status = await rag.checkStatus();
      res.json(status);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Indexar base de conhecimento
  router_rag.post('/index', authMiddleware, async (req, res) => {
    try {
      const { reindex = false } = req.body;
      console.log(`[API/RAG] Indexando base... (reindex=${reindex})`);
      const result = await rag.indexKnowledgeBase({ reindex, verbose: true });
      res.json({ success: true, ...result });
    } catch (err) {
      console.error('[API/RAG] ❌ Erro ao indexar:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // Seed documentos-base
  router_rag.post('/seed', authMiddleware, async (req, res) => {
    try {
      const count = await rag.seedDefaultDocuments();
      res.json({ success: true, documentsCreated: count });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Adicionar documento ao RAG
  router_rag.post('/add', authMiddleware, async (req, res) => {
    try {
      const { content, name, type = 'documento' } = req.body;
      if (!content) return res.status(400).json({ error: 'Conteúdo é obrigatório' });

      const chunks = await rag.addDocument(content, {
        docId: `doc_${Date.now()}`,
        name: name || 'documento',
        type,
      });

      res.json({ success: true, chunks });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Testar busca RAG
  router_rag.post('/test', authMiddleware, async (req, res) => {
    try {
      const { query, topK = 4 } = req.body;
      if (!query) return res.status(400).json({ error: 'Query é obrigatória' });

      const result = await rag.retrieve(query, { topK, useReranking: true });

      res.json({
        query,
        results: result.results,
        stats: result.stats,
        context: result.context?.substring(0, 1000) + '...',
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Toggle RAG
  router_rag.put('/toggle', authMiddleware, async (req, res) => {
    const { enabled } = req.body;
    process.env.RAG_ENABLED = String(enabled);
    res.json({ success: true, ragEnabled: enabled });
  });

  ragRouter = router_rag;
  console.log('[API] ✅ Rotas RAG carregadas');
} catch (err) {
  console.warn('[API] ⚠️ RAG não disponível:', err.message);
}

// Registra rotas RAG
if (ragRouter) {
  router.use('/rag', ragRouter);
}

// ─── RAG AUTONOMOUS AGENT ───────────────────────────────────────────────────────
/**
 * Test RAG agent - autonomous legal document analysis
 */
router.post('/rag/agent/test', authMiddleware, async (req, res) => {
  try {
    const rag = require('../rag');
    const { query } = req.body;
    if (!query) return res.status(400).json({ error: 'Query é obrigatória' });

    console.log(`[RAG/AGENT] Query: "${query}"`);

    // 1. Retrieve
    const retrieval = await rag.retrieve(query, { topK: 5, useReranking: true });
    console.log(`[RAG/AGENT] Encontradas ${retrieval.results.length} fontes`);

    // 2. Build prompt
    const prompt = rag.retriever.buildRagPrompt(query, retrieval.context, '');

    // 3. Call DeepSeek
    const response = await axios.post(
      'https://api.deepseek.com/chat/completions',
      {
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 1024,
        temperature: 0.7,
      },
      {
        headers: {
          'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: 60000
      }
    );

    let answer = response.data.choices[0].message.content.replace(/\*/g, '');

    // 4. Append sources
    if (retrieval.results?.length > 0) {
      const sources = rag.formatSourcesForWhatsApp(retrieval.results);
      answer += sources;
    }

    res.json({
      query,
      answer,
      sources: retrieval.stats?.sources || [],
      stats: retrieval.stats,
    });
  } catch (err) {
    console.error('[RAG/AGENT] ❌ Erro:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = { router, authMiddleware, triggerWebhooks };
