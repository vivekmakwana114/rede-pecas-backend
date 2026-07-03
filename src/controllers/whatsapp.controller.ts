import { Request, Response } from 'express';
import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config/config.js';
import { logger } from '../config/logger.js';
import {
  getAndUpdateCustomer,
  createCustomerPreRegistration,
  updateCustomer,
  getCustomerByPhone,
  Customer
} from '../models/customer.model.js';
import {
  getCustomerVehicle,
  saveVehicleSession,
  clearVehicleSession,
  getActiveManualCollection,
  updateManualCollection,
  startManualCollection,
} from '../models/vehicle.model.js';
import {
  createOrder,
  getLatestOrderByStatus,
  generateOrderNumber,
} from '../models/order.model.js';
import {
  searchProductsInInventory,
  Product
} from '../models/product.model.js';
import fs from 'fs';
import { isVIN, decodeVIN } from '../services/vin.service.js';
import { extractDataWithClaudeVision, VisionData } from '../services/ai.service.js';
import { sendWhatsAppMessage, sendWhatsAppButtons, downloadWhatsAppMedia } from '../services/whatsapp.service.js';
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
import { t } from '../i18n/messages.js';

const anthropic = new Anthropic({ apiKey: config.anthropic.apiKey });

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

    // TEMPORARY: confirms end-to-end delivery (Meta -> webhook -> WhatsApp send) while
    // debugging real-number message delivery. Remove once that's confirmed working —
    // fires on every inbound message, stacking on top of the normal flow's own reply.
    await sendWhatsAppMessage(phone, t.botCheck.activeReply());

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
    await sendWhatsAppMessage(phone, t.onboarding.welcome());
    return;
  }

  // If CRM registration (name/NIF/address) is incomplete, process it. Once the customer
  // reaches 'awaiting_vehicle_id', onboarding continues below via the normal vehicle-ID
  // stages (manual collection / VIN / document / confirmation) instead of being
  // re-intercepted here — those stages already implement this logic, don't duplicate it.
  if (customer.registration_status !== 'complete' && customer.registration_status !== 'awaiting_vehicle_id') {
    if (!customerText) return;
    const handled = await processCRMRegistration(phone, customer.registration_status, customerText);
    if (handled) return;
  }

  // 2. PRIORITY: state-aware image routing. While a vehicle ID is pending (onboarding,
  // or an in-progress manual collection), an image is a vehicle document, not a payment
  // proof — must be checked before the payment-proof handler below.
  const activeCollection = await getActiveManualCollection(phone);
  const awaitingVehicleId = customer.registration_status === 'awaiting_vehicle_id' || !!activeCollection;

  if (mediaType === 'image' && mediaId && awaitingVehicleId) {
    await processVehicleDocument(phone, mediaId);
    return;
  }

  // 3. PRIORITY: Customer sent payment proof media (image/document)
  if (mediaType === 'image' || mediaType === 'document') {
    if (mediaId) {
      const handled = await processPaymentProof(phone, mediaId, mediaType);
      if (handled) return;
    }
  }

  if (!customerText) return;

  // 4. PRIORITY: Customer is in active manual vehicle collection flow
  if (activeCollection) {
    const handled = await processManualCollectionStep(phone, activeCollection, customerText, customer);
    if (handled) return;
  }

  // 5. PRIORITY: Alphanumeric 17-char VIN detected
  if (isVIN(customerText)) {
    await processVIN(phone, customerText);
    return;
  }

  // 6. PRIORITY: Customer is confirming/rejecting decoded VIN car
  const confirmedVehicle = await processVehicleConfirmation(phone, customerText, customer);
  if (confirmedVehicle) return;

  // 7. PRIORITY: still onboarding and nothing above matched — treat as "no VIN available",
  // start the deterministic manual collection instead of falling through to the AI agent.
  if (customer.registration_status === 'awaiting_vehicle_id') {
    await startManualCollection(phone, 'awaiting_make');
    await sendWhatsAppMessage(phone, t.manual.askMakePrompt());
    return;
  }

  // 8. PRIORITY: Active payment status waiting for inputs
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

  // 9. Conversational AI agent pipeline
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
    await sendWhatsAppButtons(phone, t.onboarding.askNifBody(name), t.onboarding.askNifButtons);
    return true;
  }

  if (status === 'awaiting_nif') {
    const rLower = r.toLowerCase();
    const noNif = rLower.includes('não') || rLower.includes('nao') || rLower.includes('❌') || rLower.includes('nao obrigado') || r === '2';
    const nif = noNif ? null : r.replace(/\s/g, '').toUpperCase();

    await updateCustomer(phone, { nif, registration_status: 'awaiting_address' });
    await sendWhatsAppMessage(phone, t.onboarding.askAddress());
    return true;
  }

  if (status === 'awaiting_address') {
    const rLower = r.toLowerCase();
    const address = (rLower === 'saltar' || rLower === 'skip') ? null : r;

    await updateCustomer(phone, {
      address,
      registration_status: 'awaiting_vehicle_id',
    });

    const cust = await getCustomerByPhone(phone);
    const name = cust?.name?.split(' ')[0] || 'Cliente';

    await sendWhatsAppMessage(phone, t.onboarding.profileCreatedAskVehicle(name));
    return true;
  }

  return false;
}

/**
 * If the customer reached this vehicle-ID step as part of onboarding (registration
 * was pending on the vehicle, not yet 'complete'), finalizes registration and sends
 * the combined "profile complete" message. Returns true if it did so, so the caller
 * can skip its own lighter-weight "tell me what part you need" message.
 */
async function completeOnboardingIfNeeded(
  phone: string,
  customer: Customer,
  vehicleSummary: string
): Promise<boolean> {
  if (customer.registration_status !== 'awaiting_vehicle_id') return false;

  await updateCustomer(phone, { registration_status: 'complete', registered_at: new Date() });

  const name = customer.name?.split(' ')[0] || 'Cliente';
  await sendWhatsAppMessage(phone, t.onboarding.onboardingComplete(name, vehicleSummary));
  return true;
}

/**
 * Handles manual vehicle information inputs.
 */
async function processManualCollectionStep(
  phone: string,
  collection: any,
  reply: string,
  customer: Customer
): Promise<boolean> {
  const r = reply.trim();

  if (collection.status === 'awaiting_make') {
    const make = capitalize(r);
    await updateManualCollection(phone, { make, status: 'awaiting_model' });
    await sendWhatsAppMessage(phone, t.manual.askModel(make));
    return true;
  }

  if (collection.status === 'awaiting_model') {
    const model = capitalize(r);
    await updateManualCollection(phone, { model, status: 'awaiting_year' });
    await sendWhatsAppMessage(phone, t.manual.askYear(collection.make, model));
    return true;
  }

  if (collection.status === 'awaiting_year') {
    const yearClean = r.replace(/\D/g, '');
    const yearInt = parseInt(yearClean, 10);
    const currentYear = new Date().getFullYear();

    if (!yearClean || yearClean.length !== 4 || yearInt < 1980 || yearInt > currentYear + 1) {
      await sendWhatsAppMessage(phone, t.manual.invalidYear());
      return true;
    }

    await updateManualCollection(phone, { year: yearClean, status: 'awaiting_engine_number' });
    await sendWhatsAppMessage(phone, t.manual.askEngineNumber(collection.make, collection.model, yearClean));
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
      engineNumber ? t.manual.engineLabel(engineNumber) : null,
    ].filter(Boolean).join('\n');

    const completedOnboarding = await completeOnboardingIfNeeded(phone, customer, summary);
    if (!completedOnboarding) {
      await sendWhatsAppMessage(phone, t.manual.collectionComplete(summary));
    }
    return true;
  }

  return false;
}

/**
 * Handles incoming VIN number parsing.
 */
async function processVIN(phone: string, vin: string): Promise<void> {
  const vinClean = vin.trim().toUpperCase();

  await sendWhatsAppMessage(phone, t.vin.identifying());

  const vehicle = await decodeVIN(vinClean);

  if (!vehicle) {
    // If API lookup fails, fallback to step-by-step manual inputs
    await startManualCollection(phone, 'awaiting_make', vinClean);
    await sendWhatsAppMessage(phone, t.vin.decodeFailed());
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

  await sendWhatsAppButtons(phone, t.vin.confirmBody(description), t.vin.confirmButtons);
}

/**
 * Handles a photo of the vehicle's registration document (livrete / Título do Veículo)
 * sent while a vehicle ID is pending. Extracts data via Claude Vision, cross-checks any
 * legible VIN against the free NHTSA API (more authoritative than OCR when available),
 * and hands off to the same Sim/Não confirmation flow processVIN uses.
 */
async function processVehicleDocument(phone: string, mediaId: string): Promise<void> {
  await sendWhatsAppMessage(phone, t.document.received());

  const imageBase64 = await downloadWhatsAppMedia(mediaId);
  if (!imageBase64) {
    await sendWhatsAppMessage(phone, t.document.downloadFailed());
    return;
  }

  let extracted: VisionData | null;
  try {
    extracted = await extractDataWithClaudeVision(imageBase64);
  } catch (error: any) {
    logger.error(`[VISION] Error processing document for ${phone}: ${error.message}`);
    await sendWhatsAppMessage(phone, t.document.processingError());
    return;
  }

  if (!extracted) {
    await sendWhatsAppMessage(phone, t.document.notRecognized());
    return;
  }

  if (!extracted.valid) {
    await sendWhatsAppMessage(phone, t.document.invalid(extracted.reason || t.document.defaultInvalidReason));
    return;
  }

  // Prefer the authoritative NHTSA decode over OCR when a legible VIN was read
  let make = extracted.make || null;
  let model = extracted.model || null;
  let year = extracted.year || null;
  let fuelType = extracted.fuel_type || null;
  let engineSize = extracted.engine_size || null;

  if (extracted.chassis_number && isVIN(extracted.chassis_number)) {
    const decoded = await decodeVIN(extracted.chassis_number.toUpperCase());
    if (decoded) {
      make = decoded.make;
      model = decoded.model;
      year = decoded.year;
      fuelType = decoded.fuel_type;
      engineSize = decoded.engine;
    }
  }

  if (!make || !model) {
    await sendWhatsAppMessage(phone, t.document.missingEssentialData());
    return;
  }

  await saveVehicleSession(phone, {
    vin: extracted.chassis_number || null,
    make,
    model,
    year: year || null,
    fuel_type: fuelType,
    engine_size: engineSize,
    engine_number: extracted.engine_number || null,
    license_plate: extracted.license_plate || null,
  });

  const description = [
    `${make} ${model}${year ? ` ${year}` : ''}`,
    engineSize || null,
    fuelType || null,
    extracted.license_plate ? t.document.licensePlateLabel(extracted.license_plate) : null,
  ].filter(Boolean).join(' · ');

  await sendWhatsAppButtons(phone, t.document.confirmBody(description), t.vin.confirmButtons);
}

/**
 * Processes vehicle quick confirmation buttons.
 */
async function processVehicleConfirmation(phone: string, reply: string, customer: Customer): Promise<boolean> {
  const r = reply.toLowerCase();

  if (r.includes('sim') || r.includes('yes') || r.includes('✅') || r === '1' || r.includes('btn_0')) {
    const v = await getCustomerVehicle(phone);
    if (!v) return false;

    const summary = `🚗 *${v.make} ${v.model} ${v.year}*`;
    const completedOnboarding = await completeOnboardingIfNeeded(phone, customer, summary);
    if (!completedOnboarding) {
      await sendWhatsAppMessage(phone, t.vehicleConfirm.confirmedAskPart(v.make, v.model, v.year));
    }
    return true;
  }

  if (r.includes('não') || r.includes('nao') || r.includes('❌') || r === '2' || r.includes('btn_1')) {
    await clearVehicleSession(phone);

    if (customer.registration_status === 'awaiting_vehicle_id') {
      await startManualCollection(phone, 'awaiting_make');
      await sendWhatsAppMessage(phone, t.manual.askMakePrompt());
    } else {
      await sendWhatsAppMessage(phone, t.vehicleConfirm.rejectedFreeText());
    }
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
    system: t.systemPrompt,
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
      await sendWhatsAppMessage(phone, t.agent.checkingStock());

      const options = await searchProductsInInventory({
        part: action.part,
        vehicle_make: action.vehicle_make,
        model: action.model,
        year: action.year,
      });

      if (!options || options.length === 0) {
        const msg = t.agent.noStockFound();
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
        await sendWhatsAppMessage(phone, t.agent.optionNotFound());
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

      const confirmation = t.agent.proformaSentChoosePayment();
      history.push({ role: 'assistant', content: confirmation });
      break;
    }

    case 'transfer_to_human': {
      const msg = t.agent.transferToHuman();
      await sendWhatsAppMessage(phone, msg);
      logger.info(`[SUPPORT] Customer ${phone} requested human support. Reason: ${action.reason}`);
      break;
    }

    default:
      logger.warn('Unknown structured action from AI agent', action);
  }
}

function formatSearchOptions(options: Product[], action: any): string {
  const numberEmojis = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣'];
  const top5 = options.slice(0, 5);

  let msg = t.agent.searchHeader(top5.length, action.part, action.vehicle_make, action.model, action.year);

  top5.forEach((item, i) => {
    msg += t.agent.searchItem({
      emoji: numberEmojis[i],
      name: item.name,
      reference: item.reference,
      price: formatPrice(item.price),
      quantity: item.quantity,
      deliveryTime: item.delivery_time,
      supplier: item.supplier,
    });
  });

  msg += t.agent.searchFooter();
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
