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
            text: `Analyze this image related to vehicle identification. It can be ANY of the following:
- An Angolan livrete, Vehicle Certificate (Título do Veículo), technical datasheet (ficha técnica), or
  other vehicle registration document
- A chassis identification plate (VIN plate) — usually found in the engine bay, door frame, dashboard,
  or stamped directly into the vehicle's structure
- A label, sticker, or engraving showing the chassis number (VIN)
- Any other photo where the chassis number (VIN), license plate, or vehicle data is legible

It does not need to be a formal paper document — even a photo showing only the VIN plate counts.

If the image has NO vehicle identification information visible at all (no VIN, no license plate, no
make/model), respond exactly: {"document": false}

If the image shows ANY vehicle identification information, extract the visible data and respond ONLY
with valid JSON:
{
  "document": true,
  "valid": true or false,
  "reason": "reason if invalid or unreadable",
  "make": "vehicle make (e.g. Toyota, Mercedes, Volvo)",
  "model": "model (e.g. Hilux, Actros, FH16)",
  "year": "manufacture or registration year (4 digits)",
  "license_plate": "license plate if visible",
  "chassis_number": "VIN or chassis number if visible (17 characters)",
  "engine_number": "engine number if visible",
  "engine_size": "engine displacement (e.g. 2.4, 3.0)",
  "fuel_type": "fuel type (Gasoline, Diesel, Electric)",
  "color": "vehicle color if visible",
  "body_type": "body type (Light, Heavy, SUV, Commercial, etc)",
  "owner": null
}

IMPORTANT RULES:
- A photo that clearly shows a 17-character chassis number (VIN) is always valid (valid: true), even if
  no other field is visible — make/model/year can be null, the VIN alone is enough
- Never invent data — if a field isn't visible or legible, set it to null
- The "owner" field must ALWAYS be null (privacy)
- If the image is too blurry or unreadable to confidently read anything, set valid: false and explain
  in reason
- Respond ONLY with the JSON, no additional text`
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
            text: `Analyze this image. It should be a payment proof (bank transfer receipt, deposit slip,
Multicaixa Express, or mobile payment confirmation in Angola).

Respond ONLY with valid JSON in this format:
{
  "valid": true or false,
  "reason": "reason if invalid or unreadable (e.g. not a payment proof, unreadable image)",
  "amount": "payment amount if visible (e.g. 18,500 Kz)",
  "date": "payment date if visible",
  "reference": "reference or transaction number if visible"
}

IMPORTANT RULES:
- "valid" must be false if the image doesn't look like a real payment proof, is unreadable, or is
  clearly something else (e.g. a selfie, a car part, an identity document)
- Never invent data — if a field isn't visible or legible, set it to null
- Respond ONLY with the JSON, no additional text`
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
