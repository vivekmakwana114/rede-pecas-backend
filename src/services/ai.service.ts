import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config/config.js";
import { logger } from "../config/logger.js";

const anthropic = new Anthropic({ apiKey: config.anthropic.apiKey });

const SYSTEM_PROMPT = `
És o assistente virtual da Rede Peças, um marketplace automotivo em Angola.
O teu trabalho é ajudar clientes a encontrar peças para os seus veículos.

REGRAS:
1. Sê sempre simpático e directo. Fala em português angolano informal.
2. Extrai do pedido do cliente: peça, marca do veículo, modelo e ano.
3. Se faltarem dados críticos (marca ou modelo), faz UMA pergunta curta para obtê-los.
4. Quando tiveres informação suficiente, devolve APENAS um JSON válido neste formato:
   { "acção": "pesquisar", "peca": "...", "marca_veiculo": "...", "modelo": "...", "ano": "..." }
5. Se o cliente escolher uma opção (ex: responde "2" ou "quero a segunda"), devolve:
   { "acção": "confirmar_pedido", "opcao_escolhida": 2 }
6. Se o cliente quiser falar com humano, devolve:
   { "acção": "transferir_humano", "motivo": "..." }
7. Para qualquer outra mensagem de conversa normal, responde em texto simples — NÃO em JSON.

EXEMPLOS DE EXTRACÇÃO:
- "filtro de óleo pra Golf 2019" → { "acção": "pesquisar", "peca": "filtro de óleo", "marca_veiculo": "Volkswagen", "modelo": "Golf", "ano": "2019" }
- "correia da Toyota Hilux" → pede o ano, pois é crítico para compatibilidade
- "preciso de amortecedor dianteiro" → pede marca e modelo do carro
`;

export interface VisionData {
  documento: boolean;
  valido?: boolean;
  motivo?: string | null;
  marca?: string | null;
  modelo?: string | null;
  ano?: string | null;
  matricula?: string | null;
  numero_chassis?: string | null;
  numero_motor?: string | null;
  cilindrada?: string | null;
  combustivel?: string | null;
  cor?: string | null;
  tipo?: string | null;
}

/**
 * Sends conversation message history to Claude chatbot and retrieves response text.
 */
export async function chamarAgenteAI(historico: { role: 'user' | 'assistant'; content: string }[]): Promise<string> {
  try {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: historico,
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
export async function extrairDadosComClaudeVision(imagemBase64: string): Promise<VisionData | null> {
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
              data: imagemBase64,
            },
          },
          {
            type: "text",
            text: `Analisa esta imagem. Pode ser um livrete angolano, Título do Veículo (Vehicle Certificate), 
ficha técnica, ou outro documento de registo de viatura.

Se NÃO for um documento de viatura, responde exactamente: {"documento": false}

Se FOR um documento de viatura, extrai os seguintes dados e responde APENAS em JSON válido:
{
  "documento": true,
  "valido": true ou false,
  "motivo": "razão se inválido ou ilegível",
  "marca": "marca do veículo (ex: Toyota, Mercedes, Volvo)",
  "modelo": "modelo (ex: Hilux, Actros, FH16)",
  "ano": "ano de fabrico ou matrícula (4 dígitos)",
  "matricula": "matrícula/placa se visível",
  "numero_chassis": "VIN ou número de chassi se visível (17 caracteres)",
  "numero_motor": "número do motor se visível",
  "cilindrada": "cilindrada do motor (ex: 2.4, 3.0)",
  "combustivel": "tipo de combustível (Gasolina, Diesel, Eléctrico)",
  "cor": "cor do veículo se visível",
  "tipo": "tipo de carroçaria (Ligeiro, Pesado, SUV, Comercial, etc)",
  "proprietario": null
}

REGRAS IMPORTANTES:
- Nunca inventes dados — se um campo não estiver visível ou legível, coloca null
- O campo "proprietario" deve ser SEMPRE null (privacidade)
- Se a imagem estiver desfocada ou ilegível, coloca valido: false e explica no motivo
- Responde APENAS com o JSON, sem texto adicional`
          }
        ]
      }]
    });

    const texto = response.content[0].type === 'text' ? response.content[0].text.trim() : '';

    try {
      const parsed = JSON.parse(texto.replace(/```json|```/g, "").trim());
      if (!parsed.documento) return null;
      return parsed as VisionData;
    } catch {
      logger.error(`Error parsing vision model JSON: ${texto}`);
      return { valido: false, motivo: "Erro ao interpretar o documento." } as VisionData;
    }
  } catch (error: any) {
    logger.error(`Claude Vision error: ${error.message}`);
    throw error;
  }
}
