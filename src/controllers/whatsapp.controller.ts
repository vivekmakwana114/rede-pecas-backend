import { Request, Response } from 'express';
import { logger } from '../config/logger.js';
import * as customerService from '../services/customer.service.js';
import * as vehicleService from '../services/vehicle.service.js';
import * as productService from '../services/product.service.js';
import * as paymentService from '../services/payment.service.js';
import * as sessionService from '../services/session.service.js';
import { sendWhatsAppMessage, sendWhatsAppButtons } from '../services/whatsapp.service.js';
import { getAdminByPhone } from '../models/adminUser.model.js';
import { config } from '../config/config.js';
import { GREETING_PATTERN, detectMessageLocale } from '../utils/greeting.js';

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
    // A button reply's stable id (e.g. "admin_confirm_RP-2026-00482") — unlike
    // every other button flow in this app (title-matched), the admin's stock
    // confirm/decline buttons encode the order number directly in the id so the
    // reply can be resolved unambiguously regardless of how many are pending.
    const buttonReplyId: string | null = msg.type === 'interactive' ? (msg.interactive?.button_reply?.id || null) : null;
    const mediaType = msg.type; // "image" | "document" | "text" | "interactive" | "button" etc.
    const mediaId = msg.image?.id || msg.document?.id || null;

    logger.debug(`[${phone}] Webhook type: ${mediaType}, text: ${customerText}`);

    await processMessageFlow(phone, customerText, mediaType, mediaId, listReplyId, buttonReplyId);
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
  listReplyId: string | null = null,
  buttonReplyId: string | null = null
): Promise<void> {
  // 0. Admin short-circuit: a message from a number in admin_users is never a
  // customer, so this must run before getOrCreateCustomer below — otherwise
  // the admin's own number would get a customers row created and run through
  // the entire customer pipeline like anyone else. Routes by the button reply
  // id's prefix to whichever admin-action handler owns it — stock
  // confirm/unavailable (processAdminStockReply) or payment approve/reject
  // (processAdminPaymentReply, admin_(approve|reject)_payment_<order>) —
  // falling back to the stock handler for anything else so an admin who
  // sends free text still gets its "use the buttons" nudge.
  const admin = await getAdminByPhone(phone);
  if (admin) {
    logger.debug(`[ADMIN] Inbound message from admin ${phone} (${admin.name}) routed to admin handler, buttonReplyId=${buttonReplyId}`);
    if (buttonReplyId?.startsWith('admin_approve_payment_') || buttonReplyId?.startsWith('admin_reject_payment_')) {
      await paymentService.processAdminPaymentReply(phone, buttonReplyId);
    } else {
      await productService.processAdminStockReply(phone, buttonReplyId);
    }
    return;
  }

  // 1. Detect this message's language and cache it for the session (see
  // detectMessageLocale in utils/greeting.ts and saveLocale/getLocale in
  // session.service.ts) *before* any reply is built below — including the
  // brand-new-customer welcome message in getOrCreateCustomer, which reads
  // this same cached value. A message with no recognizable PT/EN signal
  // (e.g. a VIN, a bare digit, a button tap with an ambiguous title) leaves
  // whatever locale was already cached untouched, so a customer switches
  // language mid-conversation only when they actually type in the other one.
  if (customerText) {
    const detected = detectMessageLocale(customerText);
    if (detected) await sessionService.saveLocale(phone, detected);
  }

  // 1.1 Get-or-create customer (handles pre-registration + welcome on first contact)
  const customer = await customerService.getOrCreateCustomer(phone);
  if (!customer) return;

  // Every customer-facing send below resolves messages via this instead of the
  // fixed `t` import — see resolveMessages/resolveLocale in customer.service.ts.
  const messages = await customerService.resolveMessages(phone);

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
    await sendWhatsAppMessage(phone, messages.onboarding.welcomeBack(firstName));
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
    await sendWhatsAppButtons(phone, messages.onboarding.resumeVehicleIdBody(firstName), messages.onboarding.askVehicleIdButtons);
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

  // 3.7 PRIORITY: pending "try again" / "manual entry" reply after a VIN failed to
  // decode (processVIN's NHTSA lookup came back empty). Same reasoning as 3.6 above —
  // must run before stage 4, which would otherwise misroute "Manual" here too, and
  // before this used to auto-start manual collection with no choice at all.
  const vinDecodeFailedChoiceShown = await sessionService.wasVinDecodeFailedShown(phone);
  if (vinDecodeFailedChoiceShown && customerText) {
    const handled = await vehicleService.processVinDecodeFailedChoice(phone, customerText);
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

  // 9. PRIORITY: Customer is confirming/rejecting decoded VIN car
  const confirmedVehicle = await vehicleService.processVehicleConfirmation(phone, customerText, customer);
  if (confirmedVehicle) return;

  // 10. PRIORITY: vehicle ID still missing, OR the VIN/photo/manual choice was just
  // shown (including via "add another vehicle" — a customer already has a confirmed
  // vehicle then, so needsVehicleId alone is false), and nothing above matched — treat
  // as "no VIN available", start the deterministic manual collection instead of falling
  // through to product search with whatever text they sent (e.g. a mistyped/partial
  // VIN or a license plate, which isn't a valid 17-char VIN and isn't a part name either).
  //
  // A bare greeting must never be swallowed as that "no VIN available" text — vehicleIdChoiceShown
  // stays true for up to 4h (VEHICLE_ID_CHOICE_TTL), so a customer who saw the "add another
  // vehicle" choice buttons, didn't tap one, and just says "hi" later was silently becoming a
  // fresh manual-collection row seeded with "Hi" as the make. Re-show whichever prompt actually
  // applies instead: the vehicle-ID choice buttons if a vehicle is genuinely still missing, or —
  // if the customer already has one and vehicleIdChoiceShown alone is why this fired — clear the
  // lapsed flag and let stage 12 below treat it as an ordinary greeting.
  if (needsVehicleId || vehicleIdChoiceShown) {
    if (GREETING_PATTERN.test(customerText.trim())) {
      if (needsVehicleId) {
        const firstName = customer.name?.split(' ')[0] || 'Cliente';
        await sendWhatsAppButtons(phone, messages.onboarding.resumeVehicleIdBody(firstName), messages.onboarding.askVehicleIdButtons);
        return;
      }
      await sessionService.clearVehicleIdChoiceShown(phone);
    } else {
      // Neither a VIN, an active manual-collection reply, nor a greeting — the
      // customer's text didn't match anything we understand while a vehicle ID
      // is still outstanding. Re-show the same VIN/photo/manual choice instead
      // of silently starting manual collection with whatever they typed (that
      // used to swallow typos, stray questions, or a garbled VIN attempt as if
      // the customer had asked for manual entry). A near-miss VIN (wrong
      // length — a dropped/extra character from a typo or copy-paste) gets
      // specific feedback instead of the generic nudge, since the customer did
      // try to give a VIN, just not a valid one.
      const trimmed = customerText.trim();
      const body = vehicleService.looksLikeVinAttempt(trimmed)
        ? messages.vin.invalidLength(trimmed.length)
        : messages.common.notUnderstood();
      await sendWhatsAppButtons(phone, body, messages.onboarding.askVehicleIdButtons);
      await sessionService.markVehicleIdChoiceShown(phone); // refresh the TTL so the choice stays open
      return;
    }
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
    await sendWhatsAppMessage(phone, messages.agent.transferToHuman());
    logger.info(`[SUPPORT] Customer ${phone} requested human support.`);
    return;
  }

  // 15. Deterministic product search — full-text match against the inventory DB (already
  // handles synonyms/typos via the 'english' tsquery config, for now — see CLAUDE.md
  // "Language split"). No AI involved.
  const searchFirstName = customer.name?.split(' ')[0] || 'Cliente';
  await productService.searchAndRespond(phone, customerText, searchFirstName);
}
