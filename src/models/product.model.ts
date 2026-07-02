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
 * Searches the unified inventory for compatible products.
 * Limits result to top 5 cheapest products.
 */
export async function searchProductsInInventory({
  part,
  vehicle_make,
  model,
  year,
}: {
  part: string;
  vehicle_make?: string | null;
  model?: string | null;
  year?: string | null;
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
    JOIN compatibilities c ON c.product_id = p.id
    JOIN vehicles v ON v.id = c.vehicle_id
    WHERE
      p.quantity > 0
      AND p.active = true
      AND p.search_vector @@ plainto_tsquery('portuguese', unaccent($1))
      AND (
        v.make ILIKE $2 OR $2 IS NULL
      )
      AND (
        v.model ILIKE $3 OR $3 IS NULL
      )
      AND (
        v.year_from <= $4::int AND v.year_to >= $4::int
        OR $4 IS NULL
      )
    ORDER BY
      p.price ASC,
      s.rating DESC
    LIMIT 5
    `,
    [part, vehicle_make || null, model || null, year ? parseInt(year, 10) : null]
  );
  return rows;
}

/**
 * Registers a waitlist entry when a product is out of stock.
 */
export async function addToWaitlist({
  phone,
  product,
  vehicle_make,
  model,
  year,
  engineNumber
}: {
  phone: string;
  product: string;
  vehicle_make?: string | null;
  model?: string | null;
  year?: string | null;
  engineNumber?: string | null;
}): Promise<void> {
  await db.query(
    `INSERT INTO waitlist_requests (phone, product_name, vehicle_make, vehicle_model, vehicle_year, engine_number, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
    [phone, product, vehicle_make || null, model || null, year || null, engineNumber || null]
  );
}
