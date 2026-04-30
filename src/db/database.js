const Database = require('better-sqlite3');
const path = require('path');
const bcrypt = require('bcryptjs');

const DB_PATH = path.join(__dirname, '../../data/driago.db');

let db;

function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    initSchema();
  }
  return db;
}

function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS subscribers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      phone TEXT UNIQUE NOT NULL,
      email TEXT,
      status TEXT DEFAULT 'inactive' CHECK(status IN ('active', 'inactive', 'blocked')),
      kiwify_id TEXT,
      activated_at TEXT,
      expires_at TEXT,
      permanent INTEGER DEFAULT 0,
      origin TEXT DEFAULT 'manual',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
      content TEXT NOT NULL,
      status TEXT DEFAULT 'sent',
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS system_config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS knowledge_docs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filename TEXT NOT NULL,
      original_name TEXT NOT NULL,
      content TEXT NOT NULL,
      size INTEGER,
      uploaded_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS admin_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS custom_webhooks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      url TEXT NOT NULL,
      description TEXT,
      events TEXT DEFAULT 'subscriber:created,message:sent',
      active INTEGER DEFAULT 1,
      fail_count INTEGER DEFAULT 0,
      last_triggered TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS document_contexts (
      phone TEXT NOT NULL,
      filename TEXT NOT NULL,
      context TEXT NOT NULL,
      size INTEGER,
      injected_at TEXT DEFAULT (datetime('now')),
      expires_at TEXT,
      PRIMARY KEY (phone)
    );
  `);

  // Migrações seguras (colunas que podem não existir em bancos antigos)
  const migrations = [
    'ALTER TABLE subscribers ADD COLUMN permanent INTEGER DEFAULT 0',
    'ALTER TABLE subscribers ADD COLUMN origin TEXT DEFAULT "manual"',
    'ALTER TABLE conversations ADD COLUMN status TEXT DEFAULT "sent"',
  ];
  for (const sql of migrations) {
    try { db.exec(sql); } catch (e) { /* coluna já existe */ }
  }

  // System prompt padrão
  const existingPrompt = db.prepare("SELECT value FROM system_config WHERE key = 'system_prompt'").get();
  if (!existingPrompt) {
    db.prepare("INSERT INTO system_config (key, value) VALUES ('system_prompt', ?)").run(
      `Você é o Dr. IAgo, assistente especializado em licitações e contratos públicos brasileiros da Consultoria Schliesing.

Suas especialidades:
1. Análise de editais — identifique requisitos, prazos, exigências de habilitação e pontos críticos.
2. Revisão de contratos — identifique cláusulas problemáticas, riscos, multas abusivas e ausência de reequilíbrio econômico-financeiro.
3. Impugnações e recursos — fundamente com legislação (Lei 14.133/2021, Lei 8.666/93, LC 123/06) e jurisprudência do TCU.
4. Pesquisa de preços — oriente sobre metodologia conforme IN SEGES 73/2022 e Decreto 11.462/2023.
5. Legislação — domine Lei 14.133/2021, Lei 8.666/93, LC 123/06, Lei 10.520/02 e decretos regulamentadores.
6. Habilitação — verifique se documentação atende exigências do edital.

VALORES DE DISPENSA (Decreto 12.343/2024):
- Obras/serviços de engenharia: até R$ 119.812,06
- Compras/outros serviços: até R$ 59.906,02

Seja objetivo, técnico e sempre cite a legislação aplicável. Na primeira mensagem, apresente-se brevemente.`
    );
  }

  // Admin padrão — exige variáveis de ambiente, não usa defaults
  const adminUser = process.env.DASHBOARD_USER || 'admin';
  const existingAdmin = db.prepare("SELECT id FROM admin_users WHERE username = ?").get(adminUser);
  if (!existingAdmin) {
    const defaultPass = process.env.DASHBOARD_PASSWORD;
    if (!defaultPass) {
      console.error('[DB] ⚠️  DASHBOARD_PASSWORD não configurado — admin NÃO criado. Configure a variável para criar.');
    } else if (defaultPass.length < 8) {
      console.error('[DB] ⚠️  DASHBOARD_PASSWORD muito curta (mín 8 chars) — admin NÃO criado.');
    } else {
      const hash = bcrypt.hashSync(defaultPass, 10);
      db.prepare("INSERT INTO admin_users (username, password_hash) VALUES (?, ?)").run(adminUser, hash);
      console.log(`[DB] ✅ Admin criado: ${adminUser}`);
    }
  }
}

// ─── AUTO BACKUP ───────────────────────────────────────────────────────────
const fs = require('fs');
const BACKUP_DIR = path.join(__dirname, '../../backups');

function backupDb() {
  return new Promise((resolve) => {
    try {
      if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const dest = path.join(BACKUP_DIR, `driago-${ts}.db`);
      fs.copyFileSync(DB_PATH, dest);
      console.log(`[BACKUP] ✅ ${dest}`);

      // Mantém apenas os 7 backups mais recentes
      const files = fs.readdirSync(BACKUP_DIR).filter(f => f.startsWith('driago-')).sort().reverse();
      for (const f of files.slice(7)) {
        fs.unlinkSync(path.join(BACKUP_DIR, f));
      }
    } catch (e) {
      console.error('[BACKUP] ❌', e.message);
    }
    resolve();
  });
}

module.exports = { getDb, backupDb };
