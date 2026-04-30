/**
 * Legal Knowledge Base Manager
 * Manages the document library for Dr. IAgo
 */

const fs = require('fs');
const path = require('path');
const { parseDocument } = require('./embeddings');
const { addDocuments, initCollection, getCount, clearAll } = require('./vector_store');

// ─── KNOWLEDGE BASE PATHS ────────────────────────────────────────────────
const KB_DIR = path.join(__dirname, '../../data/knowledge');

// ─── SUPPORTED FORMATS ───────────────────────────────────────────────────
const SUPPORTED_EXTENSIONS = ['.txt', '.md', '.json', '.pdf'];

// ─── DOCUMENT TYPES ──────────────────────────────────────────────────────
const DOC_TYPES = {
  'leis': 'lei_14133',
  'lei_14133': 'lei_14133',
  'lei_8666': 'lei_8666',
  'lc_123': 'lc_123',
  'lei_10520': 'lei_10520',
  'decretos': 'decreto',
  'decreto': 'decreto',
  'jurisprudencia_tcu': 'tcu',
  'jurisprudencia_stj': 'stj',
  'jurisprudencia_stf': 'stf',
  'tcu': 'tcu',
  'stj': 'stj',
  'stf': 'stf',
  'in': 'in_seges',
  'in_seges': 'in_seges',
  'doutrina': 'doutrina',
  'modelos': 'modelo',
  'modelo': 'modelo',
  'template': 'modelo',
  'parecer': 'modelo',
  'contratos': 'modelo',
};

// ─── SCAN DIRECTORY ───────────────────────────────────────────────────────
/**
 * Scan directory for documents
 */
function scanDirectory(dir, depth = 2) {
  const documents = [];

  function scan(currentDir, currentDepth) {
    if (currentDepth > depth) return;

    try {
      const entries = fs.readdirSync(currentDir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(currentDir, entry.name);

        if (entry.isDirectory()) {
          scan(fullPath, currentDepth + 1);
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (SUPPORTED_EXTENSIONS.includes(ext)) {
            const relativePath = path.relative(KB_DIR, fullPath);
            const type = detectType(relativePath);

            documents.push({
              path: fullPath,
              name: entry.name,
              relativePath,
              type,
              size: fs.statSync(fullPath).size,
            });
          }
        }
      }
    } catch (err) {
      console.error(`[KB] ❌ Erro ao escanear ${currentDir}: ${err.message}`);
    }
  }

  scan(dir, 0);
  return documents;
}

// ─── DETECT DOCUMENT TYPE ─────────────────────────────────────────────────
/**
 * Detect document type from path
 */
function detectType(filePath) {
  const normalized = filePath.toLowerCase().replace(/[/_-]/g, ' ');

  for (const [key, type] of Object.entries(DOC_TYPES)) {
    if (normalized.includes(key)) {
      return type;
    }
  }

  return 'documento';
}

// ─── READ DOCUMENT CONTENT ────────────────────────────────────────────────
/**
 * Read document content based on file type
 */
function readDocument(doc) {
  try {
    const ext = path.extname(doc.path).toLowerCase();

    switch (ext) {
      case '.txt':
      case '.md':
        return fs.readFileSync(doc.path, 'utf-8');

      case '.json':
        const data = JSON.parse(fs.readFileSync(doc.path, 'utf-8'));
        if (Array.isArray(data)) {
          return data.map(item => JSON.stringify(item)).join('\n\n');
        }
        return JSON.stringify(data, null, 2);

      case '.pdf':
        // PDFs need special processing - return placeholder
        // In production, use pdf-parse or python script
        console.warn(`[KB] PDF detectado: ${doc.name} - será ignorado na indexação (use .txt)`);
        return null;

      default:
        return null;
    }
  } catch (err) {
    console.error(`[KB] ❌ Erro ao ler ${doc.name}: ${err.message}`);
    return null;
  }
}

// ─── INDEX KNOWLEDGE BASE ──────────────────────────────────────────────────
/**
 * Index all documents in the knowledge base
 */
async function indexKnowledgeBase(options = {}) {
  const {
    reindex = false,
    verbose = true,
  } = options;

  if (verbose) console.log(`\n📚 Indexando Base Jurídica...`);

  // Initialize collection
  await initCollection();

  // Clear existing if reindex
  if (reindex) {
    if (verbose) console.log('[KB] 🗑️ Limpando índice existente...');
    await clearAll();
  }

  // Scan documents
  const documents = scanDirectory(KB_DIR);
  if (verbose) console.log(`[KB] 📄 ${documents.length} documentos encontrados`);

  // Process each document
  const allChunks = [];
  let indexedCount = 0;
  let skippedCount = 0;

  for (const doc of documents) {
    if (verbose) console.log(`[KB] 📖 Processando: ${doc.relativePath}`);

    const content = readDocument(doc);
    if (!content) {
      skippedCount++;
      continue;
    }

    const chunks = parseDocument(content, {
      docId: doc.relativePath.replace(/[./]/g, '_'),
      name: doc.name,
      type: doc.type,
    });

    if (chunks.length > 0) {
      allChunks.push(...chunks);
      indexedCount++;
      if (verbose) console.log(`[KB]   ✅ ${chunks.length} chunks extraídos`);
    } else {
      skippedCount++;
    }
  }

  if (verbose) console.log(`\n[KB] 📊 Resumo: ${indexedCount} docs, ${allChunks.length} chunks, ${skippedCount} ignorados`);

  // Add to vector store
  if (allChunks.length > 0) {
    const added = await addDocuments(allChunks);
    if (verbose) console.log(`[KB] ✅ ${added} chunks indexados no Qdrant`);
  }

  return {
    documents: indexedCount,
    chunks: allChunks.length,
    skipped: skippedCount,
  };
}

// ─── ADD SINGLE DOCUMENT ───────────────────────────────────────────────────
/**
 * Add a single document to the knowledge base
 */
async function addDocument(content, metadata = {}) {
  const chunks = parseDocument(content, {
    docId: metadata.docId || `doc_${Date.now()}`,
    name: metadata.name || 'documento',
    type: metadata.type || 'documento',
  });

  if (chunks.length === 0) {
    console.warn('[KB] Nenhum chunk gerado para o documento');
    return 0;
  }

  await initCollection();
  const added = await addDocuments(chunks);
  return added;
}

// ─── GET KNOWLEDGE BASE STATUS ────────────────────────────────────────────
/**
 * Get knowledge base status
 */
async function getStatus() {
  const documents = scanDirectory(KB_DIR);
  const count = await getCount();

  const byType = {};
  for (const doc of documents) {
    byType[doc.type] = (byType[doc.type] || 0) + 1;
  }

  return {
    collection: 'driago_legal_kb',
    totalDocuments: documents.length,
    totalChunks: count,
    byType,
    lastScan: new Date().toISOString(),
  };
}

// ─── SEED DEFAULT DOCUMENTS ────────────────────────────────────────────────
/**
 * Create seed documents with basic legal content
 */
async function seedDefaultDocuments() {
  const seedDir = path.join(KB_DIR, 'seeds');
  fs.mkdirSync(seedDir, { recursive: true });

  const seedDocs = [
    {
      name: 'valores_dispensa_2024.txt',
      type: 'lei_14133',
      content: `VALORES DE DISPENSA DE LICITAÇÃO (Atualizado 2024)

Base Legal: Art. 75 da Lei 14.133/2021 e Decreto 12.343/2024

1. DISPENSA POR VALOR
   - Obras e serviços de engenharia: até R$ 119.812,06
   - Compras e demais serviços: até R$ 59.906,02

2. DISPENSA EM RAZÃO DO VALOR PARA ÓRGÃOS LOCAIS (LC 123/2006):
   - ME/EPP: até R$ 80.000,00 para obras e R$ 25.000,00 para compras
   - Limites específicos podem variar conforme regulamentação local

3. HIPÓTESES DE DISPENSA (Art. 75, Lei 14.133/2021):
   - Inciso I: Guerra, grave perturbação da ordem, calamidade pública
   - Inciso II: Intervenção na propriedade para executar obras
   - Inciso III: Emergência ou calamidade pública
   - Inciso IV: Fornecimento奇特古怪
   - Inciso V: Contratação com-IPÊ
   - Inciso VI: Prestação de serviços com as Forças Armadas

4. PROCEDIMENTO:
   - Cotação prévia de preços (mínimo 3 fornecedores)
   - Dispensa de formalidades conforme art. 75, §3º
   - Justificativa nos autos
   - Ratificação pela autoridade competente

5. VEDAÇÕES:
   - Fragmentação de despesa para evitar licitação
   - Contratação de serviçossem personalidade jurídica
   - Pagamento antecipado (salvo exceções)
`,
    },
    {
      name: 'principios_licitatorios.txt',
      type: 'lei_14133',
      content: `PRINCÍPIOS FUNDAMENTAIS DAS LICITAÇÕES

Base Legal: Art. 3º da Lei 14.133/2021

1. PLANEJAMENTO
   - Todo contrato deve ser precedido de planejamento
   - Estudo técnico preliminar obrigatório em muitos casos
   - Termo de Referência ou Projeto Básico obrigatórios

2. PRINCÍPIOS EXPLÍCITOS (Art. 5º):
   - Legalidade: conformidade com a lei
   - Impessoalidade: tratamento igualitário
   - Moralidade: probidade administrativa
   - Publicidade: transparência dos atos
   - Probidade administrativa
   - Desenvolvimento nacional sustentável
   - Segredos industria e comercial
   - Vinculação ao instrumento convocatório (edital)
   - Objetividade na seleção (melhor técnica e preço)

3. PRINCÍPIOS IMPLÍCITOS:
   - Competitividade: ampla disputa
   - Vinculação ao orçamento (CF art. 167, I)
   - Economicidade
   - Eficiência
   - proporcionalidade
   - Razoabilidade
   - Indisponibilidade do interesse público

4. DIREITOS DOS LICITANTES:
   - Participar de licitações
   - Impugnar edital (5 dias úteis antes da abertura)
   - Recorrer de decisões (5 dias úteis)
   - Serializerades administrativas

5. OBRIGAÇÕES DA ADMINISTRAÇÃO:
   - Motivação das decisões
   - Julgamento objetivo
   - Critérios claros no edital
   - Condução ética do processo
`,
    },
    {
      name: 'modalidades_licitacao.txt',
      type: 'lei_14133',
      content: `MODALIDADES LICITATÓRIAS (Lei 14.133/2021)

Art. 28: São modalidades licitatórias:

1. PREGÃO (Art. 17)
   - Para bens e serviços comuns
   - Pode ser presencial ou eletrônico
   - Menor preço ou maior desconto
   - Deve ser utilizada preferencialmente na forma eletrônica

2. CONCURSO (Art. 18)
   - Para escolher trabalho técnico, científico ou artístico
   - Premiação ao vencedor(s)
   - Regras específicas no edital

3. LEILÃO (Art. 19)
   - Para venda de bens imóveis ou de ações
   - Menor lance acima do valor de referência
   - Leiloeiro oficial ou servidor designado

4. CONCORRÊNCIA (Art. 28, IV)
   - Para contratos de grande vulto
   - Regime diferenciado para某些 obras
   - Maior competitividade

5. TOMADA DE PREÇOS (Art. 28, III)
   - Para contratos de médio vulto
   - Apenas fornecedores previamente cadastrados
   - Pode ter etapa de habilitação

6. CONTRATAÇÃO DIRETA (NÃO é modalidade!)
   - Dispensa e Inexigibilidade (Art. 74-75)
   - Não configuram modalidades próprias
   - São hipóteses legais de contratação sem licitação

CRITÉRIOS DE JULGAMENTO (Art. 33):
- Menor preço
- Maior desconto
- Melhor técnica ou técnica e preço
- Maior lance (para vendas)
- Maior retorno econômico (contrapartida)
`,
    },
    {
      name: 'inexigibilidade.txt',
      type: 'lei_14133',
      content: `INEXIGIBILIDADE DE LICITAÇÃO (Art. 74, Lei 14.133/2021)

HIPÓTESES:

1. INCISO I - Fornecedor Único
   - Inexistência de competição
   - Eg: estação radioativa com fornecedor único
   - Contrato de exclusividade

2. INCISO II - Serviços Técnicos Especializados
   - Professores para palestras
   - Artistas para shows
   - Notórios especialistas
   - Requisitos: conhecimento técnico-artístico-científico notório
   - Não pode haver substitutos

3. INCISO III - Artes e Espetáculos
   - Contratação de artistas
   - Produções culturais
   - Eventos culturais específicos

4. INCISO IV - Contratação de bancos
   - Instituições financeiras oficiais
   - Bacen ou governo federal
   - Serviços bancários

PROCEDIMENTO:
1. Emissão de CRP (Certidão de Ruptura de licitação)
2. Justificativa fundamentada
3. Pesquisa de preços (mesmo sem concorrentes)
4. Aprovação da autoridade competente
5. Publicação no PNCP

DOCUMENTAÇÃO NECESSÁRIA:
- Declaração de inexistibilidade de fornecedores
- Justificativa de preço
- Autorização da autoridade superior
- Publicação em 3 dias (diário oficial)
`,
    },
    {
      name: 'habilitacao_14133.txt',
      type: 'lei_14133',
      content: `HABILITAÇÃO NAS LICITAÇÕES (Lei 14.133/2021)

CAPÍTULO III - DA HABILITAÇÃO

1. HABILITAÇÃO JURÍDICA (Art. 66):
   - Registro comercial (empresa individual)
   - Ato constitutivo e alterações (pessoa jurídica)
   - Documentos de eleição de titulares, diretores, gerentes

2. QUALIFICAÇÃO TÉCNICA (Art. 67-68):
   - Comprovação de capacidade técnica
   - Atestado de capacidade técnica
   - Prova de execução de serviços similares
   - Visita técnica (se exigida no edital)
   - Responsável técnico pela execução

3. QUALIFICAÇÃO ECONÔMICO-FINANCEIRA (Art. 69):
   - Balanço patrimonial
   - Índice de Liquidez Corrente (ILC ≥ 1)
   - Índice de Liquidez Geral (ILG ≥ 1)
   - Patrimônio Líquido mínimo
   - Garantia de proposta (se exigido)

4. REGULARIDADE FISCAL (Art. 70):
   - CNPJ
   - FGTS (CRF)
   - INSS (CND ou CPD-ENAS)
   - Fazend Nacional, Estadual, Municipal
   - Trabalho (CNDT)

5. DECLARAÇÕES OBRIGATÓRIAS:
   - Declaração de que não utiliza trabalho infantil
   - Declaração de inexistência de fatos impeditivos
   - Declaração de enquadramento ME/EPP (quando aplicável)

6. CRITÉRIOS DE DESEMPATE (Art. 60):
   - Primeiro:produtos manufactured no país
   - Segundo: serviços produzidos no país
   - Terceiro:proposta mais vantajosa
   - Quarto: sorteio
`,
    },
    {
      name: 'contrato_administrativo.txt',
      type: 'lei_14133',
      content: `CONTRATOS ADMINISTRATIVOS (Lei 14.133/2021)

CARACTERÍSTICAS:
- Vinculação ao edital e proposta
- Sujeição à lei
- Mutabilidade (adaptabilidade)
- continuidade (prestação do serviço público)
- Controlabilidade

CLÁUSULAS NECESSÁRIAS (Art. 92):
1. Objeto e seus elementos característicos
2. Regime de execução ou forma de fornecimento
3. Preço, condições de pagamento, critérios de reajuste
4. Prazos de início, etapas, conclusão, entrega
5. Garantias oferecidas
6. Direitos e responsabilidades das partes
7. Penalidades por inadimplemento
8. Casos de rescisão
9. Vinculação ao projeto básico, termo de referência, convite
10. Dotação orçamentária

VIGÊNCIA:
- Máximo de 5 anos (art. 107)
- Prorrogáveis (art. 107, II) - até 10 anos para serviços contínuos
- Excepcionalmente até 15 anos para contratos de concessionárias

REAJUSTE (Art. 92, §6º):
- Periodicidade mínima de 12 meses
- Indexador oficial
- Art. 25:IGP-M, INPC, ou outro definido no contrato

ADITIVOS (Art. 115-116):
1. Prazo (prorrogação) - máximo 50% da vigência
2. Valor (acréscimos ou supressões) - máximo 25% (ou 50% para reformas)
3. Modificação do projeto/especificações
4. Modificação do regime de execução

REEQUILÍBRIO (Art. 131):
- Ocorrendo hecho imprevisível
- Consequências onerosas excessivas
- Pode ser pleiteado a qualquer tempo
- Requer documentação probatória

RESCISÃO (Art. 137-138):
- Unilateral pela Administração (conveniência)
- Unilateral pelo contratado (inadimplemento)
- consensual
- Determinação judicial
- Falência ou insolvência do contratado
`,
    },
    {
      name: 'recursos_licitacao.txt',
      type: 'lei_14133',
      content: `RECURSOS ADMINISTRATIVOS NAS LICITAÇÕES

MARCO LEGAL: Art. 109 da Lei 14.133/2021

COMPETÊNCIA PARA JULGAR RECURSOS:
- Pregoeiro: recursos de sua competência
- Autoridade superior: recursos contra decisões do pregoeiro
- Comissão de Licitação: seu próprio julgamento

HIPÓTESES DE RECURSO:
1. Habilitação/Inabilitação
2. Julgamento das propostas
3. Anulação/revogação da licitação
4. Qualquer outro ato do pregoeiro/Comissão

PRAZOS:
- 3 dias úteis para apresentar contrarrazões (Art. 109, §3º)
- A contagem inicia-se a partir da intimação ou lavratura da ata
- Não há prazo específico para recurso: observar o edital

EFEITOS:
- Recurso不全具有 suspensivo automático
- Autoridade pode atribuir efeito suspensivo (Art. 109, §2º)
- Recursos não recebidos em caráter suspensivo: execução imediata

PROCEDIMENTO:
1. Intenção de recorrer (breve exposição de motivos)
2. Motivação do recurso
3. Apresentação das razões recursais
4. Contrarrazões pelos demais licitantes
5. Julgamento pela autoridade competente
6. Decisão

PRINCÍPIOS APLICÁVEIS:
- Oficialidade: autoridade julga de ofício
- Informalismo: forma não é essencial se não prejudica
- Verdade material: busca a verdade real
- Instrumentalidade das formas
- Concentração: economia processual

SUSPENSÃO DO PROCESSO:
- Recurso contra habilitação: prossegue com outros licitantes
- Recurso contra julgamento: pode prosseguir com ressalvas

AÇÕES JUDICIAIS POSTERIORES:
- Mandado de Segurança (120 dias)
- Ação Ordinária
- Ação Popular
`,
    },
    {
      name: 'penalidades_licitacao.txt',
      type: 'lei_14133',
      content: `PENALIDADES EM LICITAÇÕES E CONTRATOS (Lei 14.133/2021)

SANÇÕES ADMINISTRATIVAS (Art. 155-162):

1. ADVERTÊNCIA (Art. 156, I)
   - Falta leve
   - Notificação por escrito
   - Prazo para correção

2. MULTA
   - Moratória: até 0,5% por dia de atraso (Art. 162, II)
   - Compensatória: até 10% do valor contratado (Art. 162, I)
   - Pode chegar a 20% em caso de reincidência

3. IMPEDIMENTO DE LICITAR E CONTRATAR (Art. 156, III)
   - Tempo determinado (1-5 anos)
   - Registrado em cadastro federal
   - Impede participação em qualquer órgão público

4. DECLARAÇÃO DE INIDONEIDADE (Art. 156, IV)
   - Sanção mais grave
   - Impedimento permanente
   - Publicação em diário oficial
   - Pode ser aplicado a empresas do mesmo grupo

PROCESSO ADMINISTRATIVO:
- direito à defesa (contraditório e ampla defesa)
- prazo mínimo de 5 dias úteis para defesa
- intimação do infrator
- decisão fundamentada
- recurso com efeito suspensivo

CAUSAS DE IMPEDIMENTO/DECLARAÇÃO:
- Frustrar competitivaidade
- Conluio
- Fraudar execução do contrato
- atras injustificadso
- inexecução total ou parcial
- comportainadequada
- Decretação de falência ou insolvência

REGISTRO EM CADASTROS:
- SICAF (federal)
- CADUT (governo federal)
- Cadastros estaduais e municipais
`,
    },
  ];

  // Write seed documents
  for (const doc of seedDocs) {
    const filePath = path.join(seedDir, doc.name);
    fs.writeFileSync(filePath, doc.content, 'utf-8');
    console.log(`[KB] ✅ Seed criado: ${doc.name}`);
  }

  return seedDocs.length;
}

// ─── EXPORTS ──────────────────────────────────────────────────────────────
module.exports = {
  scanDirectory,
  detectType,
  readDocument,
  indexKnowledgeBase,
  addDocument,
  getStatus,
  seedDefaultDocuments,
  KB_DIR,
  DOC_TYPES,
};
