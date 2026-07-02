import { db } from '../config/db.js';

/**
 * Core operation: Batch updates of parsed Excel shop items.
 * Performs clean upsert mapping to supplier_id and SKU reference.
 */
export async function importProductsBatch(
  supplierId: number,
  items: { reference: string; name: string; price: number; quantity: number }[]
): Promise<{ inserted: number; updated: number; deactivated: number }> {
  let inserted = 0;
  let updated = 0;

  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const receivedReferences = new Set(items.map((i) => i.reference));

    for (const item of items) {
      if (!item.reference || !item.name) continue;

      const result = await client.query(
        `INSERT INTO products (supplier_id, reference, name, price, quantity, active, updated_at)
         VALUES ($1, $2, $3, $4, $5, true, NOW())
         ON CONFLICT (supplier_id, reference)
         DO UPDATE SET
           name = EXCLUDED.name,
           price = EXCLUDED.price,
           quantity = EXCLUDED.quantity,
           active = true,
           updated_at = NOW()
         RETURNING (xmax = 0) AS was_inserted`,
        [supplierId, item.reference, item.name, item.price, item.quantity]
      );

      if (result.rows[0]?.was_inserted) {
        inserted++;
      } else {
        updated++;
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

    return { inserted, updated, deactivated };
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
