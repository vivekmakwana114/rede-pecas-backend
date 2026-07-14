import { db } from '../config/db.js';
import { logger } from '../config/logger.js';

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
  service_offered?: boolean;
  service_name?: string;
  service_price?: number;
}

/**
 * Builds an OR-of-terms tsquery from raw customer text: to_tsvector on the input
 * applies the same tokenizing/stemming/stopword-removal as the search_vector
 * column (config must match search_vector's — 'english' as of 2026-07-14, see
 * schema.sql; was 'portuguese' before catalog data switched to English), then
 * the resulting lexemes are joined with '|' instead of AND-ing them
 * (plainto_tsquery's default). AND-ing was the bug — a customer message always
 * carries filler words ("I need...", "para o meu...") that aren't in the
 * stopword list for whichever config is active, so plainto_tsquery required
 * the product to literally contain "need"/"para" etc. and matched nothing.
 * OR-ing means any one real keyword overlap (e.g. "oil"/"filter") is enough —
 * customers can phrase the request however they want.
 */
const OR_TSQUERY = `to_tsquery('english', array_to_string(tsvector_to_array(to_tsvector('english', unaccent($1))), ' | '))`;

/**
 * Searches the inventory for products matching the customer's request by
 * name/brand/reference/synonyms (full-text). Vehicle make/model/year are no
 * longer used to filter results — the compatibility catalog that used to
 * back that matching was never populated by any code path, so this is a
 * deliberate simplification to a purely text-based search.
 * Limits result to top 3 cheapest products.
 */
export async function searchProductsInInventory({
  part,
  excludeProductId,
}: {
  part: string;
  // Excludes a specific product from results — used when re-searching for
  // alternatives after the admin marked that exact product unavailable, so
  // it can't show back up as one of its own "alternatives".
  excludeProductId?: number;
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
      p.service_offered,
      p.service_name,
      p.service_price,
      p.supplier_id,
      s.name AS supplier,
      s.rating AS supplier_rating
    FROM products p
    JOIN suppliers s ON s.id = p.supplier_id
    WHERE
      p.quantity > 0
      AND p.active = true
      AND p.search_vector @@ ${OR_TSQUERY}
      AND ($2::int IS NULL OR p.id != $2)
    ORDER BY
      p.price ASC,
      s.rating DESC
    LIMIT 3
    `,
    [part, excludeProductId ?? null]
  );
  logger.debug(`[PRODUCT SEARCH] query="${part}" matches=${rows.length}`);
  return rows;
}

/**
 * Registers a customer's request to be notified when a product is restocked
 * (idempotent — ON CONFLICT DO NOTHING on the (product_id, customer_phone)
 * unique pair, so a repeat opt-in is a no-op rather than a duplicate row).
 */
export async function addToProductWaitlist(productId: number, phone: string): Promise<void> {
  await db.query(
    `INSERT INTO waitlist_requests (product_id, customer_phone)
     VALUES ($1, $2)
     ON CONFLICT (product_id, customer_phone) DO NOTHING`,
    [productId, phone]
  );
}

/**
 * Fetches a single active product by id, joined with its supplier — used both
 * to build the restock-notification message (price/supplier) and to actually
 * create the order once the customer taps "Order now".
 */
export async function getProductById(id: number): Promise<Product | null> {
  const { rows } = await db.query(
    `SELECT
      p.id,
      p.name,
      p.reference,
      p.price,
      p.quantity,
      p.delivery_time,
      p.service_offered,
      p.service_name,
      p.service_price,
      p.supplier_id,
      s.name AS supplier,
      s.rating AS supplier_rating
    FROM products p
    JOIN suppliers s ON s.id = p.supplier_id
    WHERE p.id = $1 AND p.active = true`,
    [id]
  );
  return rows.length ? rows[0] : null;
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
       AND search_vector @@ ${OR_TSQUERY}
     ORDER BY updated_at DESC
     LIMIT 1`,
    [part]
  );
  return rows.length ? rows[0] : null;
}
