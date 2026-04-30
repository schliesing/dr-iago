/**
 * QR Code Server — DR.IAGO via Baileys
 * Porta 3007 — serve página de QR e PNG do Baileys session.
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.QR_PORT || 3007;
const BAILEYS_SESSION_DIR = path.join(__dirname, 'data/baileys-session');
const QR_PATH = path.join(BAILEYS_SESSION_DIR, 'qr.png');

const HTML = `
<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>DR.IAGO — Conectar WhatsApp</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, sans-serif;
      background: linear-gradient(135deg, #0A0A0A 0%, #1A1A1A 100%);
      color: #FAFAFA;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .container {
      background: #1A1A1A;
      border-radius: 20px;
      padding: 40px;
      max-width: 500px;
      width: 100%;
      text-align: center;
      border: 1px solid #D4AF37;
      box-shadow: 0 20px 60px rgba(212, 175, 55, 0.1);
    }
    h1 { color: #D4AF37; margin-bottom: 8px; font-size: 28px; }
    .subtitle { color: #A0A0A0; margin-bottom: 25px; font-size: 15px; }
    .status-badge {
      display: inline-block;
      padding: 6px 16px;
      border-radius: 20px;
      font-size: 13px;
      font-weight: 600;
      margin-bottom: 20px;
    }
    .status-scan { background: rgba(255,165,0,.2); color: #FFA500; border: 1px solid #FFA500; }
    .status-ok { background: rgba(0,200,83,.2); color: #00C853; border: 1px solid #00C853; }
    .qr-wrapper { background: white; padding: 20px; border-radius: 16px; display: inline-block; margin: 15px 0; }
    .qr-wrapper img { display: block; width: 256px; height: 256px; }
    .instructions { margin-top: 25px; text-align: left; }
    .instructions h3 { color: #D4AF37; font-size: 16px; margin-bottom: 12px; }
    .instructions ol { color: #A0A0A0; line-height: 2; padding-left: 20px; font-size: 14px; }
    .warning { background: rgba(212,175,55,.1); border: 1px solid #D4AF37; border-radius: 10px; padding: 12px 15px; margin-top: 20px; font-size: 13px; color: #D4AF37; }
    .note { color: #555; font-size: 12px; margin-top: 15px; }
    .loading { color: #FFA500; font-size: 14px; padding: 60px; }
    .spinner { display:inline-block; width:30px; height:30px; border:3px solid rgba(255,165,0,.2); border-top-color:#FFA500; border-radius:50%; animation:spin 1s linear infinite; margin-right:10px; }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <div class="container">
    <h1>DR.IAGO</h1>
    <p class="subtitle">Conexão via Baileys — escaneie o QR Code</p>
    <div id="status-badge" class="status-badge status-scan">⏳ QR Code ativo — escaneie em 60s</div>
    <div class="qr-wrapper" id="qr-wrapper">
      <div class="loading"><div class="spinner"></div>Carregando QR Code...</div>
    </div>
    <div class="instructions">
      <h3>Como escanear:</h3>
      <ol>
        <li>Abra o WhatsApp no celular</li>
        <li>Toque nos 3 pontinhos (⋮) → Aparelhos conectados</li>
        <li>Toque em <strong>"Conectar um aparelho"</strong></li>
        <li>Escaneie o QR Code acima</li>
      </ol>
    </div>
    <div class="warning">
      QR Code expira em 60 segundos.<br>
      A página atualiza automaticamente quando um novo QR é gerado.
    </div>
    <p class="note">DR.IAGO © 2026 — Agente de Licitações via WhatsApp</p>
  </div>
  <script>
    const qrWrapper = document.getElementById('qr-wrapper');
    const statusBadge = document.getElementById('status-badge');
    function loadQR() {
      qrWrapper.innerHTML = '<div class="loading"><div class="spinner"></div>Carregando QR Code...</div>';
      statusBadge.textContent = '⏳ Carregando...';
      statusBadge.className = 'status-badge status-scan';
      fetch('/qr?t=' + Date.now(), { cache: 'no-store' })
        .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.blob(); })
        .then(blob => {
          qrWrapper.innerHTML = '<img src="' + URL.createObjectURL(blob) + '" alt="QR" style="display:block;width:256px;height:256px;" />';
          statusBadge.textContent = '✅ QR Code ativo — escaneie agora!';
          statusBadge.className = 'status-badge status-scan';
        })
        .catch(() => {
          qrWrapper.innerHTML = '<div class="loading" style="color:#FF6B6B;">QR indisponível. Recarregue em 10s.</div>';
          statusBadge.textContent = '❌ QR indisponível';
          statusBadge.className = 'status-badge status-scan';
        });
    }
    loadQR();
    setInterval(loadQR, 5000);
  </script>
</body>
</html>
`;

app.get('/', (req, res) => { res.set('Content-Type','text/html'); res.send(HTML); });

app.get('/qr', (req, res) => {
  if (!fs.existsSync(QR_PATH)) {
    return res.status(404).type('text/plain').send('QR not ready — Baileys may still be starting');
  }
  res.set('Content-Type', 'image/png');
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.sendFile(QR_PATH);
});

app.listen(PORT, () => {
  console.log(`[QR] 🌐 Página QR:     http://5.189.156.236:${PORT}`);
  console.log(`[QR] 📱 QR PNG direto: http://5.189.156.236:${PORT}/qr`);
});
