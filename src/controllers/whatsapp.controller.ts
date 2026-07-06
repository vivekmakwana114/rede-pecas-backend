import { Request, Response } from 'express';
import { logger } from '../config/logger.js';
import * as customerService from '../services/customer.service.js';
import * as vehicleService from '../services/vehicle.service.js';
import * as productService from '../services/product.service.js';
import * as aiService from '../services/ai.service.js';
import * as paymentService from '../services/payment.service.js';
import * as sessionService from '../services/session.service.js';
import { sendWhatsAppMessage, sendWhatsAppButtons } from '../services/whatsapp.service.js';
import { config } from '../config/config.js';
import { t } from '../i18n/messages.js';

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
    // Quick-reply button taps arrive as type "interactive" (button_reply.title/id) or,
    // for legacy template buttons, type "button" (button.text) — neither is msg.text,
    // so without this every button flow (VIN confirm, payment method, etc.) would see
    // customerText as null and silently drop the customer's tap.
    const customerText =
      msg.type === 'text' ? msg.text?.body :
      msg.type === 'interactive' ? msg.interactive?.button_reply?.title :
      msg.type === 'button' ? msg.button?.text :
      null;
    const mediaType = msg.type; // "image" | "document" | "text" | "interactive" | "button" etc.
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
  // 1. Get-or-create customer (handles pre-registration + welcome on first contact)
  const customer = await customerService.getOrCreateCustomer(phone);
  if (!customer) return;

  // 2. Session-freshness check: has this number been active in the last 4h? Touched
  // unconditionally on every message so the *next* message is treated as a live answer.
  // Drives two things: greeting a returning customer once, and — for a customer stuck
  // mid-registration — re-showing the pending question instead of silently consuming
  // this message as its answer (e.g. "Hi" getting saved as their name after a long gap).
  const freshSession = await sessionService.isNewSession(phone);
  await sessionService.markSessionActive(phone);

  if (freshSession && customer.registration_status === 'complete') {
    const firstName = customer.name?.split(' ')[0] || 'Cliente';
    await sendWhatsAppMessage(phone, t.onboarding.welcomeBack(firstName));
  }

  if (freshSession && customer.registration_status === 'awaiting_vehicle_id') {
    // An active manual-collection sub-flow can't coexist with freshSession === true (that
    // sub-flow has its own 30-min activity window, well inside this 4h session TTL), so
    // it's safe to just re-show the vehicle-ID choice instead of guessing from this message.
    const firstName = customer.name?.split(' ')[0] || 'Cliente';
    await sendWhatsAppButtons(phone, t.onboarding.askVehicleIdBody(firstName), t.onboarding.askVehicleIdButtons);
    return;
  }

  if (freshSession && customer.registration_status !== 'complete' && customer.registration_status !== 'awaiting_vehicle_id') {
    await customerService.sendResumeRegistrationPrompt(phone, customer);
    return;
  }

  // 3. If CRM registration (name/NIF/address) is incomplete, process it. Once the customer
  // reaches 'awaiting_vehicle_id', onboarding continues below via the normal vehicle-ID
  // stages (manual collection / VIN / document / confirmation) instead of being
  // re-intercepted here — those stages already implement this logic, don't duplicate it.
  if (customer.registration_status !== 'complete' && customer.registration_status !== 'awaiting_vehicle_id') {
    if (!customerText) return;
    const handled = await customerService.processCRMRegistration(phone, customer.registration_status, customerText);
    if (handled) return;
  }

  // 4. PRIORITY: vehicle-ID option button tap (VIN / photo / manual), shown right after
  // onboarding completes. Must run before manual collection starts, so tapping "VIN" or
  // "photo" doesn't fall through to the generic fallback below and start a manual collection.
  const activeCollection = await vehicleService.getActiveManualCollection(phone);
  if (customer.registration_status === 'awaiting_vehicle_id' && !activeCollection && customerText) {
    const handled = await vehicleService.processVehicleIdOptionChoice(phone, customerText);
    if (handled) return;
  }

  // 5. PRIORITY: state-aware image routing. While a vehicle ID is pending (onboarding,
  // or an in-progress manual collection), an image is a vehicle document, not a payment
  // proof — must be checked before the payment-proof handler below.
  const awaitingVehicleId = customer.registration_status === 'awaiting_vehicle_id' || !!activeCollection;

  if (mediaType === 'image' && mediaId && awaitingVehicleId) {
    await vehicleService.processVehicleDocument(phone, mediaId);
    return;
  }

  // 6. PRIORITY: Customer sent payment proof media (image/document)
  if (mediaType === 'image' || mediaType === 'document') {
    if (mediaId) {
      const handled = await paymentService.processPaymentProof(phone, mediaId, mediaType);
      if (handled) return;
    }
  }

  if (!customerText) return;

  // 7. PRIORITY: Customer is in active manual vehicle collection flow
  if (activeCollection) {
    const handled = await vehicleService.processManualCollectionStep(phone, activeCollection, customerText, customer);
    if (handled) return;
  }

  // 8. PRIORITY: Alphanumeric 17-char VIN detected
  if (vehicleService.isVIN(customerText)) {
    await vehicleService.processVIN(phone, customerText);
    return;
  }

  // 8.5 PRIORITY: pending waitlist opt-in reply ("sim"/"não" after a no-stock message).
  // Must run before step 9 — processVehicleConfirmation treats any "sim"/"não"-shaped
  // reply as a vehicle (re)confirmation whenever a vehicle session is active, which
  // would otherwise silently swallow a waitlist yes/no reply (a common case, since most
  // customers mid-conversation already have a confirmed vehicle).
  const pendingWaitlistOffer = await sessionService.getPendingWaitlistOffer(phone);
  if (pendingWaitlistOffer) {
    const handled = await productService.processWaitlistOptIn(phone, customerText, pendingWaitlistOffer);
    if (handled) return;
  }

  // 9. PRIORITY: Customer is confirming/rejecting decoded VIN car
  const confirmedVehicle = await vehicleService.processVehicleConfirmation(phone, customerText, customer);
  if (confirmedVehicle) return;

  // 10. PRIORITY: still onboarding and nothing above matched — treat as "no VIN available",
  // start the deterministic manual collection instead of falling through to the AI agent.
  if (customer.registration_status === 'awaiting_vehicle_id') {
    await vehicleService.startManualCollection(phone, 'awaiting_make');
    await sendWhatsAppMessage(phone, t.manual.askMakePrompt());
    return;
  }

  // 11. PRIORITY: Active payment status waiting for inputs
  const latestOrder = await paymentService.getPendingPaymentOrder(phone);

  if (latestOrder) {
    const handled = latestOrder.status === 'awaiting_payment_method'
      ? await paymentService.processMethodChoice(phone, customerText)
      : await paymentService.processMethodSubtype(phone, customerText);
    if (handled) return;
  }

  // 12. Conversational AI agent pipeline
  await aiService.processAIConversation(phone, customerText);
}
