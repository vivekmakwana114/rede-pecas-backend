import { Request, Response } from 'express';
import { logger } from '../config/logger.js';
import * as customerService from '../services/customer.service.js';
import * as vehicleService from '../services/vehicle.service.js';
import * as productService from '../services/product.service.js';
import * as paymentService from '../services/payment.service.js';
import * as sessionService from '../services/session.service.js';
import { sendWhatsAppMessage, sendWhatsAppButtons } from '../services/whatsapp.service.js';
import { config } from '../config/config.js';
import { t } from '../i18n/messages.js';

// Bare greetings (PT/EN) never get treated as a part search, even once the customer's
// already been invited to state one this session — they must always get the
// deterministic "what part do you need" prompt instead, so a stray "Hi"/"Hey" doesn't
// get sent into a nonsensical inventory search.
const GREETING_PATTERN = /^(oi|ol[aá]|e\s*a[ií]|bom\s*dia|boa\s*tarde|boa\s*noite|hi|hello|hey+|yo)\b/i;

// Deterministic keyword trigger for reaching a human — there's no conversational AI left
// to infer this from tone/intent, so it's a plain keyword match (PT/EN).
const HUMAN_HANDOFF_PATTERN = /\b(atendente|humano|falar com (algu[eé]m|pessoa)|operador|suporte humano|human|agent|representative)\b/i;

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
    // customerText as null and silently drop the customer's tap. A list-message row tap
    // is also type "interactive", under list_reply instead of button_reply.
    const customerText =
      msg.type === 'text' ? msg.text?.body :
      msg.type === 'interactive' ? (msg.interactive?.button_reply?.title || msg.interactive?.list_reply?.title) :
      msg.type === 'button' ? msg.button?.text :
      null;
    // The list row's stable id (e.g. "option_2") — used instead of its (possibly
    // truncated) title to resolve a product-list tap unambiguously.
    const listReplyId: string | null = msg.type === 'interactive' ? (msg.interactive?.list_reply?.id || null) : null;
    const mediaType = msg.type; // "image" | "document" | "text" | "interactive" | "button" etc.
    const mediaId = msg.image?.id || msg.document?.id || null;

    logger.debug(`[${phone}] Webhook type: ${mediaType}, text: ${customerText}`);

    await processMessageFlow(phone, customerText, mediaType, mediaId, listReplyId);
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
  mediaId: string | null,
  listReplyId: string | null = null
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
    // Confirmed vehicles never expire (see vehicle.model.ts), so reaching this branch means
    // the customer genuinely has no vehicle on file yet — never reuse askVehicleIdBody here,
    // its "profile created" copy is only accurate right after registration completes.
    const firstName = customer.name?.split(' ')[0] || 'Cliente';
    await sendWhatsAppButtons(phone, t.onboarding.resumeVehicleIdBody(firstName), t.onboarding.askVehicleIdButtons);
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
    const handled = await customerService.processCustomerRegistration(phone, customer, customerText);
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

  // 3.6 PRIORITY: pending "try again" / "manual entry" reply after a document processing
  // failure. Must run before stage 4 below — vehicleIdChoiceShown (set once, when the
  // original VIN/photo/manual choice was first shown) is never cleared while this more
  // specific retry prompt is active, so without this ordering a reply like "Manual entry"
  // would get wrongly intercepted by stage 4's generic 3-button handler instead of this
  // dedicated one — same outcome for "manual", but silently wrong for "try again"
  // (stage 4 doesn't recognize it and falls through, eventually landing in stage 10's
  // catch-all, which also starts manual collection instead of re-prompting for a photo).
  const documentRetryChoiceShown = await sessionService.wasDocumentRetryChoiceShown(phone);
  if (documentRetryChoiceShown && customerText) {
    const handled = await vehicleService.processDocumentRetryChoice(phone, customerText);
    if (handled) return;
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
      const proofFirstName = customer.name?.split(' ')[0] || 'Cliente';
      const handled = await paymentService.processPaymentProof(phone, mediaId, mediaType, proofFirstName);
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

  // 8.4 PRIORITY: pending "this vehicle is already in your profile — search for a
  // part, or add a different vehicle?" choice (VIN dedup check in processVIN). Same
  // reasoning as 8.3 above — a "1"/"2" reply must resolve here before stage 9's
  // sim/não catch-all would otherwise treat it as a vehicle (re)confirmation.
  const vinDuplicateChoiceShown = await sessionService.wasVinDuplicateChoiceShown(phone);
  if (vinDuplicateChoiceShown) {
    const handled = await vehicleService.processVinDuplicateChoice(phone, customerText);
    if (handled) return;
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

  // 8.6 PRIORITY: pending service-offer opt-in reply ("sim"/"não" after picking a
  // product that has an attached service). Same reasoning as 8.5 above — must run
  // before stage 9's vehicle-confirmation sim/não catch-all would otherwise swallow it.
  const pendingServiceOffer = await sessionService.getPendingServiceOffer(phone);
  if (pendingServiceOffer) {
    const handled = await productService.processServiceOptIn(phone, customerText, pendingServiceOffer);
    if (handled) return;
  }

  // 8.7 PRIORITY: pending "stock unavailable — want alternatives or the waitlist?"
  // reply (admin marked an order's stock unavailable via the admin panel). Same
  // reasoning as 8.5/8.6 above.
  const pendingStockUnavailableOffer = await sessionService.getPendingStockUnavailableOffer(phone);
  if (pendingStockUnavailableOffer) {
    const stockUnavailableFirstName = customer.name?.split(' ')[0] || 'Cliente';
    const handled = await productService.processStockUnavailableChoice(phone, customerText, pendingStockUnavailableOffer, stockUnavailableFirstName);
    if (handled) return;
  }

  // 8.8 PRIORITY: pending "your waitlisted product is back in stock — order
  // now?" reply. Same reasoning as 8.5/8.6/8.7 above.
  const pendingRestockOrderOffer = await sessionService.getPendingRestockOrderOffer(phone);
  if (pendingRestockOrderOffer) {
    const handled = await productService.processRestockOrderChoice(phone, customerText, pendingRestockOrderOffer);
    if (handled) return;
  }

  // 8.9 PRIORITY: pending "payment proof unclear, try again" reply. The order stays in
  // awaiting_payment_proof so a new photo/PDF is already caught unconditionally by stage
  // 6 above regardless of this flag — this only exists to stop the "Try again" button tap
  // itself (which arrives as text, not media) from falling through to an unrelated stage
  // (e.g. product search) instead of just re-showing the same upload prompt.
  const pendingPaymentProofRetry = await sessionService.wasPaymentProofRetryShown(phone);
  if (pendingPaymentProofRetry) {
    const handled = await paymentService.processPaymentProofRetryChoice(phone);
    if (handled) return;
  }

  // 9. PRIORITY: Customer is confirming/rejecting decoded VIN car
  const confirmedVehicle = await vehicleService.processVehicleConfirmation(phone, customerText, customer);
  if (confirmedVehicle) return;

  // 10. PRIORITY: vehicle ID still missing, OR the VIN/photo/manual choice was just
  // shown (including via "add another vehicle" — a customer already has a confirmed
  // vehicle then, so needsVehicleId alone is false), and nothing above matched — treat
  // as "no VIN available", start the deterministic manual collection instead of falling
  // through to product search with whatever text they sent (e.g. a mistyped/partial
  // VIN or a license plate, which isn't a valid 17-char VIN and isn't a part name either).
  if (needsVehicleId || vehicleIdChoiceShown) {
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

  // 12. PRIORITY: only treat free text as a part search once the customer has actually
  // been asked "what part do you need" this session (via onboarding/manual-collection
  // completion, vehicle confirmation, or sendAskPartPrompt above) — never as the first
  // response to a stray message. A bare greeting always gets re-prompted deterministically
  // too, even if they were already invited — otherwise a later "Hi"/"Hey" would be searched
  // as if it were a product name.
  const invitedToAskForPart = await sessionService.wasPartPromptSent(phone);
  const isGreeting = GREETING_PATTERN.test(customerText.trim());
  if (!invitedToAskForPart || isGreeting) {
    // A bare greeting mid-conversation gets the warmer "Hey {name}! Good to have you
    // back" wording (matches the doc's Stage 08), not the "Perfect!" tone meant for
    // right after confirming a vehicle — nothing was actually just confirmed here.
    const greeting = isGreeting ? { name: customer.name?.split(' ')[0] || 'Cliente' } : undefined;
    const asked = await vehicleService.sendAskPartPrompt(phone, greeting);
    if (asked) return;
  }

  // 13. PRIORITY: reply to a just-shown product list (row tap or typed 1/2/3) — must run
  // before the human-handoff/search fallback below, which would otherwise treat a stray
  // "2" as a new (nonsensical) search query. Not selection-shaped (e.g. a new part name
  // typed instead) falls through to a fresh search below rather than a dead end.
  const pendingProductOptions = await sessionService.getPendingOptions(phone);
  if (pendingProductOptions) {
    const handled = await productService.processProductSelection(phone, customerText, listReplyId, pendingProductOptions);
    if (handled) return;
  }

  // 14. Explicit request to talk to a human — deterministic keyword match. There's no
  // conversational AI left to infer this from tone/intent, so it only fires on an
  // exact keyword hit.
  if (HUMAN_HANDOFF_PATTERN.test(customerText)) {
    await sendWhatsAppMessage(phone, t.agent.transferToHuman());
    logger.info(`[SUPPORT] Customer ${phone} requested human support.`);
    return;
  }

  // 15. Deterministic product search — full-text match against the inventory DB (already
  // handles PT synonyms/typos via the 'portuguese' tsquery config). No AI involved.
  const searchFirstName = customer.name?.split(' ')[0] || 'Cliente';
  await productService.searchAndRespond(phone, customerText, searchFirstName);
}
