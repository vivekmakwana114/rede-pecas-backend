import { logger } from '../config/logger.js';
import { capitalizar } from '../utils/helpers.js';

const NHTSA_URL = "https://vpic.nhtsa.dot.gov/api/vehicles/decodevin";

export interface VINInfo {
  vin: string;
  marca: string;
  modelo: string;
  ano: string;
  tipo?: string | null;
  motorizacao?: string | null;
  combustivel?: string | null;
  pais_fabrico?: string | null;
}

/**
 * Checks if a text string matches the 17-character alphanumeric VIN format (excluding letters I, O, Q).
 */
export function isVIN(texto: string): boolean {
  const vin = texto.trim().toUpperCase();
  return /^[A-HJ-NPR-Z0-9]{17}$/.test(vin);
}

/**
 * Calls the public NHTSA API to decode the 17-character VIN.
 */
export async function descodificarVIN(vin: string): Promise<VINInfo | null> {
  try {
    const res = await fetch(
      `${NHTSA_URL}/${vin.toUpperCase()}?format=json`,
      { signal: AbortSignal.timeout(8000) } // Timeout after 8 seconds
    );

    const dados = await res.json();
    if (!dados?.Results) return null;

    const extrair = (variavel: string) =>
      dados.Results.find((r: any) => r.Variable === variavel)?.Value || null;

    const marca = extrair("Make");
    const modelo = extrair("Model");
    const ano = extrair("Model Year");
    const tipo = extrair("Body Class");
    const motorizacao = extrair("Displacement (L)");
    const combustivel = extrair("Fuel Type - Primary");
    const pais = extrair("Plant Country");
    const erros = extrair("Error Text");

    // Invalid VIN if critical fields are missing
    if (!marca || !modelo || !ano || erros?.includes("No candidates")) {
      return null;
    }

    return {
      vin: vin.toUpperCase(),
      marca: capitalizar(marca),
      modelo: capitalizar(modelo),
      ano: ano,
      tipo: tipo || null,
      motorizacao: motorizacao ? `${motorizacao}L` : null,
      combustivel: traduzirCombustivel(combustivel),
      pais_fabrico: pais || null,
    };

  } catch (error: any) {
    logger.error(`[VIN] Error decoding chassis ${vin}: ${error.message}`);
    return null;
  }
}

/**
 * Translates primary fuel type responses to Portuguese equivalents.
 */
function traduzirCombustivel(combustivel: string | null): string | null {
  if (!combustivel) return null;
  const mapa: { [key: string]: string } = {
    "Gasoline": "Gasolina",
    "Diesel": "Diesel",
    "Electric": "Eléctrico",
    "Hybrid": "Híbrido",
    "Flex Fuel": "Flex (gasolina/etanol)",
    "Natural Gas": "Gás Natural",
  };
  return mapa[combustivel] || combustivel;
}
