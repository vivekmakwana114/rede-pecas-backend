import { config } from '../config/config.js';
import { logger } from '../config/logger.js';

const WHATSAPP_API_URL = `https://graph.facebook.com/v19.0/${config.whatsapp.phoneNumberId}/messages`;

/**
 * Sends a standard text message via Meta WhatsApp Business API.
 */
export async function enviarMensagemWhatsApp(telefone: string, texto: string): Promise<any> {
  try {
    const resposta = await fetch(WHATSAPP_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.whatsapp.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: telefone,
        type: "text",
        text: { body: texto },
      }),
    });

    if (!resposta.ok) {
      const erro = await resposta.json();
      logger.error('WhatsApp API sending error', erro);
      throw new Error(`WhatsApp API error: ${resposta.status}`);
    }

    return resposta.json();
  } catch (error: any) {
    logger.error(`Error sending message to ${telefone}: ${error.message}`);
    throw error;
  }
}

/**
 * Sends an interactive message containing up to 3 quick-reply buttons.
 */
export async function enviarMensagemComBotoes(
  telefone: string,
  corpo: string,
  botoes: string[]
): Promise<any> {
  const payload = {
    messaging_product: "whatsapp",
    to: telefone,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: corpo },
      action: {
        buttons: botoes.slice(0, 3).map((b, i) => ({
          type: "reply",
          reply: { id: `btn_${i}`, title: b },
        })),
      },
    },
  };

  try {
    const resposta = await fetch(WHATSAPP_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.whatsapp.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!resposta.ok) {
      const erro = await resposta.json();
      logger.error('WhatsApp API sending buttons error', erro);
      throw new Error(`WhatsApp API button error: ${resposta.status}`);
    }

    return resposta.json();
  } catch (error: any) {
    logger.error(`Error sending buttons to ${telefone}: ${error.message}`);
    throw error;
  }
}
