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
 * Sends an interactive message containing up to 3 quick-reply buttons, and
 * optionally an image/document header — used to relay a customer's
 * payment-proof photo/PDF straight to an admin's WhatsApp with Approve/Reject
 * buttons attached directly to it (see notifyAdminsPaymentProofReceived in
 * payment.service.ts), reusing the media id Meta already issued for the
 * incoming proof rather than re-uploading it (media ids stay valid for
 * outbound sends within the same WhatsApp Business Account that received
 * them — contrast with pdf.service.ts's sendProformaWhatsApp, which uploads a
 * server-generated file it doesn't have a media id for yet). Button reply ids
 * default to the positional btn_0/btn_1/btn_2 scheme every existing
 * button-only caller relies on (title-matched, not id-matched); pass `ids` to
 * give each button a stable, semantic id instead (e.g. encoding an order
 * number) when the reply needs to be resolved reliably rather than by fuzzy
 * title text — see processAdminStockReply in product.service.ts.
 *
 * Meta caps quick-reply button titles at 20 characters — callers must keep
 * `buttons` within that, spelling out anything longer in `body` instead.
 */
export async function sendWhatsAppButtons(
  phone: string,
  body: string,
  buttons: string[],
  ids?: string[],
  media?: { type: 'image' | 'document'; id: string }
): Promise<any> {
  const header = media
    ? media.type === 'document'
      ? { type: 'document', document: { id: media.id, filename: 'payment-proof.pdf' } }
      : { type: 'image', image: { id: media.id } }
    : undefined;

  const payload = {
    messaging_product: "whatsapp",
    to: phone,
    type: "interactive",
    interactive: {
      type: "button",
      ...(header ? { header } : {}),
      body: { text: body },
      action: {
        buttons: buttons.slice(0, 3).map((b, i) => ({
          type: "reply",
          reply: { id: ids?.[i] ?? `btn_${i}`, title: b },
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

/**
 * Sends an interactive list message (up to 10 tappable rows in one section).
 * Meta enforces row title <= 24 chars and description <= 72 chars — callers
 * must pre-truncate, this function does not.
 */
export async function sendWhatsAppList(
  phone: string,
  body: string,
  buttonText: string,
  rows: { id: string; title: string; description?: string }[]
): Promise<any> {
  const payload = {
    messaging_product: "whatsapp",
    to: phone,
    type: "interactive",
    interactive: {
      type: "list",
      body: { text: body },
      action: {
        button: buttonText,
        sections: [{ rows: rows.slice(0, 10) }],
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
      logger.error('WhatsApp API sending list error', error);
      throw new Error(`WhatsApp API list error: ${response.status}`);
    }

    return response.json();
  } catch (error: any) {
    logger.error(`Error sending list to ${phone}: ${error.message}`);
    throw error;
  }
}
