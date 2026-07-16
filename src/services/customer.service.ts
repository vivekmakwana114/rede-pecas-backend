import {
  getAndUpdateCustomer,
  createCustomerPreRegistration,
  updateCustomer,
  getCustomerByPhone,
  Customer
} from '../models/customer.model.js';
import { sendWhatsAppMessage, sendWhatsAppButtons } from './whatsapp.service.js';
import { markSessionActive, markPartPromptSent, markVehicleIdChoiceShown } from './session.service.js';
import { capitalize } from '../utils/helpers.js';
import { getMessages, DEFAULT_LOCALE } from '../i18n/messages.js';
import { detectGreetingLocale } from '../utils/greeting.js';

export type { Customer };

/**
 * Resolves the right message set for a customer by phone — a lightweight DB
 * lookup, used by service functions that only have `phone` in scope (not
 * the full `customer` row). Falls back to Portuguese for an unknown phone
 * (shouldn't happen in practice — every caller runs after getOrCreateCustomer).
 */
export async function resolveMessages(phone: string) {
  const customer = await getCustomerByPhone(phone);
  return getMessages(customer?.locale ?? DEFAULT_LOCALE);
}

/**
 * Fetches the customer, or starts pre-registration + sends the welcome
 * message on first contact. Returns null when it just created the row —
 * the caller should return immediately in that case. `firstMessageText` is
 * the brand-new customer's very first inbound message — inspected once here
 * to detect their sticky locale (English/Portuguese greeting, falling back
 * to Portuguese when it isn't a recognized greeting at all) before the
 * welcome message goes out in that language.
 */
export async function getOrCreateCustomer(phone: string, firstMessageText: string | null): Promise<Customer | null> {
  const customer = await getAndUpdateCustomer(phone);
  if (customer) return customer;

  const locale = detectGreetingLocale(firstMessageText || '') ?? DEFAULT_LOCALE;
  await createCustomerPreRegistration(phone, 'awaiting_name', locale);
  // Marked active before the send, not after: sendWhatsAppMessage throws on
  // failure (e.g. the number isn't in the WhatsApp sandbox's allowlist yet —
  // see TESTING.md), and if that aborted this function before reaching this
  // call, the customer's very next message (their actual name) would see
  // isNewSession() still true and get swallowed by the "let's continue your
  // registration" resume-prompt instead of being captured — corrupting every
  // registration field one step downstream from there.
  await markSessionActive(phone);
  await sendWhatsAppMessage(phone, getMessages(locale).onboarding.welcome());
  return null;
}

/**
 * Handles customer profile registration steps (name/NIF/address). Independent of
 * vehicle identification, which is tracked separately via the `vehicles` table.
 */
export async function processCustomerRegistration(phone: string, customer: Customer, reply: string): Promise<boolean> {
  const messages = getMessages(customer.locale ?? DEFAULT_LOCALE);
  const r = reply.trim();
  const status = customer.registration_status;
  // The name captured in the 'awaiting_name' step below, available on `customer` for
  // every later step since it was saved on a previous turn before this one started.
  const firstName = customer.name?.split(' ')[0] || 'Cliente';

  if (status === 'awaiting_name') {
    const name = capitalize(r);
    await updateCustomer(phone, { name, registration_status: 'awaiting_nif' });
    await sendWhatsAppButtons(phone, messages.onboarding.askNifBody(name), messages.onboarding.askNifButtons);
    return true;
  }

  if (status === 'awaiting_nif') {
    const rLower = r.toLowerCase();
    const noNif = rLower.includes('não') || rLower.includes('nao') || rLower.includes('❌') || rLower.includes('nao obrigado') || r === '2';

    if (noNif) {
      await updateCustomer(phone, { nif: null, registration_status: 'awaiting_address' });
      await sendWhatsAppMessage(phone, messages.onboarding.askAddress(firstName));
    } else {
      // "Sim, tenho NIF" only confirms they have one — the button reply itself isn't the
      // NIF number, so ask for it separately instead of saving the button title as data.
      await updateCustomer(phone, { registration_status: 'awaiting_nif_number' });
      await sendWhatsAppMessage(phone, messages.onboarding.askNifNumber());
    }
    return true;
  }

  if (status === 'awaiting_nif_number') {
    const nif = r.replace(/\s/g, '').toUpperCase();
    await updateCustomer(phone, { nif, registration_status: 'awaiting_address' });
    await sendWhatsAppMessage(phone, messages.onboarding.askAddress(firstName));
    return true;
  }

  if (status === 'awaiting_address') {
    const rLower = r.toLowerCase();
    const address = (rLower === 'saltar' || rLower === 'skip') ? null : r;

    await updateCustomer(phone, {
      address,
      registration_status: 'complete',
    });

    const cust = await getCustomerByPhone(phone);
    const name = cust?.name?.split(' ')[0] || 'Cliente';

    // Profile is done, but the customer still has no vehicle on file — the vehicle-ID
    // gate in whatsapp.controller.ts picks this up on their next message regardless,
    // but showing the buttons immediately here avoids an unnecessary extra round trip.
    await sendWhatsAppButtons(phone, messages.onboarding.askVehicleIdBody(name), messages.onboarding.askVehicleIdButtons);
    await markVehicleIdChoiceShown(phone);
    return true;
  }

  return false;
}

/**
 * Greets a customer resuming a stale mid-registration session (their previous session
 * expired before they finished name/NIF/address) and re-sends the exact question for
 * their current step, reusing the same prompt builders `processCustomerRegistration` uses —
 * instead of silently treating this first message as the answer to that step.
 */
export async function sendResumeRegistrationPrompt(phone: string, customer: Customer): Promise<void> {
  const messages = getMessages(customer.locale ?? DEFAULT_LOCALE);
  await sendWhatsAppMessage(phone, messages.onboarding.resumeRegistration());

  if (customer.registration_status === 'awaiting_name') {
    await sendWhatsAppMessage(phone, messages.onboarding.askNameOnly());
  } else if (customer.registration_status === 'awaiting_nif') {
    const name = customer.name?.split(' ')[0] || 'Cliente';
    await sendWhatsAppButtons(phone, messages.onboarding.askNifBody(name), messages.onboarding.askNifButtons);
  } else if (customer.registration_status === 'awaiting_nif_number') {
    await sendWhatsAppMessage(phone, messages.onboarding.askNifNumber());
  } else if (customer.registration_status === 'awaiting_address') {
    const firstName = customer.name?.split(' ')[0] || 'Cliente';
    await sendWhatsAppMessage(phone, messages.onboarding.askAddress(firstName));
  }
}

/**
 * If this is the customer's first-ever confirmed vehicle (registered_at still NULL —
 * profile and vehicle are independent, so this is the only reliable "first time" signal
 * now that there's no shared 'awaiting_vehicle_id' status), sends the combined "profile
 * complete" welcome message and stamps registered_at. Returns true if it did so, so the
 * caller can skip its own lighter-weight "tell me what part you need" message — used for
 * a returning customer whose vehicle session simply expired and is being re-provided.
 */
export async function completeOnboardingIfNeeded(
  phone: string,
  customer: Customer,
  vehicleSummary: string
): Promise<boolean> {
  if (customer.registered_at) return false;

  const messages = getMessages(customer.locale ?? DEFAULT_LOCALE);
  await updateCustomer(phone, { registered_at: new Date() });

  const name = customer.name?.split(' ')[0] || 'Cliente';
  await sendWhatsAppButtons(
    phone,
    messages.onboarding.onboardingComplete(name, vehicleSummary),
    [messages.vehicleConfirm.addVehicleButton()]
  );
  await markPartPromptSent(phone);
  return true;
}
