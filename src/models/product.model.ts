import { db } from '../config/db.js';

export interface Product {
  id?: number;
  name: string;
  reference: string;
  price: number;
  quantity: number;
  delivery_time: string;
  supplier?: string;
  supplier_id?: number;
  supplier_rating?: number;
}

/**
 * Searches the inventory for products matching the customer's request by
 * name/brand/reference/synonyms (full-text). Vehicle make/model/year are no
 * longer used to filter results — the compatibility catalog that used to
 * back that matching was never populated by any code path, so this is a
 * deliberate simplification to a purely text-based search.
 * Limits result to top 5 cheapest products.
 */
export async function searchProductsInInventory({
  part,
}: {
  part: string;
}): Promise<Product[]> {
  const { rows } = await db.query(
    `
    SELECT
      p.id,
      p.name,
      p.reference,
      p.price,
      p.quantity,
      p.delivery_time,
      s.name AS supplier,
      s.rating AS supplier_rating
    FROM products p
    JOIN suppliers s ON s.id = p.supplier_id
    WHERE
      p.quantity > 0
      AND p.active = true
      AND p.search_vector @@ plainto_tsquery('portuguese', unaccent($1))
    ORDER BY
      p.price ASC,
      s.rating DESC
    LIMIT 5
    `,
    [part]
  );
  return rows;
}

/**
 * Appends a phone to a product's waitlist (idempotent — no duplicate entries).
 */
export async function addToProductWaitlist(productId: number, phone: string): Promise<void> {
  await db.query(
    `UPDATE products
     SET waitlist_phones = CASE
       WHEN $2 = ANY(waitlist_phones) THEN waitlist_phones
       ELSE array_append(waitlist_phones, $2)
     END
     WHERE id = $1`,
    [productId, phone]
  );
}

/**
 * Finds an out-of-stock product matching the requested part, so a waitlist
 * opt-in has somewhere to attach the customer's phone. Not vehicle-aware —
 * a part with no product row at all (never stocked) can't be waitlisted
 * under this design; the common case (a stocked product hitting zero) is
 * fully covered.
 */
export async function findZeroQuantityProductMatch({
  part,
}: {
  part: string;
}): Promise<{ id: number; name: string } | null> {
  const { rows } = await db.query(
    `SELECT id, name
     FROM products
     WHERE quantity = 0
       AND active = true
       AND search_vector @@ plainto_tsquery('portuguese', unaccent($1))
     ORDER BY updated_at DESC
     LIMIT 1`,
    [part]
  );
  return rows.length ? rows[0] : null;
}
