import { config } from '../config/config.js';
import { logger } from '../config/logger.js';

const WHATSAPP_API_URL = `https://graph.facebook.com/v19.0/${config.whatsapp.phoneNumberId}/messages`;

/**
 * Sends a standard text message via Meta WhatsApp Business API.
 */
export async function sendWhatsAppMessage(phone: string, text: string): Promise<any> {
  try {
    const response = await fetch(WHATSAPP_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.whatsapp.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: phone,
        type: "text",
        text: { body: text },
      }),
    });

    if (!response.ok) {
      const error = await response.json();
      logger.error('WhatsApp API sending error', error);
      throw new Error(`WhatsApp API error: ${response.status}`);
    }

    return response.json();
  } catch (error: any) {
    logger.error(`Error sending message to ${phone}: ${error.message}`);
    throw error;
  }
}

/**
 * Sends an interactive message containing up to 3 quick-reply buttons.
 */
export async function sendWhatsAppButtons(
  phone: string,
  body: string,
  buttons: string[]
): Promise<any> {
  const payload = {
    messaging_product: "whatsapp",
    to: phone,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: body },
      action: {
        buttons: buttons.slice(0, 3).map((b, i) => ({
          type: "reply",
          reply: { id: `btn_${i}`, title: b },
        })),
      },
    },
  };

  try {
    const response = await fetch(WHATSAPP_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.whatsapp.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const error = await response.json();
      logger.error('WhatsApp API sending buttons error', error);
      throw new Error(`WhatsApp API button error: ${response.status}`);
    }

    return response.json();
  } catch (error: any) {
    logger.error(`Error sending buttons to ${phone}: ${error.message}`);
    throw error;
  }
}
