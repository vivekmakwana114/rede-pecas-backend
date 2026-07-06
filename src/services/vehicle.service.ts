import { logger } from '../config/logger.js';
import { capitalize } from '../utils/helpers.js';
import {
  getCustomerVehicle,
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
import { completeOnboardingIfNeeded, Customer } from './customer.service.js';
import { t } from '../i18n/messages.js';

// Pure pass-through so the controller never imports vehicle.model.js directly
export { getActiveManualCollection, startManualCollection };

const NHTSA_URL = "https://vpic.nhtsa.dot.gov/api/vehicles/decodevin";

export interface VINInfo {
  vin: string;
  make: string;
  model: string;
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

    // Invalid VIN if critical fields are missing
    if (!make || !model || !year || errors?.includes("No candidates")) {
      logger.warn(`[NHTSA] No match for VIN ${vin}${errors ? `: ${errors}` : ''}`);
      return null;
    }

    logger.info(`[NHTSA] Decoded VIN ${vin}: ${make} ${model} ${year}`);

    const result: VINInfo = {
      vin: vinClean,
      make: capitalize(make),
      model: capitalize(model),
      year: year,
      vehicle_type: vehicleType || null,
      engine: displacement ? `${displacement}L` : null,
      fuel_type: translateFuelType(fuelType),
      manufacture_country: country || null,
    };

    await saveNhtsaVehicle(result.vin, result);

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
  const r = reply.toLowerCase();

  if (r.includes('vin')) {
    await sendWhatsAppMessage(phone, t.vin.askVinPrompt());
    return true;
  }

  if (r.includes('foto') || r.includes('photo') || r.includes('documento')) {
    await sendWhatsAppMessage(phone, t.document.askPhotoPrompt());
    return true;
  }

  if (r.includes('manual')) {
    await startManualCollection(phone, 'awaiting_make');
    await sendWhatsAppMessage(phone, t.manual.askMakePrompt());
    return true;
  }

  return false;
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
export async function processVIN(phone: string, vin: string): Promise<void> {
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
export async function processVehicleDocument(phone: string, mediaId: string): Promise<void> {
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
export async function processVehicleConfirmation(phone: string, reply: string, customer: Customer): Promise<boolean> {
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
