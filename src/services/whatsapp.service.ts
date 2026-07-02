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
 * Downloads a media attachment from the Meta Graph API and returns it base64-encoded.
 * Two-step lookup: resolve the media URL by ID, then fetch the bytes (both require
 * the same bearer token — the URL alone is not publicly fetchable).
 */
export async function downloadWhatsAppMedia(mediaId: string): Promise<string | null> {
  try {
    const metaRes = await fetch(`https://graph.facebook.com/v19.0/${mediaId}`, {
      headers: { Authorization: `Bearer ${config.whatsapp.token}` },
    });
    if (!metaRes.ok) {
      logger.error(`WhatsApp media lookup error for ${mediaId}: ${metaRes.status}`);
      return null;
    }
    const { url } = await metaRes.json() as { url?: string };
    if (!url) return null;

    const mediaRes = await fetch(url, {
      headers: { Authorization: `Bearer ${config.whatsapp.token}` },
    });
    if (!mediaRes.ok) {
      logger.error(`WhatsApp media download error for ${mediaId}: ${mediaRes.status}`);
      return null;
    }

    const buffer = await mediaRes.arrayBuffer();
    return Buffer.from(buffer).toString('base64');
  } catch (error: any) {
    logger.error(`Error downloading WhatsApp media ${mediaId}: ${error.message}`);
    return null;
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
