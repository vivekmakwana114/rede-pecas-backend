import { logger } from '../config/logger.js';
import { capitalize } from '../utils/helpers.js';

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
  try {
    const res = await fetch(
      `${NHTSA_URL}/${vin.toUpperCase()}?format=json`,
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
      return null;
    }

    return {
      vin: vin.toUpperCase(),
      make: capitalize(make),
      model: capitalize(model),
      year: year,
      vehicle_type: vehicleType || null,
      engine: displacement ? `${displacement}L` : null,
      fuel_type: translateFuelType(fuelType),
      manufacture_country: country || null,
    };

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
