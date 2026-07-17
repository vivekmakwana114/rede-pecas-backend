// Bare greetings (PT/EN) never get treated as a part search, even once the customer's
// already been invited to state one this session — they must always get the
// deterministic "what part do you need" prompt instead, so a stray "Hi"/"Hey" doesn't
// get sent into a nonsensical inventory search. Split into EN/PT sub-patterns so a
// single greeting word also tells us which language to reply in — see
// detectGreetingLocale below, used once at first contact (customer.service.ts).
export const GREETING_PATTERN_EN = /^(hi|hello|hey+|yo|good\s*(morning|afternoon|evening|day))\b/i;
export const GREETING_PATTERN_PT = /^(oi|ol[aá]|e\s*a[ií]|bom\s*dia|boa\s*tarde|boa\s*noite|tudo\s*bem|como\s*est[aá]s?)\b/i;
export const GREETING_PATTERN = new RegExp(`(${GREETING_PATTERN_EN.source})|(${GREETING_PATTERN_PT.source})`, 'i');

/**
 * Detects English vs Portuguese from a greeting word. Returns null when the
 * text isn't a recognized greeting at all (e.g. a customer opens with a VIN
 * or a part name) — callers fall back to whatever locale otherwise applies.
 */
export function detectGreetingLocale(text: string): 'en' | 'pt' | null {
  const trimmed = text.trim();
  if (GREETING_PATTERN_EN.test(trimmed)) return 'en';
  if (GREETING_PATTERN_PT.test(trimmed)) return 'pt';
  return null;
}

// Common PT/EN function words and domain terms (auto parts, greetings,
// yes/no, everyday connectors) used by detectMessageLocale below to score an
// arbitrary message, not just a leading greeting. Deliberately a plain word
// list rather than a real language-detection library or model — consistent
// with the rest of this app's no-AI, deterministic pattern matching (see
// CLAUDE.md "No conversational AI"). Ambiguous words that exist as common,
// unrelated terms in both languages (e.g. "no" — English negative reply vs.
// the Portuguese "em"+"o" contraction) are deliberately left out of both
// lists so they can't cast a false vote either way.
const PT_SIGNAL_WORDS = new Set([
  'oi', 'ola', 'olá', 'bom', 'boa', 'dia', 'tarde', 'noite', 'sim', 'nao', 'não',
  'obrigado', 'obrigada', 'favor', 'preciso', 'precisava', 'quero', 'queria', 'gostaria',
  'para', 'meu', 'minha', 'meus', 'minhas', 'carro', 'carros', 'peca', 'peça', 'pecas', 'peças',
  'ainda', 'hoje', 'amanha', 'amanhã', 'entao', 'então', 'voce', 'você', 'tenho', 'esta', 'está',
  'estou', 'sou', 'com', 'sem', 'onde', 'quando', 'porque', 'como', 'isso', 'muito', 'pode',
  'poderia', 'vou', 'fazer', 'comprar', 'preco', 'preço', 'pagar', 'endereco', 'endereço', 'morada',
  'rua', 'bairro', 'numero', 'número', 'tudo', 'bem', 'uma', 'um', 'tambem', 'também', 'mais',
  'menos', 'agora', 'depois', 'ja', 'já', 'aqui', 'ali', 'nome', 'telefone', 'veiculo', 'veículo',
  'motor', 'oleo', 'óleo', 'filtro', 'pastilha', 'pastilhas', 'travao', 'travão', 'correia',
  'amortecedor', 'ajuda', 'ajudar', 'quanto', 'custa', 'obrigadinho', 'certo', 'claro', 'desculpa',
  'desculpe', 'vamos', 'essa', 'esse', 'aquele', 'aquela',
]);

const EN_SIGNAL_WORDS = new Set([
  'hi', 'hello', 'hey', 'good', 'morning', 'afternoon', 'evening', 'yes', 'please', 'thanks',
  'thank', 'you', 'need', 'needed', 'want', 'wanted', 'would', 'like', 'for', 'my', 'car', 'cars',
  'part', 'parts', 'still', 'today', 'tomorrow', 'then', 'have', 'has', 'with', 'without', 'where',
  'when', 'because', 'how', 'this', 'that', 'very', 'can', 'could', 'will', 'buy', 'price', 'pay',
  'address', 'street', 'name', 'phone', 'vehicle', 'engine', 'oil', 'filter', 'brake', 'pads',
  'belt', 'shock', 'absorber', 'now', 'later', 'here', 'there', 'also', 'more', 'less', 'help',
  'sure', 'sorry', 'okay', 'yeah', 'yep', 'nope', 'much', 'cost', 'many', 'order', 'send', 'photo',
  'picture', 'document',
]);

/**
 * Detects English vs Portuguese from any free-text message, not just a
 * leading greeting — used on every inbound message with text (see
 * whatsapp.controller.ts) so a customer switching language mid-conversation
 * gets answered in whatever they just typed, instead of a locale detected
 * once and frozen. A recognized greeting word is trusted outright (most
 * specific signal); otherwise scores the message's words against the PT/EN
 * lists above and returns whichever side has strictly more hits. Returns
 * null on a tie (including 0-0, e.g. a VIN, a bare digit, or a product
 * reference with no recognizable words) — callers should keep whatever
 * locale was already in effect for that conversation rather than guessing.
 */
export function detectMessageLocale(text: string): 'en' | 'pt' | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const greeting = detectGreetingLocale(trimmed);
  if (greeting) return greeting;

  const words = trimmed.toLowerCase().match(/\p{L}+/gu) || [];
  if (!words.length) return null;

  let ptScore = 0;
  let enScore = 0;
  for (const word of words) {
    if (PT_SIGNAL_WORDS.has(word)) ptScore++;
    if (EN_SIGNAL_WORDS.has(word)) enScore++;
  }

  if (ptScore === enScore) return null;
  return ptScore > enScore ? 'pt' : 'en';
}
