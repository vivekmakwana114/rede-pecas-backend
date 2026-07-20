import { logger } from '../config/logger.js';
import { config } from '../config/config.js';
import { capitalize } from '../utils/helpers.js';
import {
  getCustomerVehicles,
  getMostRecentVehicle,
  saveVehicleSession,
  clearVehicleSession,
  getActiveManualCollection,
  updateManualCollection,
  startManualCollection,
  getNhtsaVehicle,
  saveNhtsaVehicle,
} from '../models/vehicle.model.js';
import { sendWhatsAppMessage, sendWhatsAppButtons, downloadWhatsAppMedia } from './whatsapp.service.js';
import { extractDataWithClaudeVision, VisionData } from './ai.service.js';
import { completeOnboardingIfNeeded, resolveMessages, Customer } from './customer.service.js';
import {
  markPartPromptSent,
  savePendingVehicleChoice,
  getPendingVehicleChoice,
  clearPendingVehicleChoice,
  saveChosenVehicle,
  markVehicleIdChoiceShown,
  clearVehicleIdChoiceShown,
  markVinDuplicateChoiceShown,
  clearVinDuplicateChoice,
  markDocumentRetryChoiceShown,
  clearDocumentRetryChoice,
  markVehicleConfirmShown,
  wasVehicleConfirmShown,
  clearVehicleConfirmShown,
  markVinDecodeFailedShown,
  getVinDecodeFailedVin,
  clearVinDecodeFailedChoice,
} from './session.service.js';

// Pure pass-through so the controller never imports vehicle.model.js directly
export { getActiveManualCollection, startManualCollection };

/**
 * Sends the deterministic "what part do you need" prompt for a customer whose
 * vehicle(s) are already confirmed — reused for returning customers so a bare
 * greeting doesn't need an AI call. With one vehicle on file, asks directly; with
 * several, asks which one first (see resolvePendingVehicleChoice) before inviting
 * a part search — ai.service.ts picks up the resolved choice via getChosenVehicle.
 *
 * `greeting` is set when this fires in response to a bare "Hi"/"Hey" mid-conversation
 * (whatsapp.controller.ts stage 12) rather than right after confirming a vehicle —
 * the doc gives that case its own warmer, name-personalized wording (confirmedAskPart's
 * optional greetingName param) instead of its default "Perfect! Now tell me..." tone,
 * which reads oddly as a response to a stray greeting since nothing was actually just
 * confirmed.
 */
export async function sendAskPartPrompt(phone: string, greeting?: { name: string }): Promise<boolean> {
  const messages = await resolveMessages(phone);
  const vehicles = await getCustomerVehicles(phone);
  if (!vehicles.length) return false;

  if (vehicles.length === 1) {
    const v = vehicles[0];
    const body = messages.vehicleConfirm.confirmedAskPart(v.make, v.model, v.year, greeting?.name);
    await sendWhatsAppButtons(phone, body, [messages.vehicleConfirm.addVehicleButton()]);
    await markPartPromptSent(phone);
    return true;
  }

  await savePendingVehicleChoice(phone, vehicles.map(v => ({ id: v.id, make: v.make, model: v.model, year: v.year })));
  const chooseBody = messages.vehicleConfirm.chooseVehiclePrompt(vehicles, greeting?.name);
  await sendWhatsAppMessage(phone, chooseBody);
  return true;
}

/**
 * Resolves a reply to the "which vehicle is this for?" picker shown by
 * sendAskPartPrompt when the customer has 2+ vehicles. Records the choice for
 * ai.service.ts to use as this invitation's vehicle context, then sends the
 * normal "what part do you need" prompt for that specific vehicle.
 */
export async function resolvePendingVehicleChoice(phone: string, reply: string): Promise<boolean> {
  const messages = await resolveMessages(phone);
  const pending = await getPendingVehicleChoice(phone);
  if (!pending) return false;

  const idx = parseInt(reply.trim(), 10) - 1;
  const chosen = pending[idx];
  if (!chosen) {
    await sendWhatsAppMessage(phone, messages.vehicleConfirm.vehicleChoiceNotFound());
    return true;
  }

  await clearPendingVehicleChoice(phone);
  await saveChosenVehicle(phone, chosen.id);
  await sendWhatsAppButtons(
    phone,
    messages.vehicleConfirm.confirmedAskPart(chosen.make, chosen.model, chosen.year),
    [messages.vehicleConfirm.addVehicleButton()]
  );
  await markPartPromptSent(phone);
  return true;
}

/**
 * Whether this customer has at least one confirmed vehicle on file (registration
 * and vehicle ID are independent — this is the sole gate for whether the
 * vehicle-ID flow is needed).
 */
export async function hasVehicleOnFile(phone: string): Promise<boolean> {
  return (await getCustomerVehicles(phone)).length > 0;
}

const ADD_VEHICLE_TRIGGERS = ['outro carro', 'add vehicle', 'novo carro', 'adicionar carro'];

/**
 * Whether this reply is the customer asking to identify an additional vehicle
 * (the "➕ Outro carro"/"➕ Add vehicle" button always offered alongside the
 * ask-part prompt, or the same phrase typed free-text).
 */
export function isAddVehicleRequest(text: string): boolean {
  const r = text.trim().toLowerCase();
  return ADD_VEHICLE_TRIGGERS.some((trigger) => r.includes(trigger));
}

/**
 * Starts identifying an additional vehicle — the same VIN/photo/manual choice
 * shown during onboarding, but for a customer who already has one or more
 * vehicles on file. Nothing about the identification flow itself needs to
 * change: saveVehicleSession always inserts a new row unless given a specific
 * in-progress row's id, so the existing vehicle(s) are untouched either way.
 */
export async function startAddVehicleFlow(phone: string): Promise<void> {
  const messages = await resolveMessages(phone);
  await sendWhatsAppButtons(phone, messages.vehicleConfirm.addVehicleBody(), messages.onboarding.askVehicleIdButtons);
  await markVehicleIdChoiceShown(phone);
}

const NHTSA_URL = config.nhtsa.apiUrl;

export interface VINInfo {
  vin: string;
  make: string;
  // Nullable — NHTSA sometimes confidently resolves make/year for a VIN but
  // leaves model unresolved (a check-digit-ambiguous VIN with an incomplete
  // manufacturer submission — see scripts/vin-decode-compare.js). Callers
  // that get a null model should use whatever make/year data IS here rather
  // than discarding the whole decode.
  model: string | null;
  year: string;
  vehicle_type?: string | null;
  engine?: string | null;
  fuel_type?: string | null;
  manufacture_country?: string | null;
}

/**
 * Checks if a text string matches the 17-character alphanumeric VIN format (excluding letters I, O, Q).
 */
export function isVIN(text: string): boolean {
  const vin = text.trim().toUpperCase();
  return /^[A-HJ-NPR-Z0-9]{17}$/.test(vin);
}

/**
 * Whether this text is shaped like a VIN attempt that just has the wrong
 * length (a dropped/extra character from a typo or copy-paste) — a single
 * alphanumeric token in VIN's ballpark, but not itself isVIN()-valid (the
 * caller already checked that first). Used by the whatsapp.controller.ts
 * vehicle-ID catch-all to give specific "that's not 17 characters" feedback
 * instead of the generic "didn't catch that, pick a button" nudge, since a
 * near-miss VIN is a meaningfully different mistake than free-text chat.
 */
export function looksLikeVinAttempt(text: string): boolean {
  return /^[A-Za-z0-9]{10,20}$/.test(text.trim());
}

/**
 * Calls the public NHTSA API to decode the 17-character VIN.
 */
export async function decodeVIN(vin: string): Promise<VINInfo | null> {
  const vinClean = vin.toUpperCase();

  const cached = await getNhtsaVehicle(vinClean);
  if (cached) {
    logger.info(`[NHTSA] Cache hit for VIN ${vinClean}`);
    return {
      vin: cached.vin,
      make: cached.make,
      model: cached.model,
      year: cached.year,
      vehicle_type: cached.vehicle_type,
      engine: cached.engine,
      fuel_type: cached.fuel_type,
      manufacture_country: cached.manufacture_country,
    };
  }

  try {
    const res = await fetch(
      `${NHTSA_URL}/${vinClean}?format=json`,
      { signal: AbortSignal.timeout(8000) } // Timeout after 8 seconds
    );

    const data = await res.json() as any;
    if (!data?.Results) return null;

    const extract = (variable: string) =>
      data.Results.find((r: any) => r.Variable === variable)?.Value || null;

    const make = extract("Make");
    const model = extract("Model");
    const year = extract("Model Year");
    const vehicleType = extract("Body Class");
    const displacement = extract("Displacement (L)");
    const fuelType = extract("Fuel Type - Primary");
    const country = extract("Plant Country");
    const errors = extract("Error Text");

    // Make and year are the load-bearing fields — a VIN NHTSA can't place at
    // all (no make/year, or an explicit "No candidates" error) is a genuine
    // decode failure. Model is deliberately NOT required here: NHTSA can
    // confidently resolve make/year for a VIN it still flags as ambiguous
    // (Error Code — unresolved character positions vs. the manufacturer's
    // submission) while leaving model null. Treating that as a total failure
    // discarded data NHTSA was actually confident about — see processVIN,
    // which shows the confirm screen with make+year and a "model not
    // identified" note instead of starting the manual wizard over.
    if (!make || !year || errors?.includes("No candidates")) {
      logger.warn(`[NHTSA] No match for VIN ${vin}${errors ? `: ${errors}` : ''}`);
      return null;
    }

    logger.info(`[NHTSA] Decoded VIN ${vin}: ${make} ${model || '(model unresolved)'} ${year}`);

    const result: VINInfo = {
      vin: vinClean,
      make: capitalize(make),
      model: model ? capitalize(model) : null,
      year: year,
      vehicle_type: vehicleType || null,
      engine: displacement ? `${displacement}L` : null,
      fuel_type: translateFuelType(fuelType),
      manufacture_country: country || null,
    };

    // Only cache confident, complete decodes — nhtsa_vehicles.model is
    // NOT NULL, and more importantly a partial/ambiguous decode is exactly
    // the kind of result that's worth re-fetching fresh next time rather than
    // freezing forever (NHTSA's own answer for these can change as
    // manufacturers resubmit data).
    if (result.model) {
      await saveNhtsaVehicle(result.vin, result as { model: string } & VINInfo);
    }

    return result;

  } catch (error: any) {
    logger.error(`[VIN] Error decoding chassis ${vin}: ${error.message}`);
    return null;
  }
}

/**
 * Translates primary fuel type responses to Portuguese equivalents
 * (fuel type is shown to the customer, so the value stays Portuguese).
 */
function translateFuelType(fuelType: string | null): string | null {
  if (!fuelType) return null;
  const map: { [key: string]: string } = {
    "Gasoline": "Gasolina",
    "Diesel": "Diesel",
    "Electric": "Eléctrico",
    "Hybrid": "Híbrido",
    "Flex Fuel": "Flex (gasolina/etanol)",
    "Natural Gas": "Gás Natural",
  };
  return map[fuelType] || fuelType;
}

/**
 * Handles the customer's tap on one of the 3 vehicle-ID option buttons
 * (VIN / document photo / manual entry) sent right after registration completes.
 * VIN and photo just prompt what to send next — the following message/image is
 * picked up by the existing VIN-detection and image-routing stages. Manual entry
 * starts the step machine directly since there's nothing further to wait for.
 */
export async function processVehicleIdOptionChoice(phone: string, reply: string): Promise<boolean> {
  const messages = await resolveMessages(phone);
  const r = reply.toLowerCase();

  if (r.includes('vin')) {
    await sendWhatsAppMessage(phone, messages.vin.askVinPrompt());
    return true;
  }

  if (r.includes('foto') || r.includes('photo') || r.includes('documento')) {
    await sendWhatsAppMessage(phone, messages.document.askPhotoPrompt());
    return true;
  }

  if (r.includes('manual')) {
    // Handing off to manual collection now — its own DB-backed status drives
    // stage 7 from here, this flag would otherwise linger for its full TTL and
    // (now that unmatched replies re-ask instead of falling through) wrongly
    // intercept the customer's actual make/model/year answers as if they were
    // still choosing between VIN/photo/manual.
    await clearVehicleIdChoiceShown(phone);
    await startManualCollection(phone, 'awaiting_make');
    await sendWhatsAppMessage(phone, messages.manual.askMakePrompt());
    return true;
  }

  return false;
}

/**
 * Handles the customer's reply to the "this vehicle is already in your
 * profile — search for a part, or add a different vehicle?" choice shown by
 * the VIN dedup check in processVIN. Only fires when that choice was just
 * shown (wasVinDuplicateChoiceShown gate in the pipeline) so it doesn't
 * misfire on unrelated free text — which also makes it safe to re-ask on a
 * mismatch instead of falling through to the stage-10 catch-all.
 */
export async function processVinDuplicateChoice(phone: string, reply: string): Promise<boolean> {
  const messages = await resolveMessages(phone);
  const r = reply.toLowerCase();

  if (r.includes('procurar') || r.includes('search') || r.includes('peça') || r.includes('part') || r === '1' || r.includes('btn_0')) {
    await clearVinDuplicateChoice(phone);
    // Vehicle interaction concluded without touching manual collection — clear so a
    // later part-search message isn't misrouted by the stage-10 fallback while this
    // flag (set by the earlier VIN-choice tap) hasn't expired yet.
    await clearVehicleIdChoiceShown(phone);
    await sendAskPartPrompt(phone);
    return true;
  }

  if (r.includes('diferente') || r.includes('different') || r.includes('adicionar') || r.includes('add') || r === '2' || r.includes('btn_1')) {
    await clearVinDuplicateChoice(phone);
    await startAddVehicleFlow(phone);
    return true;
  }

  await sendWhatsAppButtons(phone, messages.common.notUnderstood(), messages.vin.alreadyRegisteredButtons);
  await markVinDuplicateChoiceShown(phone); // refresh the TTL so the choice stays open
  return true;
}

/**
 * Handles manual vehicle information inputs.
 */
export async function processManualCollectionStep(
  phone: string,
  collection: any,
  reply: string,
  customer: Customer
): Promise<boolean> {
  const messages = await resolveMessages(phone);
  const r = reply.trim();

  if (collection.status === 'awaiting_make') {
    const make = capitalize(r);
    await updateManualCollection(collection.id, { make, status: 'awaiting_model' });
    await sendWhatsAppMessage(phone, messages.manual.askModel(make));
    return true;
  }

  if (collection.status === 'awaiting_model') {
    const model = capitalize(r);
    await updateManualCollection(collection.id, { model, status: 'awaiting_year' });
    await sendWhatsAppMessage(phone, messages.manual.askYear(collection.make, model));
    return true;
  }

  if (collection.status === 'awaiting_year') {
    const yearClean = r.replace(/\D/g, '');
    const yearInt = parseInt(yearClean, 10);
    const currentYear = new Date().getFullYear();

    if (!yearClean || yearClean.length !== 4 || yearInt < 1980 || yearInt > currentYear + 1) {
      await sendWhatsAppMessage(phone, messages.manual.invalidYear());
      return true;
    }

    await updateManualCollection(collection.id, { year: yearClean, status: 'awaiting_engine_number' });
    await sendWhatsAppMessage(phone, messages.manual.askEngineNumber(collection.make, collection.model, yearClean));
    return true;
  }

  if (collection.status === 'awaiting_engine_number') {
    const rLower = r.toLowerCase();
    const engineNumber = (rLower === 'não sei' || rLower === 'nao sei' || rLower === 'n' || rLower === 'skip' || rLower === 'não')
      ? null
      : r.toUpperCase();

    // Completes this specific in-progress row (sets status='complete' on it) —
    // does not touch any other vehicles this customer already has on file.
    await saveVehicleSession(phone, {
      make: collection.make,
      model: collection.model,
      year: collection.year,
      engine_number: engineNumber,
    }, collection.id);

    const summary = [
      `🚗 *${collection.make} ${collection.model} ${collection.year}*`,
      engineNumber ? messages.manual.engineLabel(engineNumber) : null,
    ].filter(Boolean).join('\n');

    // Identification concluded via the manual wizard — same reasoning as the VIN
    // confirm branches above.
    await clearVehicleIdChoiceShown(phone);

    const completedOnboarding = await completeOnboardingIfNeeded(phone, customer, summary);
    if (!completedOnboarding) {
      await sendWhatsAppButtons(phone, messages.manual.collectionComplete(summary), [messages.vehicleConfirm.addVehicleButton()]);
      await markPartPromptSent(phone);
    }
    return true;
  }

  return false;
}

/**
 * Handles incoming VIN number parsing.
 */
export async function processVIN(phone: string, vin: string): Promise<void> {
  const messages = await resolveMessages(phone);
  const vinClean = vin.trim().toUpperCase();

  // Dedup check first — a VIN already confirmed on this customer's profile skips
  // the NHTSA round-trip entirely and offers to just search for a part instead.
  const existing = (await getCustomerVehicles(phone)).find((v) => v.vin === vinClean);
  if (existing) {
    const description = [
      `${existing.make} ${existing.model} ${existing.year}`,
      existing.engine_size || null,
      existing.fuel_type || null,
    ].filter(Boolean).join(' · ');

    await sendWhatsAppButtons(phone, messages.vin.alreadyRegistered(description), messages.vin.alreadyRegisteredButtons);
    await saveChosenVehicle(phone, existing.id);
    await markVinDuplicateChoiceShown(phone);
    return;
  }

  await sendWhatsAppMessage(phone, messages.vin.identifying());

  const vehicle = await decodeVIN(vinClean);

  if (!vehicle) {
    // NHTSA lookup failed — ask before doing anything else instead of silently
    // starting manual collection. "Try again" restarts the full VIN/photo/manual
    // choice (the customer might rather send a photo than retype a VIN); "Manual"
    // proceeds straight to the wizard, carrying the attempted VIN through so it's
    // still recorded on the row (attempted_vin), same as the old auto-fallback did.
    await sendWhatsAppButtons(phone, messages.vin.decodeFailed(), messages.vin.decodeFailedButtons);
    await markVinDecodeFailedShown(phone, vinClean);
    return;
  }

  // Save parsed chassis data in database cache and session. vehicle.model can
  // be null here (NHTSA confidently resolved make/year but not model for an
  // ambiguous VIN — see decodeVIN's comment above); saved and shown as-is
  // rather than discarding the make/year NHTSA did confirm.
  await saveVehicleSession(phone, {
    vin: vinClean,
    make: vehicle.make,
    model: vehicle.model,
    year: vehicle.year,
    fuel_type: vehicle.fuel_type,
    engine_size: vehicle.engine,
  });

  const description = [
    vehicle.model
      ? `${vehicle.make} ${vehicle.model} ${vehicle.year}`
      : `${vehicle.make} ${vehicle.year}`,
    vehicle.model ? null : messages.vin.modelUnknownNote(),
    vehicle.engine ? `${vehicle.engine}` : null,
    vehicle.fuel_type ? `${vehicle.fuel_type}` : null,
    vehicle.vehicle_type ? `${vehicle.vehicle_type}` : null,
  ].filter(Boolean).join(' · ');

  await sendWhatsAppButtons(phone, messages.vin.confirmBody(description), messages.vin.confirmButtons);
  await markVehicleConfirmShown(phone);
}

/**
 * Handles the customer's reply to the "Try again" / "Manual entry" choice shown
 * after a VIN failed to decode (processVIN, NHTSA lookup came back empty). "Try
 * again" restarts the full VIN/photo/manual choice rather than narrowly
 * re-prompting for another VIN — the customer might rather switch to a photo.
 * "Manual" proceeds straight to the wizard, carrying the attempted VIN through.
 * Only fires when that choice was just shown (wasVinDecodeFailedShown gate in
 * the pipeline), so it doesn't misfire on unrelated free text — which also
 * makes it safe to re-ask on a mismatch instead of falling through.
 */
export async function processVinDecodeFailedChoice(phone: string, reply: string): Promise<boolean> {
  const attemptedVin = await getVinDecodeFailedVin(phone);
  if (attemptedVin === null) return false;

  const messages = await resolveMessages(phone);
  const r = reply.toLowerCase();

  if (r.includes('manual') || r === '2' || r.includes('btn_1')) {
    await clearVinDecodeFailedChoice(phone);
    // Handing off to manual collection now — its own DB-backed status drives
    // stage 7 from here, this flag would otherwise linger for its full TTL
    // and wrongly intercept the customer's actual make/model/year answers as
    // if they were still choosing between VIN/photo/manual (same bug already
    // fixed for processVehicleIdOptionChoice's manual branch above).
    await clearVehicleIdChoiceShown(phone);
    await startManualCollection(phone, 'awaiting_make', attemptedVin);
    await sendWhatsAppMessage(phone, messages.manual.askMakePrompt());
    return true;
  }

  if (r.includes('tentar') || r.includes('try again') || r.includes('novamente') || r === '1' || r.includes('btn_0')) {
    await clearVinDecodeFailedChoice(phone);
    await sendWhatsAppButtons(phone, messages.vin.restartChoiceBody(), messages.onboarding.askVehicleIdButtons);
    await markVehicleIdChoiceShown(phone);
    return true;
  }

  await sendWhatsAppButtons(phone, messages.common.notUnderstood(), messages.vin.decodeFailedButtons);
  await markVinDecodeFailedShown(phone, attemptedVin); // refresh the TTL, keep the same attempted VIN
  return true;
}

/**
 * Sends a document-processing failure message with "Try again" / "Manual entry"
 * buttons attached (shared by every failure branch in processVehicleDocument
 * below), and marks the choice shown so the customer's reply resolves via
 * processDocumentRetryChoice instead of falling through to the generic
 * manual-collection catch-all.
 */
async function sendRetryOrManualPrompt(phone: string, body: string): Promise<void> {
  const messages = await resolveMessages(phone);
  await sendWhatsAppButtons(phone, body, messages.document.retryButtons);
  await markDocumentRetryChoiceShown(phone);
}

/**
 * Handles a photo of the vehicle's registration document (livrete / Título do Veículo)
 * sent while a vehicle ID is pending. Extracts data via Claude Vision, cross-checks any
 * legible VIN against the free NHTSA API (more authoritative than OCR when available),
 * and hands off to the same Sim/Não confirmation flow processVIN uses.
 */
export async function processVehicleDocument(phone: string, mediaId: string): Promise<void> {
  const messages = await resolveMessages(phone);
  await sendWhatsAppMessage(phone, messages.document.received());

  const imageBase64 = await downloadWhatsAppMedia(mediaId);
  if (!imageBase64) {
    await sendRetryOrManualPrompt(phone, messages.document.downloadFailed());
    return;
  }

  let extracted: VisionData | null;
  try {
    extracted = await extractDataWithClaudeVision(imageBase64);
  } catch (error: any) {
    logger.error(`[VISION] Error processing document for ${phone}: ${error.message}`);
    await sendRetryOrManualPrompt(phone, messages.document.processingError());
    return;
  }

  if (!extracted) {
    await sendRetryOrManualPrompt(phone, messages.document.notRecognized());
    return;
  }

  // Even when Claude flags low confidence (valid: false — e.g. handwritten or
  // rotated text), still attempt to cross-check any chassis_number it extracted
  // against NHTSA before giving up: NHTSA is an independent, authoritative signal
  // a plain OCR self-assessment isn't — a genuinely wrong/garbled read simply fails
  // the NHTSA lookup (a safe failure that falls through to the retry/manual prompt
  // below), so trusting a confirmed NHTSA match never risks saving bad data even
  // when Claude itself wasn't fully confident in the read.
  let make = extracted.make || null;
  let model = extracted.model || null;
  let year = extracted.year || null;
  let fuelType = extracted.fuel_type || null;
  let engineSize = extracted.engine_size || null;
  let nhtsaConfirmed = false;

  if (extracted.chassis_number && isVIN(extracted.chassis_number)) {
    const decoded = await decodeVIN(extracted.chassis_number.toUpperCase());
    if (decoded) {
      make = decoded.make;
      model = decoded.model;
      year = decoded.year;
      fuelType = decoded.fuel_type;
      engineSize = decoded.engine;
      nhtsaConfirmed = true;
    }
  }

  if (!extracted.valid && !nhtsaConfirmed) {
    // Claude's `reason` is logged for debugging only — it's a verbose, technical
    // explanation (e.g. "text orientation is diagonal and legibility is compromised")
    // never meant for the customer to see; the doc's fallback message is a clean,
    // generic "I had trouble reading that image" with no exposed AI reasoning.
    logger.info(`[VISION] Document extraction invalid for ${phone}: ${extracted.reason || 'no reason given'}`);
    await sendRetryOrManualPrompt(phone, messages.document.invalid());
    return;
  }

  if (!make || !model) {
    await sendRetryOrManualPrompt(phone, messages.document.missingEssentialData());
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
    extracted.license_plate ? messages.document.licensePlateLabel(extracted.license_plate) : null,
    extracted.chassis_number ? messages.document.chassisLabel(extracted.chassis_number.toUpperCase()) : null,
  ].filter(Boolean).join(' · ');

  await sendWhatsAppButtons(phone, messages.document.confirmBody(description), messages.vin.confirmButtons);
  await markVehicleConfirmShown(phone);
}

/**
 * Handles the customer's reply to the "Try again" / "Manual entry" choice shown
 * by sendRetryOrManualPrompt after a document-processing failure. "Try again"
 * just re-prompts for a fresh photo — the next image is picked up by the
 * existing state-aware image routing, no extra state needed. Only fires when
 * that choice was just shown (wasDocumentRetryChoiceShown gate in the
 * pipeline), so it doesn't misfire on unrelated free text — which also makes
 * it safe to re-ask on a mismatch instead of falling through to the stage-10
 * catch-all (which used to silently start manual collection instead).
 */
export async function processDocumentRetryChoice(phone: string, reply: string): Promise<boolean> {
  const messages = await resolveMessages(phone);
  const r = reply.toLowerCase();

  if (r.includes('manual') || r === '2' || r.includes('btn_1')) {
    await clearDocumentRetryChoice(phone);
    // The original VIN/photo/manual choice is resolved now too — clear it so it can't
    // linger and interfere with a later message (see whatsapp.controller.ts stage 3.6).
    await clearVehicleIdChoiceShown(phone);
    await startManualCollection(phone, 'awaiting_make');
    await sendWhatsAppMessage(phone, messages.manual.askMakePrompt());
    return true;
  }

  if (r.includes('tentar') || r.includes('try again') || r.includes('novamente') || r === '1' || r.includes('btn_0')) {
    await clearDocumentRetryChoice(phone);
    // Deliberately NOT clearing vehicleIdChoiceShown here — still waiting on a photo,
    // and needsVehicleId alone (still true) keeps stage 5's image routing open regardless.
    await sendWhatsAppMessage(phone, messages.document.askPhotoPrompt());
    return true;
  }

  await sendWhatsAppButtons(phone, messages.common.notUnderstood(), messages.document.retryButtons);
  await markDocumentRetryChoiceShown(phone); // refresh the TTL so the choice stays open
  return true;
}

/**
 * Processes vehicle quick confirmation buttons. Gated on wasVehicleConfirmShown
 * (set by processVIN/processVehicleDocument right after the confirm buttons go
 * out) — without that gate, this used to regex-match sim/não against every
 * message that reached this stage regardless of whether a vehicle was actually
 * pending confirmation, which made it unsafe to re-ask on a mismatch (it could
 * misfire on unrelated chat). With the gate, a mismatch is unambiguous — the
 * customer really was asked to confirm a vehicle — so it re-sends the same
 * confirm buttons instead of falling through to the stage-10 catch-all, which
 * used to silently start manual collection and discard the pending vehicle.
 */
export async function processVehicleConfirmation(phone: string, reply: string, customer: Customer): Promise<boolean> {
  if (!(await wasVehicleConfirmShown(phone))) return false;

  const messages = await resolveMessages(phone);
  const r = reply.toLowerCase();

  if (r.includes('sim') || r.includes('yes') || r.includes('✅') || r === '1' || r.includes('btn_0')) {
    // The vehicle we just decoded/saved is unambiguously the most recently updated
    // row — nothing else touches this customer's vehicles between the save and this
    // reply, even if they already have other confirmed vehicles on file.
    const v = await getMostRecentVehicle(phone);
    if (!v) return false;

    // Identification concluded — clear so a later unrelated message (e.g. a part
    // search) doesn't get misrouted into manual collection by the stage-10
    // fallback in whatsapp.controller.ts while this flag's TTL hasn't lapsed yet.
    await clearVehicleIdChoiceShown(phone);
    await clearVehicleConfirmShown(phone);

    const summary = `🚗 *${v.make} ${v.model} ${v.year}*`;
    const completedOnboarding = await completeOnboardingIfNeeded(phone, customer, summary);
    if (!completedOnboarding) {
      await sendWhatsAppButtons(
        phone,
        messages.vehicleConfirm.confirmedAskPart(v.make, v.model, v.year),
        [messages.vehicleConfirm.addVehicleButton()]
      );
      await markPartPromptSent(phone);
    }
    return true;
  }

  if (r.includes('não') || r.includes('nao') || r.includes('❌') || r === '2' || r.includes('btn_1')) {
    // Delete only the just-rejected attempt (by id) — never all of this customer's
    // vehicles, since they may already have others confirmed.
    const rejected = await getMostRecentVehicle(phone);
    if (rejected) await clearVehicleSession(rejected.id);

    // Handing off to manual collection now — its own DB-backed status drives stage 7
    // from here, this flag is no longer needed (and shouldn't linger to interfere later).
    await clearVehicleIdChoiceShown(phone);
    await clearVehicleConfirmShown(phone);

    // Same step-by-step wizard regardless of whether this is the customer's first
    // vehicle or a returning customer re-identifying — nothing downstream parses a
    // combined "make model year" free-text reply, so asking for one led to a wasted
    // round-trip.
    await startManualCollection(phone, 'awaiting_make');
    await sendWhatsAppMessage(phone, messages.manual.askMakePrompt());
    return true;
  }

  // A vehicle really is pending confirmation and this reply didn't match either
  // option — re-ask instead of silently discarding it. Rebuilds the same confirm
  // body from the still-unconfirmed row rather than assuming the customer
  // remembers what was decoded a message or two ago.
  const pending = await getMostRecentVehicle(phone);
  if (!pending) return false;
  const description = [pending.make, pending.model, pending.year].filter(Boolean).join(' ');
  await sendWhatsAppButtons(
    phone,
    `${messages.common.notUnderstood()}\n\n🚗 *${description}*`,
    messages.vin.confirmButtons
  );
  await markVehicleConfirmShown(phone); // refresh the TTL so the choice stays open
  return true;
}
