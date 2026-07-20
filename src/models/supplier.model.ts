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
  // Per-row supplier — falls back to the request-level default supplier (the
  // original one-supplier-per-file behavior) when none of these are given.
  supplierId?: number;
  supplierName?: string;
  supplierAddress?: string;
  supplierPhone?: string;
  // Optional attached service (e.g. installation) offered as a WhatsApp
  // follow-up when a customer picks this product. serviceOffered is only
  // ever true when serviceName/servicePrice both parsed successfully — see
  // normalizeRow in product.service.ts.
  serviceOffered?: boolean;
  serviceName?: string;
  servicePrice?: number;
}

/**
 * Core operation: batch updates of parsed CSV/XLSX rows, each optionally
 * carrying its own supplier — a single file can mix products from several
 * suppliers. Rows without per-row supplier info fall back to
 * `defaultSupplierId` (the original single-supplier-per-file behavior).
 * Rows that resolve to no supplier at all are skipped, same as rows missing
 * a reference/name.
 *
 * Purely incremental — insert/update only the rows actually in `items`.
 * Products belonging to the same supplier that this batch doesn't mention
 * are left untouched (an admin uploading a 2-row correction file must not
 * wipe out the rest of that supplier's catalog).
 */
export async function importProductsBatch(
  items: ImportItem[],
  defaultSupplierId: number | null = null
): Promise<{ inserted: number; updated: number; restockNotifications: RestockNotification[] }> {
  let inserted = 0;
  let updated = 0;
  const restockNotifications: RestockNotification[] = [];

  // Resolve each row's supplier id up front — cached by name so the same new
  // supplier name repeated across many rows only gets created once — then
  // group rows by resolved supplier so the sync_logs entry below is per
  // supplier actually present in this file.
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
    if (!supplierId) continue; // no way to resolve a supplier for this row — skip it

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
        // The "prev" CTE captures the pre-statement row state (before this
        // INSERT/UPDATE mutates it), letting us detect a quantity 0→positive
        // restock transition atomically, without a separate SELECT round trip.
        const result = await client.query(
          `WITH prev AS (
             SELECT quantity FROM products WHERE supplier_id = $1 AND reference = $2
           )
           INSERT INTO products (supplier_id, reference, name, price, quantity, service_offered, service_name, service_price, active, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, NOW())
           ON CONFLICT (supplier_id, reference)
           DO UPDATE SET
             name = EXCLUDED.name,
             price = EXCLUDED.price,
             quantity = EXCLUDED.quantity,
             service_offered = EXCLUDED.service_offered,
             service_name = EXCLUDED.service_name,
             service_price = EXCLUDED.service_price,
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
            item.serviceOffered ?? false,
            item.serviceName ?? null,
            item.servicePrice ?? null,
          ]
        );

        const row = result.rows[0];
        if (row?.was_inserted) {
          groupInserted++;
        } else {
          groupUpdated++;

          if (row.previous_quantity === 0 && item.quantity > 0) {
            // Marks every still-unnotified waitlist_requests row for this product as
            // notified in the same statement that reads the phones to message —
            // a re-run of this import can't double-notify the same request.
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

      // Log the synchronization event
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
 * Fetches a supplier's WhatsApp phone number for delivery notifications.
 */
export async function getSupplierPhoneById(supplierId: number): Promise<string | null> {
  const { rows } = await db.query(
    'SELECT phone FROM suppliers WHERE id = $1',
    [supplierId]
  );
  return rows.length ? rows[0].phone : null;
}

/**
 * Finds a supplier by name, or creates one if it doesn't exist yet.
 * Used by the CSV/XLSX file-upload endpoint when the admin (or a row within
 * the file) references a supplier by name instead of an existing id. No
 * unique constraint exists on suppliers.name — this is a plain
 * check-then-insert, acceptable for low-concurrency admin-triggered usage.
 * address/phone only seed a brand-new supplier row — an existing supplier's
 * address/phone is left as-is by an import (see resolveSupplierForProductEdit
 * for editing it after the fact from the product panel).
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
 * Resolves the supplier a product's edited Name/Address/Phone fields should
 * point to — backs the Supplier section of the product detail panel
 * (rede-pecas-admin), the only place an admin can touch supplier data today
 * since there's no dedicated supplier management screen.
 *
 * Deliberately does NOT update the product's current supplier row in place —
 * that row is shared by every other product from the same supplier (see
 * getOrCreateSupplierByName above), so mutating it in place would silently
 * change every other product's listed supplier too, even though the edit
 * form looks like it belongs to just one product. Instead:
 *  - if another *different* supplier already has this exact name, this
 *    product is repointed to that existing row (its address/phone/rating
 *    take over — you're telling the system "this is actually that same
 *    real supplier", the same dedup rule importProductsBatch uses)
 *  - otherwise a brand-new supplier row is created with the submitted
 *    name/address/phone and this product is repointed to it
 * Either way, only the one product being edited is repointed — every other
 * product still on the original supplier row is untouched.
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
