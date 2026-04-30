// Mensagens automáticas do Dr. IAgo

const MSG_INATIVO = `Olá! 👋

Sou o *Dr. IAgo*, assistente especializado em licitações e contratos públicos da *Consultoria Schliesing*.

Identifiquei que você ainda não possui uma assinatura ativa. Para ter acesso ao meu suporte jurídico completo, assine agora:

👉 https://pay.kiwify.com.br/QbYvidM

Qualquer dúvida, estamos à disposição! 😊`;

function MSG_BOAS_VINDAS(nome) {
  const primeiroNome = nome ? nome.split(' ')[0] : 'Cliente';
  return `Olá, *${primeiroNome}*! 🎉

Seja muito bem-vindo(a) ao *Dr. IAgo*!

Sou seu assistente jurídico especializado em licitações e contratos públicos da *Consultoria Schliesing*. Estou aqui para te ajudar com:

📋 Análise de editais e termos de referência
📝 Revisão de contratos administrativos
⚖️ Dúvidas sobre a Lei 14.133/2021
🔍 Impugnações, recursos e habilitação

É só me enviar sua dúvida ou o documento que deseja analisar, e eu cuido do resto! 😊

Como posso te ajudar hoje?`;
}

function MSG_SAIDA(nome) {
  const primeiroNome = nome ? nome.split(' ')[0] : 'Cliente';
  return `Olá, *${primeiroNome}*! 😔

Ficamos muito tristes em ver você partir...

Foi um prazer enorme te auxiliar com suas questões de licitações e contratos públicos. Espero ter contribuído de forma positiva para o seu trabalho!

Se um dia precisar de mim novamente, estarei aqui. A porta está sempre aberta! 🤝

👉 Para reativar seu acesso: https://pay.kiwify.com.br/QbYvidM

Até logo e muito sucesso! 🍀`;
}

module.exports = { MSG_BOAS_VINDAS, MSG_INATIVO, MSG_SAIDA };
