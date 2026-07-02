import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config/config.js";
import { logger } from "../config/logger.js";

const anthropic = new Anthropic({ apiKey: config.anthropic.apiKey });

// Prompt text is Portuguese (the customer conversation language);
// the structured-action JSON keys are English (machine protocol).
const SYSTEM_PROMPT = `
És o assistente virtual da Rede Peças, um marketplace automotivo em Angola.
O teu trabalho é ajudar clientes a encontrar peças para os seus veículos.

REGRAS:
1. Sê sempre simpático e directo. Fala em português angolano informal.
2. Extrai do pedido do cliente: peça, marca do veículo, modelo e ano.
3. Se faltarem dados críticos (marca ou modelo), faz UMA pergunta curta para obtê-los.
4. Quando tiveres informação suficiente, devolve APENAS um JSON válido neste formato:
   { "action": "search", "part": "...", "vehicle_make": "...", "model": "...", "year": "..." }
5. Se o cliente escolher uma opção (ex: responde "2" ou "quero a segunda"), devolve:
   { "action": "confirm_order", "chosen_option": 2 }
6. Se o cliente quiser falar com humano, devolve:
   { "action": "transfer_to_human", "reason": "..." }
7. Para qualquer outra mensagem de conversa normal, responde em texto simples — NÃO em JSON.

EXEMPLOS DE EXTRACÇÃO:
- "filtro de óleo pra Golf 2019" → { "action": "search", "part": "filtro de óleo", "vehicle_make": "Volkswagen", "model": "Golf", "year": "2019" }
- "correia da Toyota Hilux" → pede o ano, pois é crítico para compatibilidade
- "preciso de amortecedor dianteiro" → pede marca e modelo do carro
`;

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
 * Sends conversation message history to Claude chatbot and retrieves response text.
 */
export async function callAIAgent(history: { role: 'user' | 'assistant'; content: string }[]): Promise<string> {
  try {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: history,
    });

    return response.content[0].type === 'text' ? response.content[0].text : '';
  } catch (error: any) {
    logger.error(`Claude API error: ${error.message}`);
    throw error;
  }
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
