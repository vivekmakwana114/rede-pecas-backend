import { Request, Response } from 'express';
import { catchAsync } from '../utils/catchAsync.js';
import { ApiError } from '../utils/ApiError.js';
import { formatDateTime } from '../utils/helpers.js';
import {
  getAllCustomers,
  getActiveCustomerByPhone,
  updateCustomer,
  deactivateCustomer,
  Customer,
  CustomerWithStats,
} from '../models/customer.model.js';

/**
 * Renders first_contact_at/last_contact_at/registered_at as `dd/mm/yyyy HH:mm`
 * (Africa/Luanda) before they leave the API — the admin panel displays
 * whatever the backend sends verbatim, with no client-side reformatting.
 */
function serializeCustomer(customer: CustomerWithStats) {
  return {
    ...customer,
    first_contact_at: formatDateTime(customer.first_contact_at),
    last_contact_at: formatDateTime(customer.last_contact_at),
    registered_at: formatDateTime(customer.registered_at),
  };
}

/**
 * Lists active customers for the admin panel, newest-contact-first.
 * Supports pagination (page/limit) and a free-text search (q) over
 * name/phone/nif — unlike the product catalog, the customer table grows
 * with every WhatsApp contact, so it's paginated from the start.
 */
export const getCustomersHandler = catchAsync(async (req: Request, res: Response) => {
  const page = req.query.page ? Number(req.query.page) : 1;
  const limit = req.query.limit ? Number(req.query.limit) : 50;
  const q = req.query.q ? String(req.query.q) : undefined;

  const { customers, total } = await getAllCustomers({ page, limit, q });

  res.status(200).json({
    success: true,
    message: 'Customers retrieved.',
    code: 200,
    data: { customers: customers.map(serializeCustomer), total, page, limit },
    meta: { timestamp: new Date().toISOString() },
  });
});

export const getCustomerHandler = catchAsync(async (req: Request, res: Response) => {
  const { phone } = req.params;
  const customer = await getActiveCustomerByPhone(phone);
  if (!customer) throw new ApiError(404, `Customer ${phone} not found`);

  res.status(200).json({
    success: true,
    message: 'Customer retrieved.',
    code: 200,
    data: serializeCustomer(customer),
    meta: { timestamp: new Date().toISOString() },
  });
});

/**
 * Admin edits to the CRM fields only — name/nif/address/email. Registration
 * status, contact metadata and vehicles are owned by the WhatsApp flow and
 * are not admin-editable here.
 */
export const updateCustomerHandler = catchAsync(async (req: Request, res: Response) => {
  const { phone } = req.params;
  const existing = await getActiveCustomerByPhone(phone);
  if (!existing) throw new ApiError(404, `Customer ${phone} not found`);

  const { name, nif, address, email } = req.body;
  const fields: Partial<Customer> = {};
  if (name !== undefined) fields.name = name;
  if (nif !== undefined) fields.nif = nif;
  if (address !== undefined) fields.address = address;
  if (email !== undefined) fields.email = email;

  await updateCustomer(phone, fields);
  const updated = await getActiveCustomerByPhone(phone);

  res.status(200).json({
    success: true,
    message: `Customer ${phone} updated.`,
    code: 200,
    data: updated ? serializeCustomer(updated) : null,
    meta: { timestamp: new Date().toISOString() },
  });
});

/**
 * Soft-deletes the customer (active = false) — see deactivateCustomer for
 * why this isn't a hard DELETE.
 */
export const deleteCustomerHandler = catchAsync(async (req: Request, res: Response) => {
  const { phone } = req.params;
  const deleted = await deactivateCustomer(phone);
  if (!deleted) throw new ApiError(404, `Customer ${phone} not found`);

  res.status(200).json({
    success: true,
    message: `Customer ${phone} deleted.`,
    code: 200,
    data: null,
    meta: { timestamp: new Date().toISOString() },
  });
});
