import Anthropic from '@anthropic-ai/sdk';
import { createHash } from 'crypto';
import { config } from '../config/config.js';
import { logger } from '../config/logger.js';
import { buildHumanizePrompt } from '../i18n/persona.js';
import { getHumanized, saveHumanized, getLastMessage, getCustomerName } from './session.service.js';

/**
 * Rewrites the deterministic replies from messages.ts in the Xico Peças tone
 * (see i18n/persona.ts) so the bot stops reading like a form letter.
 *
 * The contract every caller relies on: this function NEVER throws and NEVER
 * returns anything but either a validated rewrite or the original string. A
 * failure here — bad API key, timeout, mangled output, Redis down — must degrade
 * to exactly the message the customer would have received before this layer
 * existed. It can never be the reason someone gets no reply.
 */

// Separate client from ai.service.ts's on purpose: that one does Vision
// extraction where a slow retry is worth waiting for, this one is holding up a
// live customer reply. A rewrite that takes four seconds is worse than no
// rewrite, so: hard timeout, and no retries.
// 5s, not the 3500ms this started at: full-flow testing showed longer messages
// (the payment-method prompt, with an order number and amount) reliably timing
// out and falling back. Because results are cached, this latency is paid once
// per distinct string and every later send of it resolves from Redis in ~10ms —
// so a more generous cold-path budget costs little and materially raises how
// much of the conversation actually gets humanized.
const anthropic = new Anthropic({
  apiKey: config.anthropic.apiKey,
  timeout: 5000,
  maxRetries: 0,
});

const HUMANIZE_MODEL = 'claude-haiku-4-5-20251001';

// Meta's caps: 1024 chars for an interactive message body, 4096 for plain text.
export const INTERACTIVE_BODY_LIMIT = 1024;
export const TEXT_BODY_LIMIT = 4096;

export interface HumanizeOptions {
  locale: 'pt' | 'en';
  /**
   * Opt in to a contextual rewrite: the customer's name and last inbound
   * message are given to Claude, and folded into the cache key. Costs an API
   * call per message instead of one per distinct string, so reserve it for the
   * moments where reacting to what the customer actually said is the point
   * (greetings, "didn't understand that", no search results, human handoff).
   */
  contextual?: boolean;
  /** Phone number — only needed to look up context when `contextual` is set. */
  phone?: string;
  /** Substrings that must survive verbatim, on top of the automatic number guard. */
  preserve?: string[];
  maxLength?: number;
}

/**
 * Every run of 3+ digits in the source. Prices, order numbers, years, VINs,
 * NIFs and payment references all reduce to this, which is why the guard is
 * derived automatically rather than declared per call site — a new message with
 * a number in it is protected the day it is written, with no extra wiring.
 */
function numericTokens(text: string): string[] {
  return text.match(/\d{3,}/g) ?? [];
}

/**
 * Every double-quoted short literal in the source. In messages.ts quotes are
 * reserved for two things, both of which must survive a rewrite verbatim:
 *
 *   - commands the customer is expected to TYPE BACK — "saltar", "skip",
 *     "não sei", "não tenho" — each matched literally by a handler
 *     (e.g. `rLower === 'saltar'` in customer.service.ts). A rewrite that
 *     paraphrases the instruction leaves the customer with no way to trigger it.
 *   - concrete examples ("brake pads", "filtro de óleo") that are more useful
 *     kept than reworded.
 *
 * This is the typed-reply counterpart to never rewriting button labels: both are
 * cases where the wording IS the interface. Derived automatically for the same
 * reason as the numeric guard — a new message with a quoted keyword is protected
 * the day it's written, with no per-call-site wiring to forget.
 */
function quotedLiterals(text: string): string[] {
  return (text.match(/"([^"\n]{1,20})"/g) ?? []).map((q) => q.slice(1, -1).trim()).filter(Boolean);
}

function cacheKey(text: string, opts: HumanizeOptions, context: string): string {
  const hash = createHash('sha1').update(`${text}|${context}`).digest('hex');
  return `humanized:${opts.locale}:${hash}`;
}

// A single optional-field shape rather than a discriminated union: this project
// compiles with `strict: false`, and without strictNullChecks TypeScript can't
// narrow `{ok: true, ...} | {ok: false, ...}` on the `ok` check.
interface ValidationResult {
  ok: boolean;
  text?: string;
  reason?: string;
}

/**
 * Rejects a rewrite that drifted. Reports WHICH rule failed rather than a bare
 * null — when a message silently reverts to the canned wording in production,
 * "numeric token 18500 dropped" is the difference between a two-minute fix and
 * an afternoon of guessing.
 */
function validate(original: string, candidate: string, opts: HumanizeOptions): ValidationResult {
  let out = candidate.trim();

  // Models like to wrap a rewrite in quotes or announce it first.
  if (/^(here'?s|here is|sure|okay|ok|certainly)\b/i.test(out)) {
    return { ok: false, reason: 'preamble' };
  }
  if (out.length >= 2 && /^["'“”]/.test(out) && /["'“”]$/.test(out)) {
    out = out.slice(1, -1).trim();
  }

  if (!out) return { ok: false, reason: 'empty' };

  const limit = opts.maxLength ?? TEXT_BODY_LIMIT;
  if (out.length > limit) {
    return { ok: false, reason: `too-long (${out.length} > ${limit})` };
  }

  // A rewrite that's much shorter than the original is the tell for dropped
  // content, not concise phrasing — de-corporatizing a single sentence can
  // reasonably lose ~40-50% ("Unfortunately the requested item is not
  // available..." -> "Sorry — that one's out of stock right now." is ~0.52),
  // but a multi-point message (a greeting + a pitch + a list + a closing
  // question, e.g. onboarding.welcome()) collapsing that far means whole
  // points got cut, not trimmed. Longer originals get a stricter floor for
  // exactly that reason.
  const minRatio = original.length > 150 ? 0.5 : 0.35;
  const minLength = original.length * minRatio;
  if (out.length < minLength) {
    return {
      ok: false,
      reason: `too-short (${out.length} < ${Math.round(minLength)}, ratio ${(out.length / original.length).toFixed(2)})`,
    };
  }

  for (const needle of opts.preserve ?? []) {
    if (needle && !out.includes(needle)) {
      return { ok: false, reason: `preserve-missing ("${needle}")` };
    }
  }

  for (const token of numericTokens(original)) {
    if (!out.includes(token)) {
      return { ok: false, reason: `numeric-dropped ("${token}")` };
    }
  }

  for (const literal of quotedLiterals(original)) {
    if (!out.includes(literal)) {
      return { ok: false, reason: `keyword-dropped ("${literal}")` };
    }
  }

  return { ok: true, text: out };
}

/**
 * One line per send identifying who actually wrote the message that went out —
 * worded so it reads straight in a log tail, no source= codes to decode:
 *
 *   [HUMANIZE] [CLAUDE MESSAGE (fresh)]  — a new rewrite, validated and sent
 *   [HUMANIZE] [CLAUDE MESSAGE (cached)] — a previously validated rewrite, re-validated and sent
 *   [HUMANIZE] [DEFAULT MESSAGE (messages.ts)] reason=...  — the canned string, with the reason why
 *
 * DEFAULT is logged at warn when something went wrong (rejected, timeout, API
 * error) and at debug when it's simply the expected state (layer disabled), so
 * a warn in the log always means a rewrite was attempted and lost.
 */
function logOutcome(
  source: 'claude' | 'cache' | 'default',
  reason: string | null,
  original: string,
  final: string,
  opts: HumanizeOptions
): void {
  const who = opts.phone ?? 'unknown';
  const preview = final.replace(/\s+/g, ' ').slice(0, 70);

  if (source === 'default') {
    const line = `[HUMANIZE] [DEFAULT MESSAGE (messages.ts)] reason=${reason} phone=${who} | ${preview}`;
    if (reason === 'disabled') logger.debug(line);
    else logger.warn(`${line} | original kept: "${original.replace(/\s+/g, ' ').slice(0, 70)}"`);
    return;
  }

  const label = source === 'cache' ? '[CLAUDE MESSAGE (cached)]' : '[CLAUDE MESSAGE (fresh)]';
  logger.info(
    `[HUMANIZE] ${label} phone=${who} locale=${opts.locale}` +
    `${opts.contextual ? ' contextual=true' : ''} | ${preview}`
  );
}

export async function humanize(text: string, opts: HumanizeOptions): Promise<string> {
  if (!config.claudeMessage.enabled) {
    logOutcome('default', 'disabled', text, text, opts);
    return text;
  }
  if (!text?.trim()) {
    logOutcome('default', 'empty-source', text, text, opts);
    return text;
  }

  try {
    let context = '';
    if (opts.contextual && opts.phone) {
      const [name, lastMessage] = await Promise.all([
        getCustomerName(opts.phone),
        getLastMessage(opts.phone),
      ]);
      const parts: string[] = [];
      if (name) parts.push(`Customer's name: ${name}`);
      if (lastMessage) parts.push(`What the customer just wrote: ${lastMessage}`);
      context = parts.join('\n');
    }

    const key = cacheKey(text, opts, context);
    const cached = await getHumanized(key);
    if (cached) {
      // Re-validated rather than trusted: `preserve` and `maxLength` are
      // per-call-site and deliberately NOT part of the cache key (they'd
      // fragment it for no benefit), so the same base string cached from a
      // laxer caller could violate a stricter one's constraints. Cheap check,
      // and without it the guarantee this whole layer rests on has a hole in it.
      const revalidated = validate(text, cached, opts);
      if (!revalidated.ok) {
        logOutcome('default', `cache-${revalidated.reason}`, text, text, opts);
        return text;
      }
      logOutcome('cache', null, text, revalidated.text, opts);
      return revalidated.text;
    }

    const instruction = `Rewrite this message in ${opts.locale === 'pt' ? 'PORTUGUESE' : 'ENGLISH'}:`;

    const response = await anthropic.messages.create({
      model: HUMANIZE_MODEL,
      max_tokens: 512,
      system: buildHumanizePrompt(opts.locale),
      messages: [{
        role: 'user',
        content: context
          ? `${context}\n\n${instruction}\n${text}`
          : `${instruction}\n${text}`,
      }],
    });

    const raw = response.content[0].type === 'text' ? response.content[0].text : '';
    const validated = validate(text, raw, opts);

    if (!validated.ok) {
      logOutcome('default', `rejected:${validated.reason}`, text, text, opts);
      return text;
    }

    await saveHumanized(key, validated.text);
    logOutcome('claude', null, text, validated.text, opts);
    return validated.text;
  } catch (error: any) {
    // Covers the timeout too — an aborted request lands here, which is why the
    // reason is worth keeping in the line rather than collapsing to "failed".
    logOutcome('default', `error:${error.message}`, text, text, opts);
    return text;
  }
}
