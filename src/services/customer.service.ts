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
import { t } from '../i18n/messages.js';

export type { Customer };

/**
 * Fetches the customer, or starts pre-registration + sends the welcome
 * message on first contact. Returns null when it just created the row —
 * the caller should return immediately in that case.
 */
export async function getOrCreateCustomer(phone: string): Promise<Customer | null> {
  const customer = await getAndUpdateCustomer(phone);
  if (customer) return customer;

  await createCustomerPreRegistration(phone, 'awaiting_name');
  await sendWhatsAppMessage(phone, t.onboarding.welcome());
  await markSessionActive(phone);
  return null;
}

/**
 * Handles customer profile registration steps (name/NIF/address). Independent of
 * vehicle identification, which is tracked separately via the `vehicles` table.
 */
export async function processCustomerRegistration(phone: string, status: string, reply: string): Promise<boolean> {
  const r = reply.trim();

  if (status === 'awaiting_name') {
    const name = capitalize(r);
    await updateCustomer(phone, { name, registration_status: 'awaiting_nif' });
    await sendWhatsAppButtons(phone, t.onboarding.askNifBody(name), t.onboarding.askNifButtons);
    return true;
  }

  if (status === 'awaiting_nif') {
    const rLower = r.toLowerCase();
    const noNif = rLower.includes('não') || rLower.includes('nao') || rLower.includes('❌') || rLower.includes('nao obrigado') || r === '2';

    if (noNif) {
      await updateCustomer(phone, { nif: null, registration_status: 'awaiting_address' });
      await sendWhatsAppMessage(phone, t.onboarding.askAddress());
    } else {
      // "Sim, tenho NIF" only confirms they have one — the button reply itself isn't the
      // NIF number, so ask for it separately instead of saving the button title as data.
      await updateCustomer(phone, { registration_status: 'awaiting_nif_number' });
      await sendWhatsAppMessage(phone, t.onboarding.askNifNumber());
    }
    return true;
  }

  if (status === 'awaiting_nif_number') {
    const nif = r.replace(/\s/g, '').toUpperCase();
    await updateCustomer(phone, { nif, registration_status: 'awaiting_address' });
    await sendWhatsAppMessage(phone, t.onboarding.askAddress());
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
    await sendWhatsAppButtons(phone, t.onboarding.askVehicleIdBody(name), t.onboarding.askVehicleIdButtons);
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
  await sendWhatsAppMessage(phone, t.onboarding.resumeRegistration());

  if (customer.registration_status === 'awaiting_name') {
    await sendWhatsAppMessage(phone, t.onboarding.askNameOnly());
  } else if (customer.registration_status === 'awaiting_nif') {
    const name = customer.name?.split(' ')[0] || 'Cliente';
    await sendWhatsAppButtons(phone, t.onboarding.askNifBody(name), t.onboarding.askNifButtons);
  } else if (customer.registration_status === 'awaiting_nif_number') {
    await sendWhatsAppMessage(phone, t.onboarding.askNifNumber());
  } else if (customer.registration_status === 'awaiting_address') {
    await sendWhatsAppMessage(phone, t.onboarding.askAddress());
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

  await updateCustomer(phone, { registered_at: new Date() });

  const name = customer.name?.split(' ')[0] || 'Cliente';
  await sendWhatsAppButtons(
    phone,
    t.onboarding.onboardingComplete(name, vehicleSummary),
    [t.vehicleConfirm.addVehicleButton()]
  );
  await markPartPromptSent(phone);
  return true;
}
