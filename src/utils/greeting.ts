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
 * Detects English vs Portuguese from a greeting word, used once at first
 * contact to pick a new customer's sticky `locale` (see getOrCreateCustomer
 * in customer.service.ts). Returns null when the text isn't a recognized
 * greeting at all (e.g. a customer opens with a VIN or a part name) — the
 * caller falls back to Portuguese in that case.
 */
export function detectGreetingLocale(text: string): 'en' | 'pt' | null {
  const trimmed = text.trim();
  if (GREETING_PATTERN_EN.test(trimmed)) return 'en';
  if (GREETING_PATTERN_PT.test(trimmed)) return 'pt';
  return null;
}
