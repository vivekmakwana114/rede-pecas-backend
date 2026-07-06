import Anthropic from "@anthropic-ai/sdk";
import fs from 'fs';
import { config } from "../config/config.js";
import { logger } from "../config/logger.js";
import { getCustomerVehicle } from '../models/vehicle.model.js';
import { createOrder, generateOrderNumber } from '../models/order.model.js';
import * as productService from './product.service.js';
import { generateProformaPDF, sendProformaWhatsApp } from './pdf.service.js';
import { askPaymentMethod } from './payment.service.js';
import { getHistory, saveHistory, getPendingOptions, clearPendingOptions } from './session.service.js';
import { sendWhatsAppMessage } from './whatsapp.service.js';
import { t } from '../i18n/messages.js';

const anthropic = new Anthropic({ apiKey: config.anthropic.apiKey });

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
      model: "claude-sonnet-4-20250514",
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

/**
 * Conversation flow processing using Anthropic API.
 */
export async function processAIConversation(phone: string, customerText: string): Promise<void> {
  try {
    const history = await getHistory(phone);
    const vehicle = await getCustomerVehicle(phone);

    let enrichedText = customerText;
    // Enrich query context with session vehicle metadata if the customer doesn't type it
    if (vehicle && !customerText.toLowerCase().includes(vehicle.make.toLowerCase())) {
      enrichedText =
        `[Viatura do cliente: ${vehicle.make} ${vehicle.model} ${vehicle.year}] ` +
        customerText;
    }

    history.push({ role: 'user', content: enrichedText });

    const aiReply = await callAnthropic(history);
    const action = tryParseJSON(aiReply);

    if (!action) {
      await sendWhatsAppMessage(phone, aiReply);
      // Push the clean agent text response to session history
      history.push({ role: 'assistant', content: aiReply });
    } else {
      // If agent requested search, inject vehicle parameters from session cache if missing
      if (action.action === 'search' && vehicle) {
        action.vehicle_make = action.vehicle_make || vehicle.make;
        action.model = action.model || vehicle.model;
        action.year = action.year || vehicle.year;
      }
      await executeStructuredAction(phone, action, history);
    }

    await saveHistory(phone, history);
  } catch (error: any) {
    // Anthropic call or downstream action failed (e.g. bad ANTHROPIC_API_KEY) — without this,
    // the customer gets silence (the outer webhook catch only logs) after already having
    // received the session greeting, which reads as a broken/inconsistent bot.
    logger.error(`AI agent pipeline failed for ${phone}`, error);
    await sendWhatsAppMessage(phone, t.agent.serviceUnavailable());

    const staffPhone = config.admin.staffPhone;
    if (staffPhone) {
      try {
        await sendWhatsAppMessage(staffPhone, t.agent.aiFailureStaffAlert(phone, error.message));
      } catch (staffError: any) {
        // Staff alert failing (e.g. STAFF_PHONE_NUMBER not on the WhatsApp test allow-list)
        // must not surface as a second uncaught error — the customer already got their
        // fallback message above, and this is a best-effort side notification.
        logger.error('Failed to notify staff of AI agent failure', staffError);
      }
    }
  }
}

async function callAnthropic(history: any[]): Promise<string> {
  // Strip temporary fields from history before sending to Anthropic SDK
  const cleanMessages = history.map((h) => ({
    role: h.role,
    content: h.content,
  }));

  const response = await anthropic.messages.create({
    model: 'claude-3-5-sonnet-20241022',
    max_tokens: 1024,
    system: t.systemPrompt,
    messages: cleanMessages,
  });

  // Extract response text
  const textContent = response.content.find(c => c.type === 'text');
  return textContent?.type === 'text' ? textContent.text : '';
}

/**
 * Orchestrates backend JSON actions returned by the AI agent.
 */
async function executeStructuredAction(phone: string, action: any, history: any): Promise<void> {
  switch (action.action) {
    case 'search': {
      await productService.searchAndRespond(phone, action, history);
      break;
    }

    case 'confirm_order': {
      const options = await getPendingOptions(phone);
      const idx = (action.chosen_option || 1) - 1;
      const choice = options?.[idx];

      if (!choice) {
        await sendWhatsAppMessage(phone, t.agent.optionNotFound());
        return;
      }

      const orderNumber = await generateOrderNumber();

      // Save order record
      await createOrder(orderNumber, phone, choice);

      // Generate invoice proforma PDF
      const proformaPath = await generateProformaPDF(orderNumber, phone, choice);

      // Send confirmation text & PDF attachment
      await sendProformaWhatsApp(phone, proformaPath, orderNumber, choice);

      // Trigger payment selection prompt
      await askPaymentMethod(phone, orderNumber, choice.price);

      // Options consumed — prevent a stale numeric reply from creating a duplicate order
      await clearPendingOptions(phone);

      // Clean temp PDF asynchronously
      setTimeout(() => {
        try {
          fs.unlinkSync(proformaPath);
        } catch {
          // best-effort cleanup, ignore if already removed
        }
      }, 60000);

      const confirmation = t.agent.proformaSentChoosePayment();
      history.push({ role: 'assistant', content: confirmation });
      break;
    }

    case 'transfer_to_human': {
      const msg = t.agent.transferToHuman();
      await sendWhatsAppMessage(phone, msg);
      logger.info(`[SUPPORT] Customer ${phone} requested human support. Reason: ${action.reason}`);
      break;
    }

    default:
      logger.warn('Unknown structured action from AI agent', action);
  }
}

function tryParseJSON(text: string): any | null {
  try {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}
