import { config } from '../config/config.js';

/**
 * Central dictionary of every customer/staff-facing string (WhatsApp messages,
 * generated PDF text, the conversational agent's system prompt). Portuguese
 * (Angola) is the production language — see CLAUDE.md "Language split". The
 * English variant exists purely so a developer can set MESSAGE_LOCALE=en
 * locally and read what the bot is saying while testing; production always
 * defaults to 'pt' regardless of this file's contents.
 */

interface PaymentMethodCopy {
  name: string;
  instructions: (orderNumber: string, amount: string) => string;
}

interface Messages {
  onboarding: {
    welcome: () => string;
    welcomeBack: (name: string) => string;
    resumeRegistration: () => string;
    askNameOnly: () => string;
    askNifBody: (name: string) => string;
    askNifButtons: [string, string];
    askNifNumber: () => string;
    askAddress: () => string;
    askVehicleIdBody: (name: string) => string;
    askVehicleIdButtons: [string, string, string];
    resumeVehicleIdBody: (name: string) => string;
    onboardingComplete: (name: string, vehicleSummary: string) => string;
  };
  manual: {
    askModel: (make: string) => string;
    askYear: (make: string, model: string) => string;
    invalidYear: () => string;
    askEngineNumber: (make: string, model: string, year: string) => string;
    collectionComplete: (summary: string) => string;
    askMakePrompt: () => string;
    engineLabel: (engineNumber: string) => string;
  };
  vin: {
    askVinPrompt: () => string;
    identifying: () => string;
    decodeFailed: () => string;
    confirmBody: (description: string) => string;
    confirmButtons: [string, string];
  };
  document: {
    askPhotoPrompt: () => string;
    received: () => string;
    downloadFailed: () => string;
    processingError: () => string;
    notRecognized: () => string;
    invalid: (reason: string) => string;
    defaultInvalidReason: string;
    missingEssentialData: () => string;
    confirmBody: (description: string) => string;
    licensePlateLabel: (plate: string) => string;
  };
  vehicleConfirm: {
    confirmedAskPart: (make: string, model: string, year: string) => string;
    addVehicleButton: () => string;
    addVehicleBody: () => string;
    chooseVehiclePrompt: (vehicles: { make: string; model: string; year: string }[]) => string;
    vehicleChoiceNotFound: () => string;
  };
  agent: {
    checkingStock: () => string;
    noStockFound: () => string;
    optionNotFound: () => string;
    serviceUnavailable: () => string;
    waitlistConfirmed: (productName: string) => string;
    waitlistDeclined: () => string;
    restockNotification: (productName: string) => string;
    proformaSentChoosePayment: () => string;
    transferToHuman: () => string;
    searchListBody: (count: number, part: string) => string;
    searchListBodyForVehicle: (count: number, part: string, make: string, model: string, year: string) => string;
    searchListButton: () => string;
  };
  order: {
    rejected: (orderNumber: string) => string;
  };
  payment: {
    methods: {
      bankTransfer: PaymentMethodCopy;
      bankDeposit: PaymentMethodCopy;
      multicaixaExpress: PaymentMethodCopy;
      mobilePOS: PaymentMethodCopy;
      cash: PaymentMethodCopy;
    };
    askMethodBody: (orderNumber: string, amount: string) => string;
    askMethodButtons: [string, string, string];
    askBankSubtypeBody: () => string;
    askBankSubtypeButtons: [string, string];
    askInPersonSubtypeBody: () => string;
    askInPersonSubtypeButtons: [string, string];
    proofReceivedCustomer: (methodName: string, orderNumber: string) => string;
    proofInvalid: (reason: string) => string;
    proofInvalidDefaultReason: string;
    proofReceivedStaff: (orderNumber: string, methodName: string, amount: string, phone: string, adminUrl: string) => string;
    inPersonPaymentStaff: (orderNumber: string, methodName: string, emoji: string, amount: string, phone: string, isMobilePOS: boolean, adminUrl: string) => string;
    supplierDeliveryNotice: (productName: string, reference: string, quantity: number, orderNumber: string) => string;
  };
  pdf: {
    proforma: {
      companyName: string;
      tagline: string;
      phone: string;
      email: string;
      title: string;
      numberLabel: (orderNumber: string) => string;
      dateLabel: (date: string) => string;
      validityLabel: (date: string) => string;
      clientHeader: string;
      whatsappLabel: (phone: string) => string;
      clientDataNote: string;
      tableDescription: string;
      tableReference: string;
      tableQty: string;
      tableUnitPrice: string;
      tableTotal: string;
      supplierLabel: (supplier: string) => string;
      totalDue: string;
      paymentInstructionsHeader: string;
      bankLine: string;
      multicaixaLine: string;
      referenceLine: (orderNumber: string) => string;
      afterPaymentLine: string;
      termsNote: string;
      footer: string;
    };
    sendMessage: {
      orderConfirmed: (itemName: string, orderNumber: string, total: string) => string;
      documentCaption: (orderNumber: string) => string;
    };
    finalInvoice: {
      notification: () => string;
      documentCaption: (orderNumber: string) => string;
    };
    mockInvoice: {
      headerTitle: string;
      tagline: string;
      nifLine: string;
      title: string;
      numberLabel: (num: string) => string;
      dateLabel: (date: string) => string;
      clientHeader: string;
      nameLine: string;
      whatsappLabel: (phone: string) => string;
      tableDescription: string;
      tableReference: string;
      tableQty: string;
      tableUnitPrice: string;
      tableTotal: string;
      defaultProductName: string;
      totalPaid: string;
      agtStamp: string;
    };
  };
  adminAuth: {
    resetCode: (code: string) => string;
  };
}

const pt: Messages = {
  onboarding: {
    welcome: () =>
      `👋 Bem-vindo à *Rede Peças*!\n\n` +
      `Somos o marketplace automotivo de Angola — ` +
      `encontramos as peças certas para o teu veículo no menor tempo possível. 🚗\n\n` +
      `Para te servir melhor, vou registar o teu perfil rapidamente.\n\n` +
      `*Como te chamas?* 👇`,
    welcomeBack: (name) =>
      `👋 Olá de novo, *${name}*! Bem-vindo de volta à *Rede Peças*. 😊`,
    resumeRegistration: () =>
      `👋 Vamos continuar o teu registo!`,
    askNameOnly: () => `*Como te chamas?* 👇`,
    askNifBody: (name) =>
      `Prazer, *${name}*! 🤝\n\n` +
      `Tens *NIF* para incluir nas facturas?\n` +
      `_(útil se comprares em nome de empresa)_`,
    askNifButtons: ['✅ Sim, tenho NIF', '❌ Não, obrigado'],
    askNifNumber: () =>
      `Perfeito! Escreve o teu *número de NIF* 👇`,
    askAddress: () =>
      `Qual é o teu *endereço de entrega* preferido?\n\n` +
      `Exemplo: _Bairro Morro Bento, Rua da Samba, Nº 12, Luanda_\n\n` +
      `_(responde "saltar" se preferires indicar no momento do pedido)_`,
    askVehicleIdBody: (name) =>
      `✅ *Perfil criado com sucesso, ${name}!*\n\n` +
      `Da próxima vez que nos contactares já te reconheço. 😊\n\n` +
      `Agora preciso identificar o teu veículo. Escolhe uma opção 👇`,
    askVehicleIdButtons: ['🔢 Tenho o VIN', '📄 Enviar foto', '✍️ Manual'],
    resumeVehicleIdBody: (name) =>
      `👋 Bem-vindo de volta, *${name}*!\n\n` +
      `Ainda preciso identificar o teu veículo. Escolhe uma opção 👇`,
    onboardingComplete: (name, vehicleSummary) =>
      `✅ Ficaste registado na *Rede Peças*, ${name}! 🎉\n\n` +
      `${vehicleSummary}\n\n` +
      `Como posso ajudar-te hoje? Diz-me que peça precisas e vou já procurar no nosso stock. 👇`,
  },
  manual: {
    askModel: (make) =>
      `✅ *${make}*\n\nAgora diz-me o *modelo* do veículo.\n\n` +
      `Exemplo: _Hilux, L200, Actros, Sprinter, Ranger..._`,
    askYear: (make, model) =>
      `✅ *${make} ${model}*\n\nQual é o *ano* do veículo?\n\n` +
      `Exemplo: _2015, 2018, 2020..._`,
    invalidYear: () =>
      `⚠️ Ano inválido. Por favor indica o ano com 4 dígitos.\n\nExemplo: _2018_`,
    askEngineNumber: (make, model, year) =>
      `✅ *${make} ${model} ${year}*\n\n` +
      `Qual é o *número do motor*? _(opcional)_\n\n` +
      `Este número é importante para peças de motor, revisões e manutenção.\n\n` +
      `Se não souberes, responde *"não sei"* e continuamos. 👇`,
    collectionComplete: (summary) =>
      `✅ Perfeito! Registei os dados da tua viatura:\n\n` +
      `${summary}\n\n` +
      `Agora diz-me que peça precisas e eu vou procurar no nosso stock. 👇`,
    askMakePrompt: () =>
      `Sem problema! Vamos preencher os dados manualmente.\n\n` +
      `Qual é a *marca* do veículo?\n\nExemplo: _Toyota, Mercedes, Volvo..._`,
    engineLabel: (engineNumber) => `🔧 Motor: *${engineNumber}*`,
  },
  vin: {
    askVinPrompt: () =>
      `🔢 Perfeito! Envia o número de chassi (VIN) — 17 caracteres, encontras ` +
      `no documento do veículo ou gravado no próprio chassi.`,
    identifying: () => `🔍 A identificar a viatura pelo número de chassi...`,
    decodeFailed: () =>
      `⚠️ Não consegui identificar esse número de chassi.\n\n` +
      `Vamos preencher os dados manualmente. Qual é a *marca* do veículo?\n\n` +
      `Exemplo: _Toyota, Mercedes, Volvo..._`,
    confirmBody: (description) =>
      `✅ Viatura identificada!\n\n🚗 *${description}*\n\nÉ este o teu carro?`,
    confirmButtons: ['✅ Sim, é este', '❌ Não, é outro'],
  },
  document: {
    askPhotoPrompt: () =>
      `📄 Perfeito! Tira uma foto nítida do documento do veículo (livrete/Título) e envia aqui.`,
    received: () => `📄 Recebi a foto. A ler os dados do documento...`,
    downloadFailed: () =>
      `⚠️ Não consegui descarregar a imagem. Por favor tenta enviar novamente, ` +
      `ou responde *"não tenho"* para preencheres os dados manualmente.`,
    processingError: () =>
      `⚠️ Ocorreu um erro ao processar o documento. Por favor tenta novamente, ` +
      `ou responde *"não tenho"* para preencheres os dados manualmente.`,
    notRecognized: () =>
      `Essa imagem não parece ser um documento de viatura (livrete/Título do Veículo).\n\n` +
      `Podes enviar o número de chassi (VIN) por texto, tentar outra foto, ` +
      `ou responder *"não tenho"* para preencheres os dados manualmente.`,
    invalid: (reason) =>
      `⚠️ ${reason}\n\n` +
      `Por favor tenta novamente com uma foto mais nítida, garantindo que:\n\n` +
      `• 📸 A imagem está bem iluminada e focada\n` +
      `• 📄 O documento está completamente visível\n` +
      `• 🔍 O texto está legível sem reflexos ou sombras\n\n` +
      `Ou responde *"não tenho"* para preencheres os dados manualmente. 👇`,
    defaultInvalidReason: 'Não consegui ler os dados do documento.',
    missingEssentialData: () =>
      `⚠️ Consegui ler o documento mas faltam dados essenciais (marca/modelo).\n\n` +
      `Por favor tenta outra foto, ou responde *"não tenho"* para preencheres os dados manualmente.`,
    confirmBody: (description) =>
      `✅ Dados lidos do documento!\n\n🚗 *${description}*\n\nÉ este o teu carro?`,
    licensePlateLabel: (plate) => `Matrícula: ${plate}`,
  },
  vehicleConfirm: {
    confirmedAskPart: (make, model, year) =>
      `Perfeito! 🙌\n\n` +
      `Agora diz-me que peça precisas para o teu *${make} ${model} ${year}*.\n\n` +
      `Exemplo: _"filtro de óleo"_, _"pastilhas de travão"_, _"correia de distribuição"_...`,
    addVehicleButton: () => '➕ Outro carro',
    addVehicleBody: () =>
      `🚗 Vamos identificar o teu novo veículo. Escolhe uma opção 👇`,
    chooseVehiclePrompt: (vehicles) =>
      `Para qual dos teus veículos é isto? 👇\n\n` +
      vehicles.map((v, i) => `${i + 1}️⃣ ${v.make} ${v.model} ${v.year}`).join('\n'),
    vehicleChoiceNotFound: () =>
      `Não percebi. Responde só com o número do veículo. 👆`,
  },
  agent: {
    checkingStock: () => `Um momento, estou a verificar o nosso stock para ti...`,
    noStockFound: () =>
      `Infelizmente não encontrei essa peça em stock agora. Posso registar o teu pedido e avisar quando estiver disponível. Queres que eu faça isso?`,
    optionNotFound: () =>
      `Não consegui identificar a opção escolhida. Por favor responde com o número (ex: 1, 2 ou 3).`,
    serviceUnavailable: () =>
      `⚠️ Estamos com uma instabilidade temporária na nossa plataforma. Por favor tenta novamente daqui a alguns minutos. 🙏`,
    waitlistConfirmed: (productName) =>
      `✅ Perfeito! Vou avisar-te assim que *${productName}* estiver disponível.`,
    waitlistDeclined: () => `Sem problema! 👍`,
    restockNotification: (productName) =>
      `📦 Boas notícias! *${productName}* já está disponível em stock. Queres fazer o pedido?`,
    proformaSentChoosePayment: () =>
      `Proforma enviada! Por favor escolhe um dos métodos de pagamento abaixo. 👇`,
    transferToHuman: () =>
      `Entendido! Vou transferir-te para um dos nossos atendentes. Um momento por favor 🙏`,
    searchListBody: (count, part) =>
      `Encontrei ${count} opção(ões) de *${part}*. Escolhe uma abaixo 👇`,
    searchListBodyForVehicle: (count, part, make, model, year) =>
      `Encontrei ${count} opção(ões) de *${part}* para o teu *${make} ${model} ${year}*. Escolhe uma abaixo 👇`,
    searchListButton: () => 'Ver opções',
  },
  order: {
    rejected: (orderNumber) =>
      `❌ O teu pedido *${orderNumber}* foi rejeitado.\n\n` +
      `Motivo: comprovativo de pagamento não confirmado ou inválido.\n\n` +
      `Se achas que é um erro, responde aqui e um atendente irá ajudar-te. 🙏`,
  },
  payment: {
    methods: {
      bankTransfer: {
        name: 'Transferência Bancária',
        instructions: (orderNumber, amount) =>
          `🏦 *Transferência Bancária*\n\n` +
          `Banco: BFA / BAI / BIC (à tua escolha)\n` +
          `IBAN: AO06 0040 0000 XXXX XXXX XXXX X\n` +
          `Titular: Rede Peças, Lda\n` +
          `Valor: *${amount}*\n` +
          `Referência: *${orderNumber}* _(obrigatório)_\n\n` +
          `Após a transferência, envia aqui o comprovativo (foto ou PDF). 📸`,
      },
      bankDeposit: {
        name: 'Depósito Bancário',
        instructions: (orderNumber, amount) =>
          `🏧 *Depósito Bancário*\n\n` +
          `Banco: BFA / BAI / BIC (à tua escolha)\n` +
          `Nº Conta: 000000000000\n` +
          `Titular: Rede Peças, Lda\n` +
          `Valor: *${amount}*\n` +
          `Referência: *${orderNumber}* _(escreve no talão)_\n\n` +
          `Após o depósito, envia aqui a foto do talão. 📸`,
      },
      multicaixaExpress: {
        name: 'Multicaixa Express',
        instructions: (orderNumber, amount) =>
          `📱 *Multicaixa Express*\n\n` +
          `Número: *+244 900 000 000*\n` +
          `Valor: *${amount}*\n` +
          `Referência: *${orderNumber}* _(coloca na descrição)_\n\n` +
          `Após o pagamento, envia aqui o screenshot da confirmação. 📸`,
      },
      mobilePOS: {
        name: 'TPA Móvel (Terminal de Pagamento)',
        instructions: (orderNumber, amount) =>
          `💳 *TPA Móvel*\n\n` +
          `Um agente da Rede Peças irá até ti com o terminal de pagamento.\n\n` +
          `Valor a pagar: *${amount}*\n` +
          `Pedido: *${orderNumber}*\n\n` +
          `A nossa equipa entrará em contacto para combinar a visita. 🚗`,
      },
      cash: {
        name: 'Dinheiro em Mão',
        instructions: (orderNumber, amount) =>
          `💵 *Pagamento em Dinheiro*\n\n` +
          `Um agente da Rede Peças irá recolher o pagamento na entrega.\n\n` +
          `Valor a preparar: *${amount}*\n` +
          `Pedido: *${orderNumber}*\n\n` +
          `Por favor tenha o valor exacto disponível. 🙏`,
      },
    },
    askMethodBody: (orderNumber, amount) =>
      `💰 *Como preferes pagar?*\n\n` +
      `Pedido: *${orderNumber}*\n` +
      `Valor: *${amount}*\n\n` +
      `Escolhe uma opção:`,
    askMethodButtons: ['🏦 Transferência / Depósito', '📱 Multicaixa Express', '💳 TPA Móvel / Dinheiro'],
    askBankSubtypeBody: () => 'Preferes transferência ou depósito bancário?',
    askBankSubtypeButtons: ['🏦 Transferência', '🏧 Depósito'],
    askInPersonSubtypeBody: () => 'Preferes pagar com cartão no terminal ou em dinheiro na entrega?',
    askInPersonSubtypeButtons: ['💳 TPA (cartão)', '💵 Dinheiro na entrega'],
    proofReceivedCustomer: (methodName, orderNumber) =>
      `✅ *Comprovativo recebido!*\n\n` +
      `Método: ${methodName}\n` +
      `Pedido: *${orderNumber}*\n\n` +
      `A nossa equipa irá verificar o pagamento e emitir a factura em breve.\n` +
      `Normalmente demora menos de 30 minutos em horário de expediente. 🙏`,
    proofInvalid: (reason) =>
      `⚠️ ${reason}\n\n` +
      `Por favor envia novamente o comprovativo, garantindo que a imagem está nítida e mostra ` +
      `claramente o valor, a data e a referência do pagamento. 📸`,
    proofInvalidDefaultReason: 'Não consegui confirmar que esta imagem é um comprovativo de pagamento válido.',
    proofReceivedStaff: (orderNumber, methodName, amount, phone, adminUrl) =>
      `📸 *COMPROVATIVO RECEBIDO*\n\n` +
      `Pedido: *${orderNumber}*\n` +
      `Método: ${methodName}\n` +
      `Valor: *${amount}*\n` +
      `Cliente: ${phone}\n\n` +
      `Acede ao painel para verificar e aprovar:\n` +
      `🔗 ${adminUrl}`,
    inPersonPaymentStaff: (orderNumber, methodName, emoji, amount, phone, isMobilePOS, adminUrl) =>
      `${emoji} *PAGAMENTO PRESENCIAL SOLICITADO*\n\n` +
      `Método: *${methodName}*\n` +
      `Pedido: *${orderNumber}*\n` +
      `Valor: *${amount}*\n` +
      `Cliente: ${phone}\n\n` +
      `${isMobilePOS
        ? 'Leva o terminal TPA ao cliente para efectuar o pagamento.'
        : 'O cliente vai pagar em dinheiro na entrega.'
      }\n\n` +
      `Após confirmação, aprova no painel:\n` +
      `🔗 ${adminUrl}`,
    supplierDeliveryNotice: (productName, reference, quantity, orderNumber) =>
      `📦 *NOVO PEDIDO CONFIRMADO — REDE PEÇAS*\n\n` +
      `Por favor prepare o seguinte artigo para entrega:\n\n` +
      `🔧 Peça: *${productName}*\n` +
      `📋 Referência: ${reference}\n` +
      `🔢 Quantidade: ${quantity}\n` +
      `📋 Nº Pedido: *${orderNumber}*\n\n` +
      `A equipa da Rede Peças entrará em contacto para coordenar a recolha.\n` +
      `Obrigado pela parceria! 🙏`,
  },
  pdf: {
    proforma: {
      companyName: 'REDE PEÇAS',
      tagline: 'Marketplace Automotivo de Angola',
      phone: 'Tel: +244 900 000 000',
      email: 'Email: info@redepecas.ao',
      title: 'FACTURA PROFORMA',
      numberLabel: (orderNumber) => `Nº: ${orderNumber}`,
      dateLabel: (date) => `Data: ${date}`,
      validityLabel: (date) => `Validade: ${date}`,
      clientHeader: 'CLIENTE',
      whatsappLabel: (phone) => `WhatsApp: ${phone}`,
      clientDataNote: '(Dados completos a fornecer no momento do pagamento)',
      tableDescription: 'Descrição',
      tableReference: 'Referência',
      tableQty: 'Qtd',
      tableUnitPrice: 'Preço Unit.',
      tableTotal: 'Total',
      supplierLabel: (supplier) => `Fornecedor: ${supplier}`,
      totalDue: 'TOTAL A PAGAR:',
      paymentInstructionsHeader: 'INSTRUÇÕES DE PAGAMENTO',
      bankLine: '• Transferência bancária: IBAN AO06 0040 0000 XXXX XXXX XXXX X',
      multicaixaLine: '• Multicaixa Express: +244 900 000 000',
      referenceLine: (orderNumber) => `• Referência obrigatória na transferência: ${orderNumber}`,
      afterPaymentLine: '• Após pagamento, envie comprovativo para este WhatsApp',
      termsNote:
        'Esta proforma tem validade de 48 horas. O stock é reservado apenas após confirmação do pagamento. ' +
        'A Rede Peças actua como intermediário entre o cliente e o fornecedor.',
      footer: 'Rede Peças — Marketplace Automotivo de Angola  |  NIF: 5XXXXXXXXX  |  info@redepecas.ao',
    },
    sendMessage: {
      orderConfirmed: (itemName, orderNumber, total) =>
        `✅ *Pedido confirmado!*\n\n` +
        `Segue em anexo a tua factura proforma para:\n` +
        `*${itemName}*\n\n` +
        `📋 Referência: *${orderNumber}*\n` +
        `💰 Total: *${total}*\n` +
        `⏳ Validade: 48 horas\n\n` +
        `Após pagamento, envia o comprovativo aqui nesta conversa. 🙏`,
      documentCaption: (orderNumber) => `Factura Proforma Nº ${orderNumber} — Rede Peças`,
    },
    finalInvoice: {
      notification: () =>
        `🧾 *Factura Oficial AGT Emitida!*\n\n` +
        `O teu pagamento foi validado e a factura oficial já está disponível em anexo.\n` +
        `Obrigado por comprares na Rede Peças! 🚗`,
      documentCaption: (orderNumber) => `Factura Comercial Nº ${orderNumber} — Rede Peças`,
    },
    mockInvoice: {
      headerTitle: 'REDE PEÇAS - FACTURA',
      tagline: 'Marketplace Automotivo de Angola',
      nifLine: 'NIF: 5001234567 (Certificado AGT)',
      title: 'FACTURA COMERCIAL',
      numberLabel: (num) => `Factura Nº: ${num}`,
      dateLabel: (date) => `Data Emissão: ${date}`,
      clientHeader: 'CLIENTE',
      nameLine: 'Nome: Cliente Rede Peças',
      whatsappLabel: (phone) => `WhatsApp: ${phone}`,
      tableDescription: 'Descrição',
      tableReference: 'Referência',
      tableQty: 'Qtd',
      tableUnitPrice: 'Preço Unit.',
      tableTotal: 'Total',
      defaultProductName: 'Peça Automóvel',
      totalPaid: 'TOTAL PAGO:',
      agtStamp: 'Processado por computador. Emitido de acordo com as regras de facturação da AGT Angola.',
    },
  },
  adminAuth: {
    resetCode: (code) =>
      `🔐 Código de recuperação de senha do painel Rede Peças: *${code}*\n\n` +
      `Válido por 10 minutos. Se não pediste isto, ignora esta mensagem.`,
  },
};

const en: Messages = {
  onboarding: {
    welcome: () =>
      `👋 Welcome to *Rede Peças*!\n\n` +
      `We're Angola's auto parts marketplace — ` +
      `we find the right parts for your vehicle as fast as possible. 🚗\n\n` +
      `To help you better, let's set up your profile quickly.\n\n` +
      `*What's your name?* 👇`,
    welcomeBack: (name) =>
      `👋 Hey again, *${name}*! Welcome back to *Rede Peças*. 😊`,
    resumeRegistration: () =>
      `👋 Let's continue your registration!`,
    askNameOnly: () => `*What's your name?* 👇`,
    askNifBody: (name) =>
      `Nice to meet you, *${name}*! 🤝\n\n` +
      `Do you have a *NIF* (tax ID) to include on invoices?\n` +
      `_(useful if you're buying on behalf of a company)_`,
    askNifButtons: ['✅ Yes, I have a NIF', '❌ No, thanks'],
    askNifNumber: () =>
      `Great! Type your *NIF number* 👇`,
    askAddress: () =>
      `What's your preferred *delivery address*?\n\n` +
      `Example: _Bairro Morro Bento, Rua da Samba, Nº 12, Luanda_\n\n` +
      `_(reply "skip" if you'd rather provide it when placing an order)_`,
    askVehicleIdBody: (name) =>
      `✅ *Profile created successfully, ${name}!*\n\n` +
      `Next time you message us, I'll already recognize you. 😊\n\n` +
      `Now I need to identify your vehicle. Pick an option 👇`,
    askVehicleIdButtons: ['🔢 I have the VIN', '📄 Send a photo', '✍️ Manual entry'],
    resumeVehicleIdBody: (name) =>
      `👋 Welcome back, *${name}*!\n\n` +
      `I still need to identify your vehicle. Pick an option 👇`,
    onboardingComplete: (name, vehicleSummary) =>
      `✅ You're registered with *Rede Peças*, ${name}! 🎉\n\n` +
      `${vehicleSummary}\n\n` +
      `How can I help you today? Tell me which part you need and I'll search our stock right away. 👇`,
  },
  manual: {
    askModel: (make) =>
      `✅ *${make}*\n\nNow tell me the *model* of the vehicle.\n\n` +
      `Example: _Hilux, L200, Actros, Sprinter, Ranger..._`,
    askYear: (make, model) =>
      `✅ *${make} ${model}*\n\nWhat *year* is the vehicle?\n\n` +
      `Example: _2015, 2018, 2020..._`,
    invalidYear: () =>
      `⚠️ Invalid year. Please enter the year with 4 digits.\n\nExample: _2018_`,
    askEngineNumber: (make, model, year) =>
      `✅ *${make} ${model} ${year}*\n\n` +
      `What's the *engine number*? _(optional)_\n\n` +
      `This number matters for engine parts, servicing, and maintenance.\n\n` +
      `If you don't know it, reply *"don't know"* and we'll continue. 👇`,
    collectionComplete: (summary) =>
      `✅ Great! I've saved your vehicle's details:\n\n` +
      `${summary}\n\n` +
      `Now tell me which part you need and I'll search our stock. 👇`,
    askMakePrompt: () =>
      `No problem! Let's fill in the details manually.\n\n` +
      `What's the *make* of the vehicle?\n\nExample: _Toyota, Mercedes, Volvo..._`,
    engineLabel: (engineNumber) => `🔧 Engine: *${engineNumber}*`,
  },
  vin: {
    askVinPrompt: () =>
      `🔢 Perfect! Send the chassis number (VIN) — 17 characters, found on the ` +
      `vehicle document or stamped on the chassis itself.`,
    identifying: () => `🔍 Identifying the vehicle from the chassis number...`,
    decodeFailed: () =>
      `⚠️ I couldn't identify that chassis number.\n\n` +
      `Let's fill in the details manually. What's the *make* of the vehicle?\n\n` +
      `Example: _Toyota, Mercedes, Volvo..._`,
    confirmBody: (description) =>
      `✅ Vehicle identified!\n\n🚗 *${description}*\n\nIs this your car?`,
    confirmButtons: ['✅ Yes, that\'s it', '❌ No, different car'],
  },
  document: {
    askPhotoPrompt: () =>
      `📄 Perfect! Take a clear photo of the vehicle document (registration/title) and send it here.`,
    received: () => `📄 Got the photo. Reading the document's data...`,
    downloadFailed: () =>
      `⚠️ I couldn't download the image. Please try sending it again, ` +
      `or reply *"I don't have it"* to fill in the details manually.`,
    processingError: () =>
      `⚠️ Something went wrong processing the document. Please try again, ` +
      `or reply *"I don't have it"* to fill in the details manually.`,
    notRecognized: () =>
      `That image doesn't look like a vehicle document (registration/title).\n\n` +
      `You can send the chassis number (VIN) as text, try another photo, ` +
      `or reply *"I don't have it"* to fill in the details manually.`,
    invalid: (reason) =>
      `⚠️ ${reason}\n\n` +
      `Please try again with a clearer photo, making sure that:\n\n` +
      `• 📸 The image is well lit and in focus\n` +
      `• 📄 The document is fully visible\n` +
      `• 🔍 The text is legible with no glare or shadows\n\n` +
      `Or reply *"I don't have it"* to fill in the details manually. 👇`,
    defaultInvalidReason: "I couldn't read the document's data.",
    missingEssentialData: () =>
      `⚠️ I read the document but essential data is missing (make/model).\n\n` +
      `Please try another photo, or reply *"I don't have it"* to fill in the details manually.`,
    confirmBody: (description) =>
      `✅ Data read from the document!\n\n🚗 *${description}*\n\nIs this your car?`,
    licensePlateLabel: (plate) => `Plate: ${plate}`,
  },
  vehicleConfirm: {
    confirmedAskPart: (make, model, year) =>
      `Perfect! 🙌\n\n` +
      `Now tell me which part you need for your *${make} ${model} ${year}*.\n\n` +
      `Example: _"oil filter"_, _"brake pads"_, _"timing belt"_...`,
    addVehicleButton: () => '➕ Add vehicle',
    addVehicleBody: () =>
      `🚗 Let's identify your new vehicle. Pick an option 👇`,
    chooseVehiclePrompt: (vehicles) =>
      `Which of your vehicles is this for? 👇\n\n` +
      vehicles.map((v, i) => `${i + 1}️⃣ ${v.make} ${v.model} ${v.year}`).join('\n'),
    vehicleChoiceNotFound: () =>
      `I didn't get that. Reply with just the vehicle's number. 👆`,
  },
  agent: {
    checkingStock: () => `One moment, checking our stock for you...`,
    noStockFound: () =>
      `Unfortunately I couldn't find that part in stock right now. I can register your request and notify you when it's available. Want me to do that?`,
    optionNotFound: () =>
      `I couldn't identify which option you chose. Please reply with the number (e.g. 1, 2, or 3).`,
    serviceUnavailable: () =>
      `⚠️ We're experiencing temporary instability on our platform. Please try again in a few minutes. 🙏`,
    waitlistConfirmed: (productName) =>
      `✅ Perfect! I'll let you know as soon as *${productName}* is available.`,
    waitlistDeclined: () => `No problem! 👍`,
    restockNotification: (productName) =>
      `📦 Good news! *${productName}* is back in stock. Want to place an order?`,
    proformaSentChoosePayment: () =>
      `Proforma sent! Please choose one of the payment methods below. 👇`,
    transferToHuman: () =>
      `Got it! I'll transfer you to one of our staff. One moment please 🙏`,
    searchListBody: (count, part) =>
      `I found ${count} option(s) for *${part}*. Pick one below 👇`,
    searchListBodyForVehicle: (count, part, make, model, year) =>
      `I found ${count} option(s) for *${part}* for your *${make} ${model} ${year}*. Pick one below 👇`,
    searchListButton: () => 'View options',
  },
  order: {
    rejected: (orderNumber) =>
      `❌ Your order *${orderNumber}* was rejected.\n\n` +
      `Reason: payment proof not confirmed or invalid.\n\n` +
      `If you think this is a mistake, reply here and a staff member will help you. 🙏`,
  },
  payment: {
    methods: {
      bankTransfer: {
        name: 'Bank Transfer',
        instructions: (orderNumber, amount) =>
          `🏦 *Bank Transfer*\n\n` +
          `Bank: BFA / BAI / BIC (your choice)\n` +
          `IBAN: AO06 0040 0000 XXXX XXXX XXXX X\n` +
          `Account holder: Rede Peças, Lda\n` +
          `Amount: *${amount}*\n` +
          `Reference: *${orderNumber}* _(required)_\n\n` +
          `After the transfer, send the proof here (photo or PDF). 📸`,
      },
      bankDeposit: {
        name: 'Bank Deposit',
        instructions: (orderNumber, amount) =>
          `🏧 *Bank Deposit*\n\n` +
          `Bank: BFA / BAI / BIC (your choice)\n` +
          `Account No.: 000000000000\n` +
          `Account holder: Rede Peças, Lda\n` +
          `Amount: *${amount}*\n` +
          `Reference: *${orderNumber}* _(write on the receipt)_\n\n` +
          `After the deposit, send a photo of the receipt here. 📸`,
      },
      multicaixaExpress: {
        name: 'Multicaixa Express',
        instructions: (orderNumber, amount) =>
          `📱 *Multicaixa Express*\n\n` +
          `Number: *+244 900 000 000*\n` +
          `Amount: *${amount}*\n` +
          `Reference: *${orderNumber}* _(put it in the description)_\n\n` +
          `After paying, send the confirmation screenshot here. 📸`,
      },
      mobilePOS: {
        name: 'Mobile POS Terminal',
        instructions: (orderNumber, amount) =>
          `💳 *Mobile POS*\n\n` +
          `A Rede Peças agent will come to you with the payment terminal.\n\n` +
          `Amount due: *${amount}*\n` +
          `Order: *${orderNumber}*\n\n` +
          `Our team will contact you to arrange the visit. 🚗`,
      },
      cash: {
        name: 'Cash on Delivery',
        instructions: (orderNumber, amount) =>
          `💵 *Cash Payment*\n\n` +
          `A Rede Peças agent will collect payment on delivery.\n\n` +
          `Amount to prepare: *${amount}*\n` +
          `Order: *${orderNumber}*\n\n` +
          `Please have the exact amount ready. 🙏`,
      },
    },
    askMethodBody: (orderNumber, amount) =>
      `💰 *How would you like to pay?*\n\n` +
      `Order: *${orderNumber}*\n` +
      `Amount: *${amount}*\n\n` +
      `Choose an option:`,
    askMethodButtons: ['🏦 Transfer / Deposit', '📱 Multicaixa Express', '💳 Mobile POS / Cash'],
    askBankSubtypeBody: () => 'Would you prefer a bank transfer or a bank deposit?',
    askBankSubtypeButtons: ['🏦 Transfer', '🏧 Deposit'],
    askInPersonSubtypeBody: () => 'Would you prefer to pay by card on the terminal or cash on delivery?',
    askInPersonSubtypeButtons: ['💳 POS (card)', '💵 Cash on delivery'],
    proofReceivedCustomer: (methodName, orderNumber) =>
      `✅ *Proof received!*\n\n` +
      `Method: ${methodName}\n` +
      `Order: *${orderNumber}*\n\n` +
      `Our team will verify the payment and issue the invoice shortly.\n` +
      `Usually takes under 30 minutes during business hours. 🙏`,
    proofInvalid: (reason) =>
      `⚠️ ${reason}\n\n` +
      `Please resend the payment proof, making sure the image is clear and shows the ` +
      `amount, date, and payment reference. 📸`,
    proofInvalidDefaultReason: "I couldn't confirm this image is a valid payment proof.",
    proofReceivedStaff: (orderNumber, methodName, amount, phone, adminUrl) =>
      `📸 *PAYMENT PROOF RECEIVED*\n\n` +
      `Order: *${orderNumber}*\n` +
      `Method: ${methodName}\n` +
      `Amount: *${amount}*\n` +
      `Customer: ${phone}\n\n` +
      `Go to the panel to verify and approve:\n` +
      `🔗 ${adminUrl}`,
    inPersonPaymentStaff: (orderNumber, methodName, emoji, amount, phone, isMobilePOS, adminUrl) =>
      `${emoji} *IN-PERSON PAYMENT REQUESTED*\n\n` +
      `Method: *${methodName}*\n` +
      `Order: *${orderNumber}*\n` +
      `Amount: *${amount}*\n` +
      `Customer: ${phone}\n\n` +
      `${isMobilePOS
        ? 'Bring the mobile POS terminal to the customer to process payment.'
        : 'The customer will pay in cash on delivery.'
      }\n\n` +
      `After confirming, approve it in the panel:\n` +
      `🔗 ${adminUrl}`,
    supplierDeliveryNotice: (productName, reference, quantity, orderNumber) =>
      `📦 *NEW ORDER CONFIRMED — REDE PEÇAS*\n\n` +
      `Please prepare the following item for delivery:\n\n` +
      `🔧 Part: *${productName}*\n` +
      `📋 Reference: ${reference}\n` +
      `🔢 Quantity: ${quantity}\n` +
      `📋 Order No.: *${orderNumber}*\n\n` +
      `The Rede Peças team will contact you to arrange pickup.\n` +
      `Thanks for the partnership! 🙏`,
  },
  pdf: {
    proforma: {
      companyName: 'REDE PEÇAS',
      tagline: "Angola's Auto Parts Marketplace",
      phone: 'Tel: +244 900 000 000',
      email: 'Email: info@redepecas.ao',
      title: 'PROFORMA INVOICE',
      numberLabel: (orderNumber) => `No.: ${orderNumber}`,
      dateLabel: (date) => `Date: ${date}`,
      validityLabel: (date) => `Valid until: ${date}`,
      clientHeader: 'CLIENT',
      whatsappLabel: (phone) => `WhatsApp: ${phone}`,
      clientDataNote: '(Full details to be provided at time of payment)',
      tableDescription: 'Description',
      tableReference: 'Reference',
      tableQty: 'Qty',
      tableUnitPrice: 'Unit Price',
      tableTotal: 'Total',
      supplierLabel: (supplier) => `Supplier: ${supplier}`,
      totalDue: 'TOTAL DUE:',
      paymentInstructionsHeader: 'PAYMENT INSTRUCTIONS',
      bankLine: '• Bank transfer: IBAN AO06 0040 0000 XXXX XXXX XXXX X',
      multicaixaLine: '• Multicaixa Express: +244 900 000 000',
      referenceLine: (orderNumber) => `• Reference required on the transfer: ${orderNumber}`,
      afterPaymentLine: '• After payment, send proof to this WhatsApp',
      termsNote:
        'This proforma is valid for 48 hours. Stock is only reserved after payment is confirmed. ' +
        'Rede Peças acts as an intermediary between the customer and the supplier.',
      footer: "Rede Peças — Angola's Auto Parts Marketplace  |  NIF: 5XXXXXXXXX  |  info@redepecas.ao",
    },
    sendMessage: {
      orderConfirmed: (itemName, orderNumber, total) =>
        `✅ *Order confirmed!*\n\n` +
        `Attached is your proforma invoice for:\n` +
        `*${itemName}*\n\n` +
        `📋 Reference: *${orderNumber}*\n` +
        `💰 Total: *${total}*\n` +
        `⏳ Valid for: 48 hours\n\n` +
        `After payment, send the proof here in this conversation. 🙏`,
      documentCaption: (orderNumber) => `Proforma Invoice No. ${orderNumber} — Rede Peças`,
    },
    finalInvoice: {
      notification: () =>
        `🧾 *Official AGT Invoice Issued!*\n\n` +
        `Your payment has been validated and the official invoice is now attached.\n` +
        `Thanks for shopping with Rede Peças! 🚗`,
      documentCaption: (orderNumber) => `Commercial Invoice No. ${orderNumber} — Rede Peças`,
    },
    mockInvoice: {
      headerTitle: 'REDE PEÇAS - INVOICE',
      tagline: "Angola's Auto Parts Marketplace",
      nifLine: 'NIF: 5001234567 (AGT Certified)',
      title: 'COMMERCIAL INVOICE',
      numberLabel: (num) => `Invoice No.: ${num}`,
      dateLabel: (date) => `Issue Date: ${date}`,
      clientHeader: 'CLIENT',
      nameLine: 'Name: Rede Peças Customer',
      whatsappLabel: (phone) => `WhatsApp: ${phone}`,
      tableDescription: 'Description',
      tableReference: 'Reference',
      tableQty: 'Qty',
      tableUnitPrice: 'Unit Price',
      tableTotal: 'Total',
      defaultProductName: 'Auto Part',
      totalPaid: 'TOTAL PAID:',
      agtStamp: 'Computer-processed. Issued in accordance with AGT Angola billing rules.',
    },
  },
  adminAuth: {
    resetCode: (code) =>
      `🔐 Rede Peças admin panel password reset code: *${code}*\n\n` +
      `Valid for 10 minutes. If you didn't request this, ignore this message.`,
  },
};

export const t: Messages = config.messageLocale === 'en' ? en : pt;
