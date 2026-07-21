import { resolveLocale } from './customer.service.js';
import { humanize, HumanizeOptions, INTERACTIVE_BODY_LIMIT, TEXT_BODY_LIMIT } from './humanize.service.js';
import { sendWhatsAppMessage, sendWhatsAppButtons, sendWhatsAppList } from './whatsapp.service.js';
import { saveActivePromptId } from './session.service.js';

/**
 * Customer-facing send layer: identical in shape to whatsapp.service.ts, but
 * runs the message BODY through the Xico Peças rewrite (humanize.service.ts)
 * first. Buttons, button ids, list rows and the list button label are passed
 * through completely untouched.
 *
 * That distinction is load-bearing, not stylistic. processMessageFlow resolves
 * most button taps by matching the reply's TITLE TEXT against the label it sent
 * (whatsapp.controller.ts, `msg.interactive.button_reply.title`) — a rewritten
 * label would break the flow silently, with no error anywhere. List rows are
 * likewise bound by Meta's 24/72-char caps and resolved by their option_N ids.
 *
 * Which module a file imports IS the allowlist. Anything that must go out
 * verbatim — admin pushes (t.admin.*), password-reset codes, the supplier
 * delivery notice, and above all the payment instruction block with the IBAN,
 * amount and reference — keeps importing whatsapp.service.js directly. Both
 * imports side by side in one file is expected and intended.
 */

export type ReplyOptions = Omit<HumanizeOptions, 'locale' | 'phone' | 'maxLength'>;

async function rewrite(
  phone: string,
  body: string,
  limit: number,
  opts?: ReplyOptions
): Promise<string> {
  return humanize(body, {
    ...opts,
    phone,
    locale: await resolveLocale(phone),
    maxLength: limit,
  });
}

export async function sendReply(phone: string, text: string, opts?: ReplyOptions): Promise<any> {
  return sendWhatsAppMessage(phone, await rewrite(phone, text, TEXT_BODY_LIMIT, opts));
}

export async function sendReplyButtons(
  phone: string,
  body: string,
  buttons: string[],
  ids?: string[],
  opts?: ReplyOptions
): Promise<any> {
  const res = await sendWhatsAppButtons(phone, await rewrite(phone, body, INTERACTIVE_BODY_LIMIT, opts), buttons, ids);
  await saveActivePromptId(phone, res?.messages?.[0]?.id);
  return res;
}

export async function sendReplyList(
  phone: string,
  body: string,
  buttonText: string,
  rows: { id: string; title: string; description?: string }[],
  opts?: ReplyOptions
): Promise<any> {
  const res = await sendWhatsAppList(phone, await rewrite(phone, body, INTERACTIVE_BODY_LIMIT, opts), buttonText, rows);
  await saveActivePromptId(phone, res?.messages?.[0]?.id);
  return res;
}
