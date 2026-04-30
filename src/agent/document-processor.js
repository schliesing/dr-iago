/**
 * DR.IAGO — Document Processor v3
 * Extrai texto de PDFs via pdf-parse/pdftotext, organiza por tópicos de licitação,
 * e permite busca inteligente por palavras-chave.
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const axios = require('axios');
const path = require('path');
const os = require('os');
const { downloadMediaMessage } = require('@whiskeysockets/baileys');

const documentCacheByPhone = new Map();
const MAX_CACHE_SIZE = 10;

// ─── MAPA DE TÓPICOS DE EXTRAÇÃO ────────────────────────────────────────────
const TOPIC_KEYWORDS = {
  '1. IDENTIFICAÇÃO DO PROCESSO': [
    'modalidade', 'número do processo', 'número do pregão', 'uasg', 'órgão',
    'unidade', 'pncp', 'critério de julgamento', 'modo de disputa', 'aberto',
    'fechado', 'combinado', 'menor preço', 'maior desconto', 'melhor técnica',
    'pregoeiro', 'comissão de licitações', 'juízo de admissibilidade'
  ],
  '2. OBJETO E VALOR': [
    'objeto', 'descrição do objeto', 'catmat', 'catser', 'código do item',
    'unidade de medida', 'quantidade', 'valor estimado', 'valor máximo',
    'preço de referência', 'valor global', 'valor mensal', 'valor anual',
    'dotação orçamentária', 'fonte de recurso', 'ptres', 'orçamento sigiloso',
    'elemento de despesa', 'valor unitário', 'valor total'
  ],
  '3. PRAZOS': [
    'prazo de entrega', 'prazo de execução', 'prazo de vigência', 'prazo de prorrogação',
    'data de abertura', 'sessão pública', 'impugnação', 'esclarecimento', 'recurso',
    'contrarrazões', 'assinatura do contrato', 'início da execução', 'ordem de serviço',
    'recebimento provisório', 'recebimento definitivo', ' prazo ', 'vencimento',
    'validade da proposta', 'prazo de validade', 'cronograma'
  ],
  '4. HABILITAÇÃO': [
    'habilitação jurídica', 'regularidade fiscal', 'regularidade trabalhista',
    'qualificação técnica', 'qualificação econômico-financeira', 'sicaf',
    'certidão negativa', 'cnd', 'fgts', 'cndt', 'balanço patrimonial',
    'capital social', 'liquidez', 'atestado de capacidade técnica', 'acervo técnico',
    'crea', 'cau', 'cfm', 'registro profissional', 'falência', 'recuperação judicial',
    'habilitado', 'documentação de habilitação', 'envelope'
  ],
  '5. OBRIGAÇÕES': [
    'obrigações da contratante', 'obrigações da contratada', 'preposto', 'fiscal do contrato',
    'gestor do contrato', 'subcontratação', 'cessão', 'art', 'rrt',
    'encargos trabalhistas', 'encargos previdenciários', 'ordem de serviço',
    'medição', 'boletim de medição', 'aceite', 'conformidade', 'responsabilidade',
    'indenização', 'seguro', 'epp', 'microempresa', 'mei'
  ],
  '6. GARANTIAS': [
    'garantia contratual', 'garantia de proposta', 'caução', 'fiança bancária',
    'seguro-garantia', '5%', '10%', 'garantia adicional', 'prazo da garantia',
    'validade da garantia', 'garantia de execução', 'garantia do objeto'
  ],
  '7. REAJUSTE E REEQUILÍBRIO': [
    'reajuste', 'repactuação', 'revisão de preços', 'reequilíbrio econômico-financeiro',
    'ipca', 'inpc', 'igp-m', 'índice de reajuste', 'data-base', 'aniversário do contrato',
    'planilha de custos', 'fato superveniente', 'álea extraordinária', 'caso fortuito',
    'força maior', 'equilíbrio econômico', 'reajuste econômico', 'atualização monetária'
  ],
  '8. PENALIDADES': [
    'multa', 'multa moratória', 'multa compensatória', 'advertência', 'suspensão',
    'impedimento', 'declaração de inidoneidade', 'ceis', 'cnep', 'rescisão unilateral',
    'rescisão por inadimplemento', 'descredenciamento', 'percentual de multa',
    'prazo de inadimplemento', 'penalidade', 'sanção', 'glosas', 'multa diária'
  ],
  '9. ALERTAS — IRREGULARIDADES': [
    'exclusividade', 'inexigibilidade sem justificativa', 'restrição à competitividade',
    'exigência não prevista em lei', 'direcionamento', 'sobrepreço', 'superfaturamento',
    'aditivo acima de 25%', 'acréscimo', 'supressão', 'sem dotação', 'sem empenho',
    'prazo vencido', 'impedimento ativo', 'inidôneo', 'subcontratação vedada',
    'experiência exclusiva', 'marca específica', 'vedação', 'cláusula abusiva',
    'ilegal', 'irregularidade', 'fraude', 'corrupção', 'conluio', 'cartel'
  ]
};

// Stopwords para busca
const STOPWORDS = new Set([
  'o','a','os','as','um','uma','de','da','do','em','no','na','por','para','com','sem',
  'ao','à','e','é','que','se','não','nao','sim','mas','ou','como','mais','muito','já',
  'também','tem','são','foi','ser','ter','esse','essa','este','esta','isso','isto',
  'quem','qual','quando','onde','porque','até','ao','da','seu','sua','pelos','pelas',
  'esse','essa','este','esta','isso','isto','aquele','aquela','aquilo','entre','como'
]);

// ─── DOWNLOAD MEDIA VIA BAILEYS ────────────────────────────────────────────
let _sockRef = null;
function setSockRef(sock) { _sockRef = sock; }

async function downloadMedia(mediaUrlOrMsg, mimeType) {
  if (typeof mediaUrlOrMsg === 'string') {
    console.log('[DL] Baixando via URL direta: ' + mediaUrlOrMsg.substring(0, 80));
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const response = await axios.get(mediaUrlOrMsg, {
          responseType: 'arraybuffer', timeout: 90000,
          headers: { 'User-Agent': 'WhatsApp/2.24.14.23' }
        });
        const buffer = Buffer.from(response.data);
        console.log('[DL] Buffer: ' + buffer.length + ' bytes');
        return buffer;
      } catch (err) {
        console.error('[DL] Tentativa ' + attempt + ' falhou: ' + err.message);
        if (attempt < 3) await new Promise(r => setTimeout(r, 2000));
        else throw new Error('Falha ao baixar via URL após 3 tentativas: ' + err.message);
      }
    }
  }

  if (!_sockRef) throw new Error('Baileys sock não disponível para download');

  // ── Tentar documento ─────────────────────────────────────────────────────
  const docMsg =
    mediaUrlOrMsg?.documentMessage ||
    mediaUrlOrMsg?.documentWithCaptionMessage?.message?.documentMessage ||
    (mediaUrlOrMsg?.documentWithCaptionMessage?.mimetype ? mediaUrlOrMsg?.documentWithCaptionMessage : null);

  if (docMsg?.url) {
    console.log('[DL] Baixando documento via Baileys... url=' + docMsg.url.substring(0, 60));
    const fullMsg = {
      message: { documentMessage: docMsg },
      key: docMsg?.key || mediaUrlOrMsg?.key || {},
      messageTimestamp: docMsg?.messageTimestamp || mediaUrlOrMsg?.messageTimestamp || Math.floor(Date.now() / 1000),
    };
    const buffer = await downloadMediaMessage(fullMsg, 'buffer',
      { logger: { info: () => {}, error: () => {}, warn: () => {} } }, _sockRef);
    console.log('[DL] Baileys buffer: ' + buffer.length + ' bytes');
    return buffer;
  }

  // ── Tentar imagem ────────────────────────────────────────────────────────
  const imgMsg =
    mediaUrlOrMsg?.message?.imageMessage ||
    mediaUrlOrMsg?.imageMessage ||
    mediaUrlOrMsg?.message?.quotedMessage?.imageMessage;

  if (imgMsg?.url) {
    console.log('[DL] Baixando imagem via Baileys... url=' + imgMsg.url.substring(0, 60));
    const fullMsg = {
      message: { imageMessage: imgMsg },
      key: imgMsg?.key || mediaUrlOrMsg?.key || {},
      messageTimestamp: imgMsg?.messageTimestamp || mediaUrlOrMsg?.messageTimestamp || Math.floor(Date.now() / 1000),
    };
    const buffer = await downloadMediaMessage(fullMsg, 'buffer',
      { logger: { info: () => {}, error: () => {}, warn: () => {} } }, _sockRef);
    console.log('[DL] Imagem baixada: ' + buffer.length + ' bytes');
    return buffer;
  }

  throw new Error('Nenhum message type suportado encontrado (documentMessage nem imageMessage tem URL)');
}

// ─── DOCX TEXT EXTRACTION ────────────────────────────────────────────────────
async function extractTextFromDocx(docxBuffer, tempName) {
  const mammoth = require('mammoth');

  // Magic bytes: PK (50 4B 03 04) — DOCX is a ZIP
  const isDocx = docxBuffer.slice(0, 4).toString('latin1') === 'PK\x03\x04';
  console.log('[DOCX] Magic bytes validos? ' + isDocx);
  if (!isDocx) throw new Error('Buffer não é um DOCX válido');

  const tempPath = path.join(os.tmpdir(), tempName + '.docx');
  try {
    fs.writeFileSync(tempPath, docxBuffer);
    console.log('[DOCX] Arquivo escrito: ' + docxBuffer.length + ' bytes');

    const result = await mammoth.extractRawText({ path: tempPath });
    const text = (result.value || '').trim();
    console.log('[DOCX] mammoth: ' + text.length + ' chars');

    if (result.messages && result.messages.length > 0) {
      console.log('[DOCX] Avisos: ' + result.messages.length);
      result.messages.slice(0, 3).forEach(m => console.log('  → ' + m.message));
    }

    if (text.length === 0) throw new Error('mammoth retornou texto vazio');
    return text;
  } finally {
    try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch(e) {}
  }
}

// ─── TXT / RTF TEXT EXTRACTION ────────────────────────────────────────────────
async function extractTextFromTxt(txtBuffer, encoding = 'utf-8') {
  let text;
  try {
    text = txtBuffer.toString(encoding).trim();
  } catch(e) {
    text = txtBuffer.toString('latin1').trim();
  }
  console.log('[TXT] Extraidos ' + text.length + ' chars');
  if (text.length === 0) throw new Error('Arquivo de texto vazio');
  return text;
}

// ─── ODT TEXT EXTRACTION ─────────────────────────────────────────────────────
async function extractTextFromOdt(odtBuffer, tempName) {
  const JSZip = require('jszip');
  const isZip = odtBuffer.slice(0, 4).toString('latin1') === 'PK\x03\x04';
  console.log('[ODT] Magic bytes validos (ZIP)? ' + isZip);
  if (!isZip) throw new Error('Buffer não é um ODT válido');

  const zip = await JSZip.loadAsync(odtBuffer);
  const contentXml = await zip.file('content.xml')?.async('string');
  if (!contentXml) throw new Error('content.xml não encontrado no ODT');

  // Extrair texto das tags <text:p> e <text:h>
  const lines = [];
  const regex = /<(?:text:)?(?:p|h)[^>]*>([^<]+)<\/(?:text:)?(?:p|h)>/g;
  let match;
  while ((match = regex.exec(contentXml)) !== null) {
    const t = match[1].trim();
    if (t.length > 0) lines.push(t);
  }
  const text = lines.join('\n').trim();
  console.log('[ODT] Extraidos ' + text.length + ' chars de ' + lines.length + ' parágrafos');
  if (text.length === 0) throw new Error('ODT não contém texto legível');
  return text;
}

// ─── XLSX TEXT EXTRACTION ───────────────────────────────────────────────────
async function extractTextFromXlsx(xlsxBuffer, tempName) {
  const XLSX = require('xlsx');
  const isZip = xlsxBuffer.slice(0, 4).toString('latin1') === 'PK\x03\x04';
  console.log('[XLSX] Magic bytes validos (ZIP)? ' + isZip);
  if (!isZip) throw new Error('Buffer não é um XLSX válido');

  const tempPath = path.join(os.tmpdir(), tempName + '.xlsx');
  try {
    fs.writeFileSync(tempPath, xlsxBuffer);
    const workbook = XLSX.readFile(tempPath);
    const lines = [];
    workbook.SheetNames.forEach(name => {
      const sheet = workbook.Sheets[name];
      const range = XLSX.utils.decode_range(sheet['!ref'] || 'A1');
      for (let r = range.s.r; r <= range.e.r; r++) {
        const row = [];
        for (let c = range.s.c; c <= range.e.c; c++) {
          const cell = sheet[XLSX.utils.encode_cell({ r, c })];
          row.push(cell ? String(cell.v || '') : '');
        }
        const rowText = row.filter(v => v.trim()).join(' | ');
        if (rowText) lines.push('[' + name + '] ' + rowText);
      }
    });
    const text = lines.join('\n').trim();
    console.log('[XLSX] Extraidos ' + text.length + ' chars de ' + workbook.SheetNames.length + ' abas');
    if (text.length === 0) throw new Error('XLSX não contém dados');
    return text;
  } finally {
    try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch(e) {}
  }
}

// ─── CSV TEXT EXTRACTION ─────────────────────────────────────────────────────
async function extractTextFromCsv(csvBuffer, tempName) {
  const XLSX = require('xlsx');
  const tempPath = path.join(os.tmpdir(), tempName + '.csv');
  try {
    fs.writeFileSync(tempPath, csvBuffer);
    const workbook = XLSX.readFile(tempPath, { type: 'string' });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const text = XLSX.utils.sheet_to_csv(sheet);
    console.log('[CSV] Extraidos ' + text.length + ' chars');
    if (text.trim().length === 0) throw new Error('CSV vazio');
    return text.trim();
  } finally {
    try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch(e) {}
  }
}

// ─── IMAGE OCR EXTRACTION ────────────────────────────────────────────────────
async function extractTextFromImage(imageBuffer, tempName) {
  const tempPath = path.join(os.tmpdir(), tempName + path.extname(tempName || '.png') || '.png');
  // Detectar extensão pelo magic bytes
  const magic = imageBuffer.slice(0, 4).toString('latin1');
  const isPng  = magic === '\x89PNG';
  const isJpeg = magic === '\xff\xd8\xff';
  const isGif  = magic === 'GIF8';
  const isBmp  = magic.slice(0, 2) === 'BM';
  const ext = isPng ? '.png' : isJpeg ? '.jpg' : isGif ? '.gif' : isBmp ? '.bmp' : '.png';
  const finalPath = tempPath.replace(/\.[^.]+$/, '') + ext;
  const lang = 'por'; // Português

  try {
    fs.writeFileSync(finalPath, imageBuffer);
    console.log('[OCR] Imagem escrita: ' + imageBuffer.length + ' bytes, formato: ' + ext);

    const result = spawnSync('tesseract', [finalPath, 'stdout', '-l', lang, '--psm', '6', 'quiet'], {
      timeout: 120000,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024
    });

    if (result.error) throw new Error('tesseract error: ' + result.error.message);
    const text = (result.stdout || '').trim();
    console.log('[OCR] Extraidos ' + text.length + ' chars via tesseract');
    if (text.length === 0) throw new Error('OCR não conseguiu extrair texto da imagem');
    return text;
  } finally {
    try { if (fs.existsSync(finalPath)) fs.unlinkSync(finalPath); } catch(e) {}
  }
}

// ─── PDF TEXT EXTRACTION ─────────────────────────────────────────────────────
async function extractTextFromPdf(pdfBuffer, tempName) {
  const pdfParse = require('pdf-parse');

  const isPdf = pdfBuffer.slice(0, 4).toString('latin1') === '%PDF';
  console.log('[PDF] Magic bytes validos? ' + isPdf);
  if (!isPdf) throw new Error('Buffer não é um PDF válido (magic bytes incorretos)');

  try {
    const result = await pdfParse(pdfBuffer);
    const text = (result.text || '').trim();
    console.log('[PDF] pdf-parse: ' + text.length + ' chars, ' + result.numpages + ' pags');
    if (text.length === 0) throw new Error('pdf-parse retornou texto vazio');
    return text;
  } catch (pdfParseErr) {
    console.warn('[PDF] pdf-parse falhou: ' + pdfParseErr.message + ' — tentando pdftotext...');
  }

  const tempPdf = path.join(os.tmpdir(), tempName + '.pdf');
  const tempTxt = path.join(os.tmpdir(), tempName + '.txt');

  try {
    fs.writeFileSync(tempPdf, pdfBuffer);
    console.log('[PDF] pdftotext fallback: escrevendo ' + pdfBuffer.length + ' bytes...');

    const result = spawnSync('/usr/bin/pdftotext', ['-enc', 'UTF-8', tempPdf, tempTxt], {
      timeout: 60000, encoding: 'utf8'
    });

    if (result.error) throw new Error('pdftotext spawn error: ' + result.error.message);
    if (result.status !== 0 && !fs.existsSync(tempTxt)) {
      throw new Error('pdftotext status=' + result.status + ' e sem saída');
    }
    if (result.stderr) console.log('[PDF] pdftotext stderr: ' + result.stderr.substring(0, 200));

    const text = fs.readFileSync(tempTxt, 'utf-8');
    console.log('[PDF] pdftotext: ' + text.length + ' chars');
    if (!text || text.trim().length === 0) throw new Error('pdftotext resultou em texto vazio');
    return text;
  } finally {
    try { if (fs.existsSync(tempPdf)) fs.unlinkSync(tempPdf); } catch(e) {}
    try { if (fs.existsSync(tempTxt)) fs.unlinkSync(tempTxt); } catch(e) {}
  }
}

// ─── SMART EXTRACTION BY KEYWORDS ─────────────────────────────────────────────
/**
 * Extrai parágrafos do texto que contém palavras-chave de cada tópico.
 * Cada trecho retornado inclui até 300 chars de contexto ao redor do match.
 */
function extractByTopics(fullText, maxCharsPerTopic = 2500) {
  const lines = fullText.split(/\n/);
  const paragraphs = [];
  let currentPara = '';

  // Reconstruir parágrafos (agrupar linhas curtas)
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (currentPara.trim()) paragraphs.push(currentPara.trim());
      currentPara = '';
    } else {
      currentPara += (currentPara ? ' ' : '') + trimmed;
    }
  }
  if (currentPara.trim()) paragraphs.push(currentPara.trim());

  console.log('[TOPIC] Parágrafos reconstruídos: ' + paragraphs.length);

  const results = {};
  const foundAnywhere = new Set(); // tracks which paragraphs were used

  for (const [topicName, keywords] of Object.entries(TOPIC_KEYWORDS)) {
    const matchedParas = [];
    let totalChars = 0;

    for (const para of paragraphs) {
      const lowerPara = para.toLowerCase();
      const hasKeyword = keywords.some(kw => lowerPara.includes(kw.toLowerCase()));
      if (!hasKeyword) continue;

      matchedParas.push(para);
      totalChars += para.length;
      foundAnywhere.add(para);

      // Parar se já acumulou chars suficientes para este tópico
      if (totalChars >= maxCharsPerTopic) break;
    }

    if (matchedParas.length > 0) {
      results[topicName] = {
        count: matchedParas.length,
        text: matchedParas.join('\n\n'),
        charCount: matchedParas.reduce((s, p) => s + p.length, 0)
      };
      console.log('[TOPIC] ✅ ' + topicName + ': ' + matchedParas.length + ' parágrafos (' + totalChars + ' chars)');
    } else {
      results[topicName] = { count: 0, text: '', charCount: 0 };
      console.log('[TOPIC] ⏭️  ' + topicName + ': nada encontrado');
    }
  }

  return results;
}

/**
 * Extrai parágrafos específicos para a PERGUNTA do usuário.
 * Usa palavras da pergunta + stopwords filtradas + sinônimos licitatórios.
 */
function extractForQuestion(fullText, userQuestion) {
  // Extrair palavras da pergunta (exclui stopwords)
  const questionWords = userQuestion
    .toLowerCase()
    .replace(/[^\w\sáàâãéêíóôõúüç]/gi, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOPWORDS.has(w));

  // Sinônimos licitatórios para expandir busca
  const synonyms = {
    'multa': ['penalidade', 'sanção', 'glosa', 'multa moratória', 'multa compensatória'],
    'prazo': ['vencimento', 'validade', 'prazo de entrega', 'prazo de execução', 'vigência'],
    'habilitação': ['habilitado', 'documentação', 'regularidade', 'certidão', 'atestado'],
    'garantia': ['caução', 'fiança', 'seguro-garantia', 'garantia contratual'],
    'preço': ['valor', 'estimado', 'referência', 'global', 'unitário', 'orçamento'],
    'objeto': ['descrição', 'escopo', 'serviço', 'fornecimento', 'produto'],
    'reajuste': ['repactuação', 'revisão', 'reajuste', 'atualização', 'ipca', 'inpc'],
    'fiscal': ['fiscal do contrato', 'gestor', 'preposto', 'medição', 'conformidade'],
    'recurso': ['impugnação', 'esclarecimento', 'recurso', 'contrarrazão', 'recursal'],
    'rescisão': ['rescisão', 'distrato', 'unilateral', 'inadimplemento', 'rescisório'],
    'subcontratação': ['subcontrat', 'cessão', 'terceiriz'],
    'sobrepreço': ['superfaturamento', 'sobrepreço', 'aditivo', 'acréscimo indevido'],
  };

  const expandedWords = new Set(questionWords);
  for (const word of questionWords) {
    if (synonyms[word]) {
      synonyms[word].forEach(s => expandedWords.add(s));
    }
    // Adicionar vizinhos lexicais (ex: "multas" inclui "multa")
    if (word.endsWith('s')) {
      expandedWords.add(word.slice(0, -1));
    } else {
      expandedWords.add(word + 's');
    }
  }

  console.log('[QRY] Palavras de busca: ' + [...expandedWords].join(', '));

  const lines = fullText.split(/\n/);
  const paragraphs = [];
  let currentPara = '';

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (currentPara.trim()) paragraphs.push(currentPara.trim());
      currentPara = '';
    } else {
      currentPara += (currentPara ? ' ' : '') + trimmed;
    }
  }
  if (currentPara.trim()) paragraphs.push(currentPara.trim());

  // Buscar parágrafos que contenham qualquer palavra expandida
  const MAX_CONTEXT = 4000;
  const matched = [];
  let totalChars = 0;

  for (const para of paragraphs) {
    const lowerPara = para.toLowerCase();
    const hasMatch = [...expandedWords].some(w => lowerPara.includes(w.toLowerCase()));
    if (!hasMatch) continue;

    matched.push(para);
    totalChars += para.length;

    if (totalChars >= MAX_CONTEXT) break;
  }

  console.log('[QRY] Trechos relevantes: ' + matched.length + ' parágrafos (' + totalChars + ' chars)');
  return matched.join('\n\n');
}

// ─── RESUMO FINAL (5 linhas) ──────────────────────────────────────────────────
function generateSummary(fullText, topicsResults) {
  const lines = fullText.split(/\n/).filter(l => l.trim());
  const shortLines = lines.filter(l => l.length > 10 && l.length < 300);

  let objeto = '', valor = '', prazo = '', risco = '';

  // Tentar extrair do texto direto
  for (const line of shortLines) {
    const l = line.toLowerCase();
    if (!objeto && (l.includes('objeto') || l.includes('contrat'))) {
      objeto = line.substring(0, 150);
    }
    if (!valor && (l.includes('valor') || l.includes('r$') || l.includes('preço'))) {
      valor = line.substring(0, 150);
    }
    if (!prazo && (l.includes('prazo') || l.includes('vigência') || l.includes('entrega'))) {
      prazo = line.substring(0, 150);
    }
  }

  // Verificar alertas nos tópicos
  const alerts = topicsResults['9. ALERTAS — IRREGULARIDADES'];
  if (alerts?.count > 0) {
    risco = '⚠️ ALERTA: ' + alerts.text.substring(0, 200);
  }

  return [
    objeto || '(objeto não identificado no documento)',
    valor || '(valor não identificado)',
    prazo || '(prazos não identificados)',
    risco || '✅ Sem alertas críticos detectados',
    '👉 Recomenda-se análise completa do documento.'
  ].filter(Boolean).join('\n');
}

// ─── OPTIMIZE TEXT (legacy fallback) ──────────────────────────────────────────
function optimizeText(text, maxChars = 15000) {
  if (text.length <= maxChars) return text;
  const start = text.substring(0, Math.floor(maxChars * 0.6));
  const end = text.substring(text.length - Math.floor(maxChars * 0.3));
  return start + '\n\n[... trecho omitido ...]\n\n' + end;
}

// ─── MAIN: PROCESS DOCUMENT ────────────────────────────────────────────────────
async function processDocument(webhookData, filename, phone, messageObj) {
  try {
    console.log('[PROC] Iniciando para: ' + phone + ' arquivo: ' + filename);

    let docMsg = messageObj?.documentMessage;
    if (!docMsg && messageObj?.documentWithCaptionMessage) {
      docMsg = messageObj.documentWithCaptionMessage?.message?.documentMessage;
      console.log('[PROC] ✅ Extraído documentMessage de documentWithCaptionMessage');
    }

    const mediaUrl = webhookData?.media?.url || docMsg?.url;
    console.log('[PROC] Media URL: ' + (mediaUrl || 'não encontrada'));

    const mimeType = (webhookData?.media?.mimetype || docMsg?.mimetype || 'application/pdf').toLowerCase();
    const filenameLower = filename.toLowerCase();
    console.log('[PROC] MIME type: ' + mimeType);

    // Detectar tipo pelo nome do arquivo + MIME type
    const isDocx = mimeType.includes('word') || mimeType.includes('document') || filenameLower.endsWith('.docx');
    const isPdf  = mimeType.includes('pdf')  || filenameLower.endsWith('.pdf');
    const isTxt  = mimeType.includes('text/plain') || filenameLower.endsWith('.txt');
    const isRtf  = mimeType.includes('rtf') || filenameLower.endsWith('.rtf');
    const isOdt  = mimeType.includes('odt') || mimeType.includes('openxmlformats') || filenameLower.endsWith('.odt');
    const isXlsx = mimeType.includes('spreadsheet') || mimeType.includes('excel') || mimeType.includes('office-excel') || filenameLower.endsWith('.xlsx');
    const isCsv  = mimeType.includes('csv') || filenameLower.endsWith('.csv');
    const isImage = mimeType.includes('image') || mimeType.includes('jpeg') || mimeType.includes('png') || mimeType.includes('gif') || mimeType.includes('webp') || mimeType.includes('bmp') ||
                    filenameLower.endsWith('.jpg') || filenameLower.endsWith('.jpeg') || filenameLower.endsWith('.png') || filenameLower.endsWith('.gif') || filenameLower.endsWith('.webp') || filenameLower.endsWith('.bmp');

    console.log('[PROC] Tipos detectados: docx=' + isDocx + ' pdf=' + isPdf + ' txt=' + isTxt + ' rtf=' + isRtf + ' odt=' + isOdt + ' xlsx=' + isXlsx + ' csv=' + isCsv + ' imagem=' + isImage);

    let fileBuffer;
    if (docMsg?.url || messageObj?.documentMessage || messageObj?.documentWithCaptionMessage) {
      console.log('[PROC] Usando downloadMediaMessage do Baileys...');
      fileBuffer = await downloadMedia(messageObj);
    } else if (mediaUrl && typeof mediaUrl === 'string' && mediaUrl.startsWith('http')) {
      console.log('[PROC] Usando URL direta via axios...');
      fileBuffer = await downloadMedia(mediaUrl);
    } else {
      throw new Error('Nenhuma forma de baixar o documento encontrada: docMsg=' + !!docMsg + ' mediaUrl=' + !!mediaUrl);
    }

    const tempName = 'doc_' + phone.replace(/\D/g, '') + '_' + Date.now();

    // Roteamento por tipo de arquivo
    let rawText;
    if (isImage) {
      console.log('[PROC] 🖼️  Executando OCR na imagem...');
      rawText = await extractTextFromImage(fileBuffer, tempName);
    } else if (isDocx) {
      console.log('[PROC] 📄 Extraindo texto de DOCX...');
      rawText = await extractTextFromDocx(fileBuffer, tempName);
    } else if (isOdt) {
      console.log('[PROC] 📄 Extraindo texto de ODT...');
      rawText = await extractTextFromOdt(fileBuffer, tempName);
    } else if (isXlsx) {
      console.log('[PROC] 📊 Extraindo texto de XLSX...');
      rawText = await extractTextFromXlsx(fileBuffer, tempName);
    } else if (isCsv) {
      console.log('[PROC] 📋 Extraindo texto de CSV...');
      rawText = await extractTextFromCsv(fileBuffer, tempName);
    } else if (isPdf) {
      console.log('[PROC] 📄 Extraindo texto de PDF...');
      rawText = await extractTextFromPdf(fileBuffer, tempName);
    } else if (isTxt || isRtf) {
      console.log('[PROC] 📄 Extraindo texto de arquivo texto/RTF...');
      rawText = await extractTextFromTxt(fileBuffer);
    } else {
      // Auto-detectar: PDF ou DOCX ou imagem
      try {
        rawText = await extractTextFromImage(fileBuffer, tempName);
      } catch(imgErr) {
        try {
          rawText = await extractTextFromPdf(fileBuffer, tempName);
        } catch(pdfErr) {
          rawText = await extractTextFromDocx(fileBuffer, tempName);
        }
      }
    }

    // ── EXTRAÇÃO POR TÓPICOS (etapa principal) ───────────────────────────────
    console.log('[PROC] 🔍 Extraindo por tópicos...');
    const topicsResults = extractByTopics(rawText);

    // ── RESUMO FINAL ─────────────────────────────────────────────────────────
    const summary = generateSummary(rawText, topicsResults);
    console.log('[PROC] 📋 Resumo gerado:\n' + summary);

    // Contexto resumido (injetado inicialmente — usa optimizeText até perguntas chegarem)
    const optimizedText = optimizeText(rawText, 15000);

    const documentInfo = {
      filename,
      content: optimizedText,           // texto completo (limite 15k chars)
      rawText: rawText,                // texto integral extraído
      topics: topicsResults,            //extração por tópico
      summary: summary,                // resumo de 5 linhas
      originalSize: rawText.length,
      extractedAt: new Date().toISOString()
    };

    let cache = documentCacheByPhone.get(phone) || [];
    cache.unshift(documentInfo);
    if (cache.length > MAX_CACHE_SIZE) cache = cache.slice(0, MAX_CACHE_SIZE);
    documentCacheByPhone.set(phone, cache);

    console.log('[PROC] ✅ Sucesso: ' + filename + ' (' + rawText.length + ' chars, ' + Object.keys(topicsResults).length + ' tópicos)');
    return documentInfo;

  } catch (err) {
    console.error('[PROC] ❌ Erro ao processar documento: ' + err.message);
    throw err;
  }
}

// ─── QUERY DOCUMENT (para perguntas subsequentes) ─────────────────────────────
/**
 * Responde perguntas sobre um documento já processado.
 * Usa extração inteligente baseada na pergunta do usuário.
 */
function queryDocument(phone, userQuestion) {
  const cache = documentCacheByPhone.get(phone);
  if (!cache || cache.length === 0) return null;

  const doc = cache[0];
  if (!doc.rawText) return null;

  // Usar extração por pergunta
  const relevantPassages = extractForQuestion(doc.rawText, userQuestion);

  return {
    passages: relevantPassages,
    summary: doc.summary,
    topics: doc.topics,
    filename: doc.filename
  };
}

function getDocumentForPhone(phone) {
  const cache = documentCacheByPhone.get(phone);
  return (cache && cache.length > 0) ? cache[0] : null;
}

function clearPhoneDocuments(phone) {
  documentCacheByPhone.delete(phone);
}

module.exports = {
  processDocument,
  getDocumentForPhone,
  clearPhoneDocuments,
  setSockRef,
  queryDocument,
  extractByTopics,
  extractForQuestion,
  extractTextFromImage,
  downloadMedia,
  TOPIC_KEYWORDS
};
