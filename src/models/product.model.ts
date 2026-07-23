import { db } from '../config/db.js';
import { logger } from '../config/logger.js';
import { getMatchingServicesByCategory, Service } from './service.model.js';

export interface Product {
  id?: number;
  name: string;
  reference: string;
  price: number;
  quantity: number;
  brand?: string | null;
  oem_reference?: string | null;
  synonyms?: string;
  category_keywords?: string | null;
  description?: string;
  unit?: string;
  category?: string;
  subcategory?: string;
  service_category?: string;
  vehicle_make?: string;
  vehicle_model?: string | null;
  year_start?: number | null;
  year_end?: number | null;
  engine?: string | null;
  delivery_time?: string;
  engine_number?: string | null;
  viscosity?: string | null;
  engine_type?: string | null;
  volume_liters?: number | null;
  specification?: string | null;
  interval_km?: number | null;
  image_url?: string | null;
  active?: boolean;
  supplier?: string;
  supplier_id?: number;
  supplier_rating?: number;
  supplier_address?: string;
  supplier_phone?: string;
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

// How many text-matching candidates to pull from the DB before the vehicle
// hard-filter (applied in JS below) narrows them down to the top 3 actually
// shown to the customer. Bounded rather than unlimited — the catalog is
// still low hundreds of rows (see getAllProducts), so this comfortably
// covers every text match without loading the whole table.
const SEARCH_CANDIDATE_LIMIT = 50;

/**
 * A product's vehicle_make/vehicle_model can be a single value, a
 * slash-joined compound ("Hyundai/Kia" — parts shared across a platform), or
 * a generic wildcard meaning "fits anything" ("Various", "Universal", or
 * "Aftermarket" — a non-OEM part with no single-vehicle restriction; see the
 * 2026-07-22 data-fix note near the products table in schema.sql for the
 * data-quality issue this specifically works around). Matches loosely
 * (case-insensitive, substring either direction) so minor wording
 * differences between the catalog and a decoded/manually-entered customer
 * vehicle don't produce false negatives.
 */
function vehicleFieldMatches(productValue: string | null | undefined, customerValue: string | null | undefined): boolean {
  if (!productValue) return true; // no restriction recorded — treat as compatible
  if (!customerValue) return true; // nothing to compare against — don't exclude on missing customer data
  const options = productValue.split('/').map((s) => s.trim().toLowerCase());
  if (options.some((o) => o === 'various' || o === 'universal' || o === 'aftermarket')) return true;
  const target = customerValue.trim().toLowerCase();
  return options.some((o) => o === target || o.includes(target) || target.includes(o));
}

/**
 * year_start/year_end define an inclusive compatibility range; either bound
 * (or both) can be null, meaning "no restriction" on that side. A customer
 * vehicle year that doesn't parse as a number (rare manual-entry/OCR case)
 * is treated the same as "unknown" — don't exclude on data we can't compare.
 */
function vehicleYearMatches(yearStart: number | null | undefined, yearEnd: number | null | undefined, customerYear: string | null | undefined): boolean {
  const year = customerYear ? Number(customerYear) : NaN;
  if (Number.isNaN(year)) return true;
  if (yearStart != null && year < yearStart) return false;
  if (yearEnd != null && year > yearEnd) return false;
  return true;
}

export interface SearchVehicle {
  make: string;
  model: string;
  year: string;
}

/**
 * Searches the inventory for products matching the customer's request by
 * name/brand/reference/synonyms (full-text), then — when a vehicle is given
 * — hard-filters to only the products actually compatible with it
 * (vehicle_make/vehicle_model/year_start/year_end), matched loosely (see
 * vehicleFieldMatches/vehicleYearMatches) so generic catalog values
 * ("Various", compound makes) don't produce spurious mismatches. Without a
 * vehicle, falls back to the pre-2026-07 purely text-based behavior. Limits
 * result to top 3 cheapest compatible products.
 */
export async function searchProductsInInventory({
  part,
  vehicle,
  excludeProductId,
}: {
  part: string;
  // The customer's registered vehicle — when given, results are hard-filtered
  // to compatible products only (see vehicleFieldMatches/vehicleYearMatches).
  vehicle?: SearchVehicle | null;
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
      p.service_category,
      p.vehicle_make,
      p.vehicle_model,
      p.year_start,
      p.year_end,
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
    LIMIT ${SEARCH_CANDIDATE_LIMIT}
    `,
    [part, excludeProductId ?? null]
  );

  const compatible = vehicle
    ? rows.filter(
        (p: Product) =>
          vehicleFieldMatches(p.vehicle_make, vehicle.make) &&
          vehicleFieldMatches(p.vehicle_model, vehicle.model) &&
          vehicleYearMatches(p.year_start, p.year_end, vehicle.year)
      )
    : rows;

  const results = compatible.slice(0, 3);
  logger.debug(`[PRODUCT SEARCH] query="${part}" vehicle=${vehicle ? `${vehicle.make} ${vehicle.model} ${vehicle.year}` : 'none'} candidates=${rows.length} compatible=${compatible.length} returned=${results.length}`);
  return results;
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
 * Fetches every product (active and inactive), joined with its supplier —
 * backs the admin panel's inventory grid (GET /admin/products). Includes
 * inactive rows (unlike the customer-facing search/lookup functions above)
 * so the admin can find and reactivate a deactivated product — see
 * updateProduct's `active` field and getProductByIdAnyStatus below. Newest
 * first, matching the other admin list endpoints' default ordering (e.g.
 * orders).
 */
export async function getAllProducts(): Promise<Product[]> {
  const { rows } = await db.query(
    `SELECT
      p.id,
      p.name,
      p.brand,
      p.reference,
      p.oem_reference,
      p.synonyms,
      p.description,
      p.category,
      p.subcategory,
      p.service_category,
      p.vehicle_make,
      p.vehicle_model,
      p.year_start,
      p.year_end,
      p.engine,
      p.delivery_time,
      p.engine_number,
      p.viscosity,
      p.engine_type,
      p.volume_liters,
      p.specification,
      p.interval_km,
      p.image_url,
      p.price,
      p.quantity,
      p.active,
      p.supplier_id,
      s.name AS supplier,
      s.rating AS supplier_rating,
      s.province AS supplier_address,
      s.phone AS supplier_phone
    FROM products p
    JOIN suppliers s ON s.id = p.supplier_id
    ORDER BY p.updated_at DESC`
  );
  return rows;
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
      p.brand,
      p.reference,
      p.oem_reference,
      p.synonyms,
      p.description,
      p.category,
      p.subcategory,
      p.service_category,
      p.vehicle_make,
      p.vehicle_model,
      p.year_start,
      p.year_end,
      p.engine,
      p.delivery_time,
      p.engine_number,
      p.viscosity,
      p.engine_type,
      p.volume_liters,
      p.specification,
      p.interval_km,
      p.image_url,
      p.price,
      p.quantity,
      p.active,
      p.supplier_id,
      s.name AS supplier,
      s.rating AS supplier_rating,
      s.province AS supplier_address,
      s.phone AS supplier_phone
    FROM products p
    JOIN suppliers s ON s.id = p.supplier_id
    WHERE p.id = $1 AND p.active = true`,
    [id]
  );
  return rows.length ? rows[0] : null;
}

/**
 * Same lookup as getProductById, but without the active filter — used by
 * the admin panel (GET/PATCH /admin/products/:id) so a deactivated product
 * can still be viewed and re-activated (via updateProduct's `active`
 * field), unlike every customer-facing caller of getProductById above,
 * which must never resolve an inactive product.
 */
export async function getProductByIdAnyStatus(id: number): Promise<Product | null> {
  const { rows } = await db.query(
    `SELECT
      p.id,
      p.name,
      p.brand,
      p.reference,
      p.oem_reference,
      p.synonyms,
      p.description,
      p.category,
      p.subcategory,
      p.service_category,
      p.vehicle_make,
      p.vehicle_model,
      p.year_start,
      p.year_end,
      p.engine,
      p.delivery_time,
      p.engine_number,
      p.viscosity,
      p.engine_type,
      p.volume_liters,
      p.specification,
      p.interval_km,
      p.image_url,
      p.price,
      p.quantity,
      p.active,
      p.supplier_id,
      s.name AS supplier,
      s.rating AS supplier_rating,
      s.province AS supplier_address,
      s.phone AS supplier_phone
    FROM products p
    JOIN suppliers s ON s.id = p.supplier_id
    WHERE p.id = $1`,
    [id]
  );
  return rows.length ? rows[0] : null;
}

/**
 * Finds the services relevant to a given product, via the shared
 * service_category join key (see db/schema.sql products/services tables).
 * Returns an empty array if the product doesn't exist or has no
 * service_category set.
 */
export async function getMatchingServicesForProduct(productId: number): Promise<Service[]> {
  const { rows } = await db.query('SELECT service_category FROM products WHERE id = $1', [productId]);
  if (!rows.length || !rows[0].service_category) return [];
  return getMatchingServicesByCategory(rows[0].service_category);
}

/**
 * Admin edits to a product's catalog/stock fields — backs PATCH
 * /admin/products/:id. supplier_id is intentionally not editable here:
 * reassigning it would change the row's UNIQUE (supplier_id, reference)
 * identity, which is out of scope for a simple field edit.
 */
export async function updateProduct(id: number, fields: Partial<Product>): Promise<void> {
  const keys = Object.keys(fields);
  if (!keys.length) return;

  const setClauses = keys.map((key, index) => `"${key}" = $${index + 2}`).join(', ');
  const values = keys.map((key) => (fields as any)[key]);

  await db.query(
    `UPDATE products SET ${setClauses}, updated_at = NOW() WHERE id = $1`,
    [id, ...values]
  );
}

export type HardDeleteResult = 'deleted' | 'not_found' | 'still_active';

/**
 * Permanently removes a product — backs DELETE /admin/products/:id. Only
 * allowed once the product is already inactive (deactivate it first via
 * PATCH .../:id { active: false }, see updateProduct) — a two-step delete so
 * an admin can't accidentally wipe a product still live in the customer-facing
 * catalog. Doesn't catch the foreign-key violation a still-referenced product
 * (an existing order or waitlist_requests row) would throw on the DELETE
 * itself — see deleteProductHandler for that.
 */
export async function hardDeleteProduct(id: number): Promise<HardDeleteResult> {
  const { rows } = await db.query('SELECT active FROM products WHERE id = $1', [id]);
  if (!rows.length) return 'not_found';
  if (rows[0].active) return 'still_active';

  await db.query('DELETE FROM products WHERE id = $1', [id]);
  return 'deleted';
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
