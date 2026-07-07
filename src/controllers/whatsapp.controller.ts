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

// Bare greetings (PT/EN) never reach the AI, even once it's already been invited to
// answer this session — they must always get the deterministic "what part do you need"
// prompt instead, so a stray "Hi"/"Hey" after an AI failure doesn't retrigger it.
const GREETING_PATTERN = /^(oi|ol[aá]|e\s*a[ií]|bom\s*dia|boa\s*tarde|boa\s*noite|hi|hello|hey+|yo)\b/i;

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

  // Customer profile registration (name/NIF/address) and vehicle identification are
  // independent state machines with their own status: registration_status covers the
  // profile only; needsVehicleId is computed straight from the `vehicles` table (no row,
  // or no valid confirmed row, and no in-progress manual-entry wizard). Whichever is
  // missing is what the bot asks for next — a returning customer whose vehicle session
  // simply expired gets sent back into the vehicle-ID flow without re-doing their profile.
  const activeCollection = await vehicleService.getActiveManualCollection(phone);
  const needsVehicleId = customer.registration_status === 'complete' && !activeCollection
    ? !(await vehicleService.hasVehicleOnFile(phone))
    : false;

  if (freshSession && customer.registration_status === 'complete' && !needsVehicleId) {
    // Deterministic greeting + "what do you need" prompt — no AI call here. The
    // customer's vehicle/profile is already known; Claude is only invoked once
    // they actually state a part need after being asked (see step 12 below), not
    // for the bare greeting.
    // Skipped when media is attached: a stale-session resume can be the customer's
    // payment-proof photo, which must still reach processPaymentProof below rather
    // than being swallowed by this short-circuit.
    const firstName = customer.name?.split(' ')[0] || 'Cliente';
    await sendWhatsAppMessage(phone, t.onboarding.welcomeBack(firstName));
    if (!mediaId) {
      const askedPart = await vehicleService.sendAskPartPrompt(phone);
      if (askedPart) return;
    }
  }

  if (freshSession && needsVehicleId) {
    // An active manual-collection sub-flow can't coexist with freshSession === true (that
    // sub-flow has its own 30-min activity window, well inside this 4h session TTL), so
    // it's safe to just re-show the vehicle-ID choice instead of guessing from this message.
    const firstName = customer.name?.split(' ')[0] || 'Cliente';
    await sendWhatsAppButtons(phone, t.onboarding.askVehicleIdBody(firstName), t.onboarding.askVehicleIdButtons);
    return;
  }

  if (freshSession && customer.registration_status !== 'complete') {
    await customerService.sendResumeRegistrationPrompt(phone, customer);
    return;
  }

  // 3. If profile registration (name/NIF/address) is incomplete, process it. Once the
  // profile reaches 'complete', onboarding continues below via the vehicle-ID stages
  // (manual collection / VIN / document / confirmation) instead of being re-intercepted
  // here — those stages already implement this logic, don't duplicate it.
  if (customer.registration_status !== 'complete') {
    if (!customerText) return;
    const handled = await customerService.processCustomerRegistration(phone, customer.registration_status, customerText);
    if (handled) return;
  }

  // 3.5 PRIORITY: explicit "add another vehicle" request (the button always offered
  // alongside the ask-part prompt, or the same phrase typed free-text). Only relevant
  // once the customer already has at least one vehicle — if they don't yet, they're
  // already in the normal vehicle-ID flow via needsVehicleId below.
  if (!needsVehicleId && customerText && vehicleService.isAddVehicleRequest(customerText)) {
    await vehicleService.startAddVehicleFlow(phone);
    return;
  }

  // 4. PRIORITY: vehicle-ID option button tap (VIN / photo / manual), shown right after
  // profile registration completes, a returning customer's vehicle session expired, or
  // an "add another vehicle" request just above. Must run before manual collection
  // starts, so tapping "VIN" or "photo" doesn't fall through to the generic fallback
  // below and start a manual collection.
  const vehicleIdChoiceShown = await sessionService.wasVehicleIdChoiceShown(phone);

  if ((needsVehicleId || vehicleIdChoiceShown) && customerText) {
    const handled = await vehicleService.processVehicleIdOptionChoice(phone, customerText);
    if (handled) return;
  }

  // 5. PRIORITY: state-aware image routing. While a vehicle ID is pending (missing, an
  // in-progress manual collection, or the choice buttons were just shown — including
  // via "add another vehicle"), an image is a vehicle document, not a payment proof —
  // must be checked before the payment-proof handler below.
  const awaitingVehicleId = needsVehicleId || !!activeCollection || vehicleIdChoiceShown;

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

  // 8.3 PRIORITY: pending "which vehicle is this for?" reply (customers with 2+
  // vehicles, shown by sendAskPartPrompt before inviting a part search). Must run
  // before the waitlist/confirmation checks below, which also interpret short
  // numeric/yes-no replies.
  const vehicleChoiceHandled = await vehicleService.resolvePendingVehicleChoice(phone, customerText);
  if (vehicleChoiceHandled) return;

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

  // 10. PRIORITY: vehicle ID still missing and nothing above matched — treat as "no VIN
  // available", start the deterministic manual collection instead of falling through to
  // the AI agent.
  if (needsVehicleId) {
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

  // 12. PRIORITY: only call the AI once the customer has actually been asked "what part
  // do you need" this session (via onboarding/manual-collection completion, vehicle
  // confirmation, or sendAskPartPrompt above) — never as the first response to a stray
  // message. A bare greeting always gets re-prompted deterministically too, even if
  // they were already invited — otherwise a later "Hi"/"Hey" would be sent to the AI
  // as if it were a product name.
  const invitedToAskForPart = await sessionService.wasPartPromptSent(phone);
  if (!invitedToAskForPart || GREETING_PATTERN.test(customerText.trim())) {
    const asked = await vehicleService.sendAskPartPrompt(phone);
    if (asked) return;
  }

  // 13. Conversational AI agent pipeline
  await aiService.processAIConversation(phone, customerText);
}
