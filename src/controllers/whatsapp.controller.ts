import { Request, Response } from 'express';
import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config/config.js';
import { logger } from '../config/logger.js';
import {
  getAndUpdateCustomer,
  createCustomerPreRegistration,
  updateCustomer,
  getCustomerByPhone
} from '../models/crm.model.js';
import {
  getCustomerVehicle,
  saveVehicleSession,
  clearVehicleSession,
  getActiveManualCollection,
  updateManualCollection,
  createOrder,
  getLatestOrderByStatus,
  generateOrderNumber,
  startManualCollection,
  searchPartsInInventory,
  PartItem
} from '../models/inventory.model.js';
import fs from 'fs';
import { isVIN, decodeVIN } from '../services/vin.service.js';
import { sendWhatsAppMessage, sendWhatsAppButtons } from '../services/whatsapp.service.js';
import {
  askPaymentMethod,
  processMethodChoice,
  processMethodSubtype,
  processPaymentProof
} from '../services/payment.service.js';
import {
  getHistory,
  saveHistory,
  savePendingOptions,
  getPendingOptions,
  clearPendingOptions
} from '../services/session.service.js';
import { generateProformaPDF, sendProformaWhatsApp } from '../services/pdf.service.js';
import { formatPrice, capitalize } from '../utils/helpers.js';

const anthropic = new Anthropic({ apiKey: config.anthropic.apiKey });

// Prompt text is Portuguese (the customer conversation language);
// the structured-action JSON keys are English (machine protocol).
const SYSTEM_PROMPT = `
És o assistente virtual da Rede Peças, um marketplace automotivo em Angola.
O teu trabalho é ajudar clientes a encontrar peças para os seus veículos.

REGRAS:
1. Sê sempre simpático e directo. Fala em português angolano informal.
2. Extrai do pedido do cliente: peça, marca do veículo, modelo e ano.
3. Se faltarem dados críticos (marca ou modelo), faz UMA pergunta curta para obtê-los.
4. Quando tiveres informação suficiente, devolve APENAS um JSON válido neste formato:
   { "action": "search", "part": "...", "vehicle_make": "...", "model": "...", "year": "..." }
5. Se o cliente escolher uma opção (ex: responde "2" ou "quero a segunda"), devolve:
   { "action": "confirm_order", "chosen_option": 2 }
6. Se o cliente quiser falar com humano, devolve:
   { "action": "transfer_to_human", "reason": "..." }
7. Para qualquer outra mensagem de conversa normal, responde em texto simples — NÃO em JSON.

EXEMPLOS DE EXTRACÇÃO:
- "filtro de óleo pra Golf 2019" → { "action": "search", "part": "filtro de óleo", "vehicle_make": "Volkswagen", "model": "Golf", "year": "2019" }
- "correia da Toyota Hilux" → pede o ano, pois é crítico para compatibilidade
- "preciso de amortecedor dianteiro" → pede marca e modelo do carro
`;

// Meta Webhook Verification
export async function verifyWebhook(req: Request, res: Response): Promise<void> {
  const verifyToken = config.whatsapp.verifyToken;
  if (
    req.query['hub.mode'] === 'subscribe' &&
    req.query['hub.verify_token'] === verifyToken
  ) {
    res.send(req.query['hub.challenge']);
  } else {
    res.sendStatus(403);
  }
}

// Meta Webhook Main Handler
export async function receiveWebhookMessage(req: Request, res: Response): Promise<void> {
  // Respond immediately to Meta (must return 200 within 5 seconds)
  res.sendStatus(200);

  try {
    const entry = req.body?.entry?.[0];
    const change = entry?.changes?.[0];
    const msg = change?.value?.messages?.[0];
    if (!msg) return;

    const phone = msg.from;
    const customerText = msg.type === 'text' ? msg.text?.body : null;
    const mediaType = msg.type; // "image" | "document" | "text" etc.
    const mediaId = msg.image?.id || msg.document?.id || null;

    logger.debug(`[${phone}] Webhook type: ${mediaType}, text: ${customerText}`);

    await processMessageFlow(phone, customerText, mediaType, mediaId);
  } catch (error: any) {
    logger.error('Error in WhatsApp webhook processing', error);
  }
}

/**
 * Coordinates routing of incoming user events.
 */
async function processMessageFlow(
  phone: string,
  customerText: string | null,
  mediaType: string,
  mediaId: string | null
): Promise<void> {
  // 1. Check or start CRM customer registration flow
  const customer = await getAndUpdateCustomer(phone);

  if (!customer) {
    await createCustomerPreRegistration(phone, 'awaiting_name');
    await sendWhatsAppMessage(
      phone,
      `👋 Bem-vindo à *Rede Peças*!\n\n` +
      `Somos o marketplace automotivo de Angola — ` +
      `encontramos as peças certas para o teu veículo no menor tempo possível. 🚗\n\n` +
      `Para te servir melhor, vou registar o teu perfil rapidamente.\n\n` +
      `*Como te chamas?* 👇`
    );
    return;
  }

  // If CRM registration is incomplete, process it
  if (customer.registration_status !== 'complete') {
    if (!customerText) return;
    const handled = await processCRMRegistration(phone, customer.registration_status, customerText);
    if (handled) return;
  }

  // 2. PRIORITY: Customer sent payment proof media (image/document)
  if (mediaType === 'image' || mediaType === 'document') {
    if (mediaId) {
      const handled = await processPaymentProof(phone, mediaId, mediaType);
      if (handled) return;
    }
  }

  if (!customerText) return;

  // 3. PRIORITY: Customer is in active manual vehicle collection flow
  const activeCollection = await getActiveManualCollection(phone);
  if (activeCollection) {
    const handled = await processManualCollectionStep(phone, activeCollection, customerText);
    if (handled) return;
  }

  // 4. PRIORITY: Alphanumeric 17-char VIN detected
  if (isVIN(customerText)) {
    await processVIN(phone, customerText);
    return;
  }

  // 5. PRIORITY: Customer is confirming/rejecting decoded VIN car
  const confirmedVehicle = await processVehicleConfirmation(phone, customerText);
  if (confirmedVehicle) return;

  // 6. PRIORITY: Active payment status waiting for inputs
  const latestOrder = await getLatestOrderByStatus(phone, [
    'awaiting_payment_method',
    'awaiting_bank_subtype',
    'awaiting_in_person_subtype'
  ]);

  if (latestOrder) {
    const handled = latestOrder.status === 'awaiting_payment_method'
      ? await processMethodChoice(phone, customerText)
      : await processMethodSubtype(phone, customerText);
    if (handled) return;
  }

  // 7. Conversational AI agent pipeline
  await processAIConversation(phone, customerText);
}

/**
 * Handles CRM registration states.
 */
async function processCRMRegistration(phone: string, status: string, reply: string): Promise<boolean> {
  const r = reply.trim();

  if (status === 'awaiting_name') {
    const name = capitalize(r);
    await updateCustomer(phone, { name, registration_status: 'awaiting_nif' });
    await sendWhatsAppButtons(
      phone,
      `Prazer, *${name}*! 🤝\n\n` +
      `Tens *NIF* para incluir nas facturas?\n` +
      `_(útil se comprares em nome de empresa)_`,
      ['✅ Sim, tenho NIF', '❌ Não, obrigado']
    );
    return true;
  }

  if (status === 'awaiting_nif') {
    const rLower = r.toLowerCase();
    const noNif = rLower.includes('não') || rLower.includes('nao') || rLower.includes('❌') || rLower.includes('nao obrigado') || r === '2';
    const nif = noNif ? null : r.replace(/\s/g, '').toUpperCase();

    await updateCustomer(phone, { nif, registration_status: 'awaiting_address' });
    await sendWhatsAppMessage(
      phone,
      `Qual é o teu *endereço de entrega* preferido?\n\n` +
      `Exemplo: _Bairro Morro Bento, Rua da Samba, Nº 12, Luanda_\n\n` +
      `_(responde "saltar" se preferires indicar no momento do pedido)_`
    );
    return true;
  }

  if (status === 'awaiting_address') {
    const rLower = r.toLowerCase();
    const address = (rLower === 'saltar' || rLower === 'skip') ? null : r;

    await updateCustomer(phone, {
      address,
      registration_status: 'complete',
      registered_at: new Date(),
    });

    const cust = await getCustomerByPhone(phone);
    const name = cust?.name?.split(' ')[0] || 'Cliente';

    await sendWhatsAppMessage(
      phone,
      `✅ *Perfil criado com sucesso, ${name}!*\n\n` +
      `Da próxima vez que nos contactares já te reconheço. 😊\n\n` +
      `Agora diz-me o que precisas — podes enviar o número de chassi (VIN), ` +
      `ou simplesmente descrever a peça e o teu carro. 👇`
    );
    return true;
  }

  return false;
}

/**
 * Handles manual vehicle information inputs.
 */
async function processManualCollectionStep(phone: string, collection: any, reply: string): Promise<boolean> {
  const r = reply.trim();

  if (collection.status === 'awaiting_make') {
    const make = capitalize(r);
    await updateManualCollection(phone, { make, status: 'awaiting_model' });
    await sendWhatsAppMessage(
      phone,
      `✅ *${make}*\n\nAgora diz-me o *modelo* do veículo.\n\n` +
      `Exemplo: _Hilux, L200, Actros, Sprinter, Ranger..._`
    );
    return true;
  }

  if (collection.status === 'awaiting_model') {
    const model = capitalize(r);
    await updateManualCollection(phone, { model, status: 'awaiting_year' });
    await sendWhatsAppMessage(
      phone,
      `✅ *${collection.make} ${model}*\n\nQual é o *ano* do veículo?\n\n` +
      `Exemplo: _2015, 2018, 2020..._`
    );
    return true;
  }

  if (collection.status === 'awaiting_year') {
    const yearClean = r.replace(/\D/g, '');
    const yearInt = parseInt(yearClean, 10);
    const currentYear = new Date().getFullYear();

    if (!yearClean || yearClean.length !== 4 || yearInt < 1980 || yearInt > currentYear + 1) {
      await sendWhatsAppMessage(
        phone,
        `⚠️ Ano inválido. Por favor indica o ano com 4 dígitos.\n\nExemplo: _2018_`
      );
      return true;
    }

    await updateManualCollection(phone, { year: yearClean, status: 'awaiting_engine_number' });
    await sendWhatsAppMessage(
      phone,
      `✅ *${collection.make} ${collection.model} ${yearClean}*\n\n` +
      `Qual é o *número do motor*? _(opcional)_\n\n` +
      `Este número é importante para peças de motor, revisões e manutenção.\n\n` +
      `Se não souberes, responde *"não sei"* e continuamos. 👇`
    );
    return true;
  }

  if (collection.status === 'awaiting_engine_number') {
    const rLower = r.toLowerCase();
    const engineNumber = (rLower === 'não sei' || rLower === 'nao sei' || rLower === 'n' || rLower === 'skip' || rLower === 'não')
      ? null
      : r.toUpperCase();

    // Complete vehicle session
    await saveVehicleSession(phone, {
      make: collection.make,
      model: collection.model,
      year: collection.year,
      engine_number: engineNumber,
    });

    // Mark manual collection as complete
    await updateManualCollection(phone, { status: 'complete' });

    const summary = [
      `🚗 *${collection.make} ${collection.model} ${collection.year}*`,
      engineNumber ? `🔧 Motor: *${engineNumber}*` : null,
    ].filter(Boolean).join('\n');

    await sendWhatsAppMessage(
      phone,
      `✅ Perfeito! Registei os dados da tua viatura:\n\n` +
      `${summary}\n\n` +
      `Agora diz-me que peça precisas e eu vou procurar no nosso stock. 👇`
    );
    return true;
  }

  return false;
}

/**
 * Handles incoming VIN number parsing.
 */
async function processVIN(phone: string, vin: string): Promise<void> {
  const vinClean = vin.trim().toUpperCase();

  await sendWhatsAppMessage(
    phone,
    `🔍 A identificar a viatura pelo número de chassi...`
  );

  const vehicle = await decodeVIN(vinClean);

  if (!vehicle) {
    // If API lookup fails, fallback to step-by-step manual inputs
    await startManualCollection(phone, 'awaiting_make', vinClean);
    return;
  }

  // Save parsed chassis data in database cache and session
  await saveVehicleSession(phone, {
    vin: vinClean,
    make: vehicle.make,
    model: vehicle.model,
    year: vehicle.year,
    fuel_type: vehicle.fuel_type,
    engine_size: vehicle.engine,
  });

  const description = [
    `${vehicle.make} ${vehicle.model} ${vehicle.year}`,
    vehicle.engine ? `${vehicle.engine}` : null,
    vehicle.fuel_type ? `${vehicle.fuel_type}` : null,
    vehicle.vehicle_type ? `${vehicle.vehicle_type}` : null,
  ].filter(Boolean).join(' · ');

  await sendWhatsAppButtons(
    phone,
    `✅ Viatura identificada!\n\n` +
    `🚗 *${description}*\n\n` +
    `É este o teu carro?`,
    ['✅ Sim, é este', '❌ Não, é outro']
  );
}

/**
 * Processes vehicle quick confirmation buttons.
 */
async function processVehicleConfirmation(phone: string, reply: string): Promise<boolean> {
  const r = reply.toLowerCase();

  if (r.includes('sim') || r.includes('yes') || r.includes('✅') || r === '1' || r.includes('btn_0')) {
    const v = await getCustomerVehicle(phone);
    if (!v) return false;

    await sendWhatsAppMessage(
      phone,
      `Perfeito! 🙌\n\n` +
      `Agora diz-me que peça precisas para o teu *${v.make} ${v.model} ${v.year}*.\n\n` +
      `Exemplo: _"filtro de óleo"_, _"pastilhas de travão"_, _"correia de distribuição"_...`
    );
    return true;
  }

  if (r.includes('não') || r.includes('nao') || r.includes('❌') || r === '2' || r.includes('btn_1')) {
    await clearVehicleSession(phone);
    await sendWhatsAppMessage(
      phone,
      `Sem problema! Diz-me a *marca*, *modelo* e *ano* do teu carro. 👇\n\n` +
      `Exemplo: _"Toyota Hilux 2018"_`
    );
    return true;
  }

  return false;
}

/**
 * Conversation flow processing using Anthropic API.
 */
async function processAIConversation(phone: string, customerText: string): Promise<void> {
  const history = await getHistory(phone);
  const vehicle = await getCustomerVehicle(phone);

  let enrichedText = customerText;
  // Enrich query context with session vehicle metadata if the customer doesn't type it
  if (vehicle && !customerText.toLowerCase().includes(vehicle.make.toLowerCase())) {
    enrichedText =
      `[Viatura do cliente: ${vehicle.make} ${vehicle.model} ${vehicle.year}] ` +
      customerText;
  }

  history.push({ role: 'user', content: enrichedText });

  const aiReply = await callAnthropic(history);
  const action = tryParseJSON(aiReply);

  if (!action) {
    await sendWhatsAppMessage(phone, aiReply);
    // Push the clean agent text response to session history
    history.push({ role: 'assistant', content: aiReply });
  } else {
    // If agent requested search, inject vehicle parameters from session cache if missing
    if (action.action === 'search' && vehicle) {
      action.vehicle_make = action.vehicle_make || vehicle.make;
      action.model = action.model || vehicle.model;
      action.year = action.year || vehicle.year;
    }
    await executeStructuredAction(phone, action, history);
  }

  await saveHistory(phone, history);
}

async function callAnthropic(history: any[]): Promise<string> {
  // Strip temporary fields from history before sending to Anthropic SDK
  const cleanMessages = history.map((h) => ({
    role: h.role,
    content: h.content,
  }));

  const response = await anthropic.messages.create({
    model: 'claude-3-5-sonnet-20241022',
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: cleanMessages,
  });

  // Extract response text
  const textContent = response.content.find(c => c.type === 'text');
  return textContent?.type === 'text' ? textContent.text : '';
}

/**
 * Orchestrates backend JSON actions returned by the AI agent.
 */
async function executeStructuredAction(phone: string, action: any, history: any): Promise<void> {
  switch (action.action) {
    case 'search': {
      await sendWhatsAppMessage(phone, 'Um momento, estou a verificar o nosso stock para ti...');

      const options = await searchPartsInInventory({
        part: action.part,
        vehicle_make: action.vehicle_make,
        model: action.model,
        year: action.year,
      });

      if (!options || options.length === 0) {
        const msg = `Infelizmente não encontrei essa peça em stock agora. Posso registar o teu pedido e avisar quando estiver disponível. Queres que eu faça isso?`;
        await sendWhatsAppMessage(phone, msg);
        history.push({ role: 'assistant', content: msg });
        return;
      }

      // Persist results so the customer's numeric choice in the next message can resolve them
      await savePendingOptions(phone, options);

      const optionsMessage = formatSearchOptions(options, action);
      await sendWhatsAppMessage(phone, optionsMessage);
      history.push({ role: 'assistant', content: optionsMessage });
      break;
    }

    case 'confirm_order': {
      const options = await getPendingOptions(phone);
      const idx = (action.chosen_option || 1) - 1;
      const choice = options?.[idx];

      if (!choice) {
        await sendWhatsAppMessage(
          phone,
          'Não consegui identificar a opção escolhida. Por favor responde com o número (ex: 1, 2 ou 3).'
        );
        return;
      }

      const orderNumber = await generateOrderNumber();

      // Save order record
      await createOrder(orderNumber, phone, choice);

      // Generate invoice proforma PDF
      const proformaPath = await generateProformaPDF(orderNumber, phone, choice);

      // Send confirmation text & PDF attachment
      await sendProformaWhatsApp(phone, proformaPath, orderNumber, choice);

      // Trigger payment selection prompt
      await askPaymentMethod(phone, orderNumber, choice.price);

      // Options consumed — prevent a stale numeric reply from creating a duplicate order
      await clearPendingOptions(phone);

      // Clean temp PDF asynchronously
      setTimeout(() => {
        try {
          fs.unlinkSync(proformaPath);
        } catch {
          // best-effort cleanup, ignore if already removed
        }
      }, 60000);

      const confirmation = `Proforma enviada! Por favor escolhe um dos métodos de pagamento abaixo. 👇`;
      history.push({ role: 'assistant', content: confirmation });
      break;
    }

    case 'transfer_to_human': {
      const msg =
        'Entendido! Vou transferir-te para um dos nossos atendentes. ' +
        'Um momento por favor 🙏';
      await sendWhatsAppMessage(phone, msg);
      logger.info(`[SUPPORT] Customer ${phone} requested human support. Reason: ${action.reason}`);
      break;
    }

    default:
      logger.warn('Unknown structured action from AI agent', action);
  }
}

function formatSearchOptions(options: PartItem[], action: any): string {
  const numberEmojis = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣'];
  const top5 = options.slice(0, 5);

  let msg = `Encontrei ${top5.length} opção(ões) de *${action.part}* para o teu *${action.vehicle_make} ${action.model} ${action.year}*:\n\n`;

  top5.forEach((item, i) => {
    msg += `${numberEmojis[i]} *${item.name}*\n`;
    msg += `   Ref: ${item.reference}\n`;
    msg += `   Preço: ${formatPrice(item.price)}\n`;
    msg += `   Stock: ${item.quantity} unidade(s)\n`;
    msg += `   Entrega: ${item.delivery_time}\n`;
    if (item.supplier) msg += `   Fornecedor: ${item.supplier}\n`;
    msg += '\n';
  });

  msg += 'Responde com o *número* da opção que preferes 👇';
  return msg;
}

function tryParseJSON(text: string): any | null {
  try {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}
