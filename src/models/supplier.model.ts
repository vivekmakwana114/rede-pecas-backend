import { db } from '../config/db.js';

export interface RestockNotification {
  productId: number;
  productName: string;
  phones: string[];
}

export interface ImportItem {
  reference: string;
  name: string;
  price: number;
  quantity: number;
  supplierId?: number;
  supplierName?: string;
  supplierAddress?: string;
  supplierPhone?: string;
  category: string;
  subcategory: string;
  serviceCategory: string;
  vehicleMake: string;
  vehicleModel?: string;
  yearStart?: number;
  yearEnd?: number;
  engine?: string;
  deliveryTime: string;
  brand?: string;
  oemReference?: string;
  engineNumber?: string;
  viscosity?: string;
  engineType?: string;
  volumeLiters?: number;
  specification?: string;
  intervalKm?: number;
  imageUrl?: string;
  synonyms: string;
  description: string;
}

/**
 * Bulk-upserts a batch of inventory items into `products` (grouped by resolved
 * supplier, creating suppliers as needed), all inside one transaction, logging each supplier's insert/update counts
 * to `sync_logs` and collecting restock notifications for waitlisted customers when a zero-quantity item is restocked.
 */
export async function importProductsBatch(
  items: ImportItem[],
  defaultSupplierId: number | null = null
): Promise<{ inserted: number; updated: number; restockNotifications: RestockNotification[] }> {
  let inserted = 0;
  let updated = 0;
  const restockNotifications: RestockNotification[] = [];

  const supplierCache = new Map<string, number>();
  const bySupplier = new Map<number, ImportItem[]>();

  for (const item of items) {
    if (!item.reference || !item.name) continue;

    let supplierId = item.supplierId ?? null;

    if (!supplierId && item.supplierName) {
      const cacheKey = item.supplierName.toLowerCase();
      supplierId = supplierCache.get(cacheKey) ?? null;
      if (!supplierId) {
        supplierId = await getOrCreateSupplierByName(item.supplierName, item.supplierAddress, item.supplierPhone);
        supplierCache.set(cacheKey, supplierId);
      }
    }

    if (!supplierId) supplierId = defaultSupplierId;
    if (!supplierId) continue;

    const group = bySupplier.get(supplierId) || [];
    group.push(item);
    bySupplier.set(supplierId, group);
  }

  const client = await db.connect();
  try {
    await client.query("BEGIN");

    for (const [supplierId, supplierItems] of bySupplier) {
      let groupInserted = 0;
      let groupUpdated = 0;

      for (const item of supplierItems) {
        const result = await client.query(
          `WITH prev AS (
             SELECT quantity FROM products WHERE supplier_id = $1 AND reference = $2
           )
           INSERT INTO products (
             supplier_id, reference, name, price, quantity,
             category, subcategory, service_category, vehicle_make, vehicle_model, year_start, year_end, engine,
             delivery_time, brand, oem_reference, engine_number, viscosity, engine_type, volume_liters,
             specification, interval_km, image_url, synonyms, description, active, updated_at
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, true, NOW())
           ON CONFLICT (supplier_id, reference)
           DO UPDATE SET
             name = EXCLUDED.name,
             price = EXCLUDED.price,
             quantity = EXCLUDED.quantity,
             category = EXCLUDED.category,
             subcategory = EXCLUDED.subcategory,
             service_category = EXCLUDED.service_category,
             vehicle_make = EXCLUDED.vehicle_make,
             vehicle_model = EXCLUDED.vehicle_model,
             year_start = EXCLUDED.year_start,
             year_end = EXCLUDED.year_end,
             engine = EXCLUDED.engine,
             delivery_time = EXCLUDED.delivery_time,
             brand = EXCLUDED.brand,
             oem_reference = EXCLUDED.oem_reference,
             engine_number = EXCLUDED.engine_number,
             viscosity = EXCLUDED.viscosity,
             engine_type = EXCLUDED.engine_type,
             volume_liters = EXCLUDED.volume_liters,
             specification = EXCLUDED.specification,
             interval_km = EXCLUDED.interval_km,
             image_url = EXCLUDED.image_url,
             synonyms = EXCLUDED.synonyms,
             description = EXCLUDED.description,
             active = true,
             updated_at = NOW()
           RETURNING
             id,
             (xmax = 0) AS was_inserted,
             (SELECT quantity FROM prev) AS previous_quantity`,
          [
            supplierId,
            item.reference,
            item.name,
            item.price,
            item.quantity,
            item.category,
            item.subcategory,
            item.serviceCategory,
            item.vehicleMake,
            item.vehicleModel ?? null,
            item.yearStart ?? null,
            item.yearEnd ?? null,
            item.engine ?? null,
            item.deliveryTime,
            item.brand ?? null,
            item.oemReference ?? null,
            item.engineNumber ?? null,
            item.viscosity ?? null,
            item.engineType ?? null,
            item.volumeLiters ?? null,
            item.specification ?? null,
            item.intervalKm ?? null,
            item.imageUrl ?? null,
            item.synonyms,
            item.description,
          ]
        );

        const row = result.rows[0];
        if (row?.was_inserted) {
          groupInserted++;
        } else {
          groupUpdated++;

          if (row.previous_quantity === 0 && item.quantity > 0) {
            const waitlisted = await client.query(
              `UPDATE waitlist_requests
               SET notified_at = NOW()
               WHERE product_id = $1 AND notified_at IS NULL
               RETURNING customer_phone`,
              [row.id]
            );
            const phones: string[] = waitlisted.rows.map((r) => r.customer_phone);
            if (phones.length) {
              restockNotifications.push({ productId: row.id, productName: item.name, phones });
            }
          }
        }
      }

      await client.query(
        `INSERT INTO sync_logs (supplier_id, inserted_count, updated_count, created_at)
         VALUES ($1, $2, $3, NOW())`,
        [supplierId, groupInserted, groupUpdated]
      );

      inserted += groupInserted;
      updated += groupUpdated;
    }

    await client.query("COMMIT");

    return { inserted, updated, restockNotifications };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Looks up a single supplier's phone number from `suppliers` by id, used to
 * send the supplier a delivery notice.
 */
export async function getSupplierPhoneById(supplierId: number): Promise<string | null> {
  const { rows } = await db.query(
    'SELECT phone FROM suppliers WHERE id = $1',
    [supplierId]
  );
  return rows.length ? rows[0].phone : null;
}

/**
 * Finds an existing `suppliers` row by case-insensitive name match, or inserts
 * a new one with the given address/phone if none exists. Returns the supplier id either way.
 */
export async function getOrCreateSupplierByName(
  name: string,
  address?: string | null,
  phone?: string | null
): Promise<number> {
  const { rows } = await db.query(
    'SELECT id FROM suppliers WHERE name ILIKE $1 LIMIT 1',
    [name]
  );
  if (rows.length) return rows[0].id;

  const inserted = await db.query(
    'INSERT INTO suppliers (name, province, phone) VALUES ($1, $2, $3) RETURNING id',
    [name, address || null, phone || null]
  );
  return inserted.rows[0].id;
}

/**
 * Finds an existing `suppliers` row by name (excluding the product's current
 * supplier), or inserts a new one, used when an admin edit changes a product's supplier details.
 */
export async function resolveSupplierForProductEdit(
  name: string,
  address: string | null,
  phone: string | null,
  currentSupplierId: number
): Promise<number> {
  const { rows } = await db.query(
    'SELECT id FROM suppliers WHERE name ILIKE $1 AND id != $2 LIMIT 1',
    [name, currentSupplierId]
  );
  if (rows.length) return rows[0].id;

  const inserted = await db.query(
    'INSERT INTO suppliers (name, province, phone) VALUES ($1, $2, $3) RETURNING id',
    [name, address || null, phone || null]
  );
  return inserted.rows[0].id;
}
