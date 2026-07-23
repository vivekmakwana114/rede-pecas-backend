import { db } from '../config/db.js';

export interface ServiceProvider {
  id?: number;
  name: string;
  address?: string | null;
  province?: string | null;
  phone?: string | null;
  specialties?: string | null;
  rating?: number;
  response_time?: string | null;
  active?: boolean;
}

export interface Service {
  id?: number;
  provider_id: number;
  provider_name?: string;
  provider_address?: string | null;
  provider_province?: string;
  provider_phone?: string;
  provider_specialties?: string | null;
  provider_rating?: number;
  provider_response_time?: string | null;
  service_name: string;
  service_category: string;
  service_base_price: number;
  service_duration_h: number;
  available_at_home: boolean;
  base_travel_fee?: number | null;
  logistics_fee_notes?: string | null;
  active?: boolean;
}

export interface ImportServiceItem {
  providerId?: number;
  providerName?: string;
  providerAddress?: string;
  providerProvince?: string;
  providerPhone?: string;
  specialties?: string;
  rating?: number;
  responseTime?: string;
  serviceName: string;
  serviceCategory: string;
  serviceBasePrice: number;
  serviceDurationH: number;
  availableAtHome: boolean;
  baseTravelFee?: number;
  logisticsFeeNotes?: string;
}

/**
 * Finds a service provider by name, or creates one if it doesn't exist yet.
 * Mirrors getOrCreateSupplierByName in supplier.model.ts — plain
 * check-then-insert (no unique constraint on service_providers.name),
 * acceptable for low-concurrency admin-triggered import usage.
 */
export async function getOrCreateServiceProviderByName(
  name: string,
  address?: string | null,
  province?: string | null,
  phone?: string | null,
  specialties?: string | null,
  rating?: number | null,
  responseTime?: string | null
): Promise<number> {
  const { rows } = await db.query('SELECT id FROM service_providers WHERE name ILIKE $1 LIMIT 1', [name]);
  if (rows.length) return rows[0].id;

  const inserted = await db.query(
    `INSERT INTO service_providers (name, address, province, phone, specialties, rating, response_time)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [name, address || null, province || null, phone || null, specialties || null, rating ?? null, responseTime || null]
  );
  return inserted.rows[0].id;
}

/**
 * Resolves the provider a service's edited Name/Address/Province/Phone
 * fields should point to — mirrors resolveSupplierForProductEdit in
 * supplier.model.ts. Never mutates the current provider row in place (it may
 * be shared by other services from the same provider); either repoints to an
 * existing different provider with that name, or creates a new one.
 */
export async function resolveServiceProviderForEdit(
  name: string,
  address: string | null,
  province: string | null,
  phone: string | null,
  currentProviderId: number
): Promise<number> {
  const { rows } = await db.query(
    'SELECT id FROM service_providers WHERE name ILIKE $1 AND id != $2 LIMIT 1',
    [name, currentProviderId]
  );
  if (rows.length) return rows[0].id;

  const inserted = await db.query(
    'INSERT INTO service_providers (name, address, province, phone) VALUES ($1, $2, $3, $4) RETURNING id',
    [name, address || null, province || null, phone || null]
  );
  return inserted.rows[0].id;
}

/**
 * Batch upserts already-validated service items, grouping by resolved
 * provider (same shape as importProductsBatch in supplier.model.ts). Rows
 * missing a service name/category are defensively skipped — the real
 * validation (skip-with-reason reporting) happens upstream in
 * service.service.ts's validateServiceRow.
 */
export async function importServicesBatch(
  items: ImportServiceItem[],
  defaultProviderId: number | null = null
): Promise<{ inserted: number; updated: number }> {
  let inserted = 0;
  let updated = 0;

  const providerCache = new Map<string, number>();
  const byProvider = new Map<number, ImportServiceItem[]>();

  for (const item of items) {
    if (!item.serviceName || !item.serviceCategory) continue;

    let providerId = item.providerId ?? null;

    if (!providerId && item.providerName) {
      const cacheKey = item.providerName.toLowerCase();
      providerId = providerCache.get(cacheKey) ?? null;
      if (!providerId) {
        providerId = await getOrCreateServiceProviderByName(
          item.providerName,
          item.providerAddress,
          item.providerProvince,
          item.providerPhone,
          item.specialties,
          item.rating,
          item.responseTime
        );
        providerCache.set(cacheKey, providerId);
      }
    }

    if (!providerId) providerId = defaultProviderId;
    if (!providerId) continue; // no way to resolve a provider for this row — skip it

    const group = byProvider.get(providerId) || [];
    group.push(item);
    byProvider.set(providerId, group);
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    for (const [providerId, providerItems] of byProvider) {
      for (const item of providerItems) {
        const result = await client.query(
          `INSERT INTO services (provider_id, service_name, service_category, service_base_price, service_duration_h, available_at_home, base_travel_fee, logistics_fee_notes, active, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, NOW())
           ON CONFLICT (provider_id, service_name)
           DO UPDATE SET
             service_category = EXCLUDED.service_category,
             service_base_price = EXCLUDED.service_base_price,
             service_duration_h = EXCLUDED.service_duration_h,
             available_at_home = EXCLUDED.available_at_home,
             base_travel_fee = EXCLUDED.base_travel_fee,
             logistics_fee_notes = EXCLUDED.logistics_fee_notes,
             active = true,
             updated_at = NOW()
           RETURNING (xmax = 0) AS was_inserted`,
          [
            providerId,
            item.serviceName,
            item.serviceCategory,
            item.serviceBasePrice,
            item.serviceDurationH,
            item.availableAtHome,
            item.baseTravelFee ?? null,
            item.logisticsFeeNotes ?? null,
          ]
        );

        if (result.rows[0]?.was_inserted) inserted++;
        else updated++;
      }
    }

    await client.query('COMMIT');
    return { inserted, updated };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

const SERVICE_SELECT = `
  SELECT
    sv.id,
    sv.provider_id,
    sv.service_name,
    sv.service_category,
    sv.service_base_price,
    sv.service_duration_h,
    sv.available_at_home,
    sv.base_travel_fee,
    sv.logistics_fee_notes,
    sv.active,
    sp.name AS provider_name,
    sp.address AS provider_address,
    sp.province AS provider_province,
    sp.phone AS provider_phone,
    sp.specialties AS provider_specialties,
    sp.rating AS provider_rating,
    sp.response_time AS provider_response_time
  FROM services sv
  JOIN service_providers sp ON sp.id = sv.provider_id
`;

/**
 * Fetches every service (active and inactive), joined with its provider —
 * backs the admin panel's services grid (GET /admin/services), mirroring
 * getAllProducts. Includes inactive rows (unlike getMatchingServicesByCategory
 * below, which is customer-facing-adjacent and must stay active-only) so the
 * admin can find and reactivate a deactivated service — see updateService's
 * `active` field.
 */
export async function getAllServices(): Promise<Service[]> {
  const { rows } = await db.query(`${SERVICE_SELECT} ORDER BY sv.updated_at DESC`);
  return rows;
}

/**
 * Fetches a single service by id regardless of active status — backs
 * GET/PATCH /admin/services/:id, the only current caller, so a deactivated
 * service can still be viewed and re-activated.
 */
export async function getServiceById(id: number): Promise<Service | null> {
  const { rows } = await db.query(`${SERVICE_SELECT} WHERE sv.id = $1`, [id]);
  return rows.length ? rows[0] : null;
}

/**
 * Admin edits to a service's own fields — backs PATCH /admin/services/:id.
 * provider_id is intentionally not editable here, same rationale as
 * updateProduct: reassigning it would change the row's
 * UNIQUE (provider_id, service_name) identity.
 */
export async function updateService(id: number, fields: Partial<Service>): Promise<void> {
  const keys = Object.keys(fields);
  if (!keys.length) return;

  const setClauses = keys.map((key, index) => `"${key}" = $${index + 2}`).join(', ');
  const values = keys.map((key) => (fields as any)[key]);

  await db.query(`UPDATE services SET ${setClauses}, updated_at = NOW() WHERE id = $1`, [id, ...values]);
}

export type HardDeleteResult = 'deleted' | 'not_found' | 'still_active';

/**
 * Permanently removes a service — backs DELETE /admin/services/:id. Only
 * allowed once the service is already inactive (deactivate it first via
 * PATCH .../:id { active: false }, see updateService) — same two-step delete
 * as hardDeleteProduct in product.model.ts. Unlike products, no table
 * currently has a foreign key into services, so this never risks a
 * constraint-violation error the way a still-referenced product would.
 */
export async function hardDeleteService(id: number): Promise<HardDeleteResult> {
  const { rows } = await db.query('SELECT active FROM services WHERE id = $1', [id]);
  if (!rows.length) return 'not_found';
  if (rows[0].active) return 'still_active';

  await db.query('DELETE FROM services WHERE id = $1', [id]);
  return 'deleted';
}

/**
 * Finds active services matching a given service_category — the join-key
 * lookup behind getMatchingServicesForProduct in product.model.ts.
 */
export async function getMatchingServicesByCategory(serviceCategory: string): Promise<Service[]> {
  const { rows } = await db.query(
    `${SERVICE_SELECT} WHERE sv.active = true AND sv.service_category = $1 ORDER BY sv.service_base_price ASC`,
    [serviceCategory]
  );
  return rows;
}
