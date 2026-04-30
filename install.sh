#!/bin/bash
# Script de instalação do Dr. IAgo 3
# Execute como root no VPS Hostinger

set -e
echo "🚀 Iniciando instalação do Dr. IAgo 3..."

# Node.js 22
if ! command -v node &> /dev/null || [[ $(node -v | cut -d'v' -f2 | cut -d'.' -f1) -lt 20 ]]; then
  echo "📦 Instalando Node.js 22..."
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

# PM2
if ! command -v pm2 &> /dev/null; then
  echo "📦 Instalando PM2..."
  npm install -g pm2
fi

# Dependências
echo "📦 Instalando dependências do projeto..."
npm install

# Pasta de dados
mkdir -p data docs

# .env
if [ ! -f .env ]; then
  cp .env.example .env
  echo ""
  echo "⚠️  IMPORTANTE: Edite o arquivo .env com suas chaves:"
  echo "    nano .env"
  echo ""
fi

echo "✅ Instalação concluída!"
echo ""
echo "Próximos passos:"
echo "1. nano .env  (configure suas chaves de API)"
echo "2. npm start  (testar)"
echo "3. pm2 start src/index.js --name driago  (produção)"
echo "4. pm2 save && pm2 startup  (iniciar no boot)"
