import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config/config.js";
import { logger } from "../config/logger.js";

const anthropic = new Anthropic({ apiKey: config.anthropic.apiKey });

// The only AI calls left anywhere in this system: both are Vision extraction
// on customer-uploaded images (vehicle document, payment proof), never on
// conversational chat text — that conversational agent was removed in favor
// of deterministic DB search + rule-based routing (see whatsapp.controller.ts).
const VISION_MODEL = "claude-haiku-4-5-20251001";

export interface VisionData {
  document: boolean;
  valid?: boolean;
  reason?: string | null;
  make?: string | null;
  model?: string | null;
  year?: string | null;
  license_plate?: string | null;
  chassis_number?: string | null;
  engine_number?: string | null;
  engine_size?: string | null;
  fuel_type?: string | null;
  color?: string | null;
  body_type?: string | null;
}

/**
 * Sends a base64 encoded document image to Claude Vision to extract vehicle metadata.
 */
export async function extractDataWithClaudeVision(imageBase64: string): Promise<VisionData | null> {
  try {
    const response = await anthropic.messages.create({
      model: VISION_MODEL,
      max_tokens: 1024,
      messages: [{
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/jpeg",
              data: imageBase64,
            },
          },
          {
            type: "text",
            text: `Analisa esta imagem. Pode ser um livrete angolano, Título do Veículo (Vehicle Certificate),
ficha técnica, ou outro documento de registo de viatura.

Se NÃO for um documento de viatura, responde exactamente: {"document": false}

Se FOR um documento de viatura, extrai os seguintes dados e responde APENAS em JSON válido:
{
  "document": true,
  "valid": true ou false,
  "reason": "razão se inválido ou ilegível",
  "make": "marca do veículo (ex: Toyota, Mercedes, Volvo)",
  "model": "modelo (ex: Hilux, Actros, FH16)",
  "year": "ano de fabrico ou matrícula (4 dígitos)",
  "license_plate": "matrícula/placa se visível",
  "chassis_number": "VIN ou número de chassi se visível (17 caracteres)",
  "engine_number": "número do motor se visível",
  "engine_size": "cilindrada do motor (ex: 2.4, 3.0)",
  "fuel_type": "tipo de combustível (Gasolina, Diesel, Eléctrico)",
  "color": "cor do veículo se visível",
  "body_type": "tipo de carroçaria (Ligeiro, Pesado, SUV, Comercial, etc)",
  "owner": null
}

REGRAS IMPORTANTES:
- Nunca inventes dados — se um campo não estiver visível ou legível, coloca null
- O campo "owner" deve ser SEMPRE null (privacidade)
- Se a imagem estiver desfocada ou ilegível, coloca valid: false e explica no reason
- Responde APENAS com o JSON, sem texto adicional`
          }
        ]
      }]
    });

    const text = response.content[0].type === 'text' ? response.content[0].text.trim() : '';

    try {
      const parsed = JSON.parse(text.replace(/```json|```/g, "").trim());
      if (!parsed.document) return null;
      return parsed as VisionData;
    } catch {
      logger.error(`Error parsing vision model JSON: ${text}`);
      return { valid: false, reason: "Erro ao interpretar o documento." } as VisionData;
    }
  } catch (error: any) {
    logger.error(`Claude Vision error: ${error.message}`);
    throw error;
  }
}

export interface PaymentProofData {
  valid: boolean;
  reason?: string | null;
  amount?: string | null;
  date?: string | null;
  reference?: string | null;
}

/**
 * Sends a base64 encoded payment-proof image to Claude Vision to validate it
 * actually looks like a payment receipt (bank transfer, deposit, Multicaixa
 * Express, mobile payment confirmation) and extract what it can for the audit
 * trail. Gates processPaymentProof in payment.service.ts — an invalid result
 * asks the customer to re-upload instead of advancing the order status.
 */
export async function extractPaymentProofData(imageBase64: string): Promise<PaymentProofData | null> {
  try {
    const response = await anthropic.messages.create({
      model: VISION_MODEL,
      max_tokens: 512,
      messages: [{
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/jpeg",
              data: imageBase64,
            },
          },
          {
            type: "text",
            text: `Analisa esta imagem. Deve ser um comprovativo de pagamento (recibo de transferência
bancária, depósito, Multicaixa Express, ou confirmação de pagamento móvel em Angola).

Responde APENAS em JSON válido neste formato:
{
  "valid": true ou false,
  "reason": "razão se inválido ou ilegível (ex: não é um comprovativo, imagem ilegível)",
  "amount": "valor do pagamento se visível (ex: 18.500 Kz)",
  "date": "data do pagamento se visível",
  "reference": "referência ou número de transacção se visível"
}

REGRAS IMPORTANTES:
- "valid" deve ser false se a imagem não parecer um comprovativo de pagamento real, estiver
  ilegível, ou for claramente outra coisa (ex: uma selfie, uma peça de carro, um documento de identificação)
- Nunca inventes dados — se um campo não estiver visível ou legível, coloca null
- Responde APENAS com o JSON, sem texto adicional`
          }
        ]
      }]
    });

    const text = response.content[0].type === 'text' ? response.content[0].text.trim() : '';

    try {
      return JSON.parse(text.replace(/```json|```/g, "").trim()) as PaymentProofData;
    } catch {
      logger.error(`Error parsing payment-proof vision JSON: ${text}`);
      return { valid: false, reason: "Erro ao interpretar o comprovativo." };
    }
  } catch (error: any) {
    logger.error(`Claude Vision payment-proof error: ${error.message}`);
    throw error;
  }
}
