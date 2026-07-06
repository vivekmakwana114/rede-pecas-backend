import { db } from '../config/db.js';

export interface RestockNotification {
  productId: number;
  productName: string;
  phones: string[];
}

/**
 * Core operation: Batch updates of parsed Excel shop items.
 * Performs clean upsert mapping to supplier_id and SKU reference.
 */
export async function importProductsBatch(
  supplierId: number,
  items: { reference: string; name: string; price: number; quantity: number }[]
): Promise<{ inserted: number; updated: number; deactivated: number; restockNotifications: RestockNotification[] }> {
  let inserted = 0;
  let updated = 0;
  const restockNotifications: RestockNotification[] = [];

  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const receivedReferences = new Set(items.map((i) => i.reference));

    for (const item of items) {
      if (!item.reference || !item.name) continue;

      // The "prev" CTE captures the pre-statement row state (before this
      // INSERT/UPDATE mutates it), letting us detect a quantity 0→positive
      // restock transition atomically, without a separate SELECT round trip.
      const result = await client.query(
        `WITH prev AS (
           SELECT quantity, waitlist_phones FROM products WHERE supplier_id = $1 AND reference = $2
         )
         INSERT INTO products (supplier_id, reference, name, price, quantity, active, updated_at)
         VALUES ($1, $2, $3, $4, $5, true, NOW())
         ON CONFLICT (supplier_id, reference)
         DO UPDATE SET
           name = EXCLUDED.name,
           price = EXCLUDED.price,
           quantity = EXCLUDED.quantity,
           active = true,
           updated_at = NOW()
         RETURNING
           id,
           (xmax = 0) AS was_inserted,
           (SELECT quantity FROM prev) AS previous_quantity,
           (SELECT waitlist_phones FROM prev) AS previous_waitlist_phones`,
        [supplierId, item.reference, item.name, item.price, item.quantity]
      );

      const row = result.rows[0];
      if (row?.was_inserted) {
        inserted++;
      } else {
        updated++;

        if (row.previous_quantity === 0 && item.quantity > 0) {
          const phones: string[] = row.previous_waitlist_phones || [];
          if (phones.length) {
            restockNotifications.push({ productId: row.id, productName: item.name, phones });
            await client.query(`UPDATE products SET waitlist_phones = '{}' WHERE id = $1`, [row.id]);
          }
        }
      }
    }

    // Deactivate items from this supplier that are missing in the new document import
    const deactivatedResult = await client.query(
      `UPDATE products
       SET active = false, quantity = 0, updated_at = NOW()
       WHERE supplier_id = $1
         AND active = true
         AND reference != ALL($2::text[])`,
      [supplierId, [...receivedReferences]]
    );

    const deactivated = deactivatedResult.rowCount || 0;

    await client.query("COMMIT");

    // Log the synchronization event
    await db.query(
      `INSERT INTO sync_logs (supplier_id, inserted_count, updated_count, deactivated_count, created_at)
       VALUES ($1, $2, $3, $4, NOW())`,
      [supplierId, inserted, updated, deactivated]
    );

    return { inserted, updated, deactivated, restockNotifications };
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
 * Used by the CSV/XLSX file-upload endpoint when the admin references a
 * supplier by name instead of an existing id. No unique constraint exists
 * on suppliers.name/nif — this is a plain check-then-insert, acceptable
 * for low-concurrency admin-triggered usage.
 */
export async function getOrCreateSupplierByName(
  name: string,
  nif?: string | null,
  province?: string | null
): Promise<number> {
  const { rows } = await db.query(
    'SELECT id FROM suppliers WHERE name ILIKE $1 LIMIT 1',
    [name]
  );
  if (rows.length) return rows[0].id;

  const inserted = await db.query(
    'INSERT INTO suppliers (name, nif, province) VALUES ($1, $2, $3) RETURNING id',
    [name, nif || null, province || null]
  );
  return inserted.rows[0].id;
}
