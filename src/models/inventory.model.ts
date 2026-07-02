import { db } from '../config/db.js';

export interface PartItem {
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

export interface VehicleSession {
  phone: string;
  vin: string | null;
  make: string;
  model: string;
  year: string;
  engine_number: string | null;
  license_plate: string | null;
  engine_size: string | null;
  fuel_type: string | null;
  updated_at: Date;
}

export interface ManualCollection {
  phone: string;
  status: string;
  attempted_vin: string | null;
  make: string | null;
  model: string | null;
  year: string | null;
  engine_number: string | null;
  created_at: Date;
}

export interface AdminOrderInfo {
  number: string;
  customer: string;
  part: string;
  reference: string;
  supplier: string;
  price: number;
  created_at: Date;
  time: string;
  has_proof: boolean;
  payment_method?: string;
  requires_proof?: boolean;
}

/**
 * Searches the unified inventory for compatible parts.
 * Limits result to top 5 cheapest parts.
 */
export async function searchPartsInInventory({
  part,
  vehicle_make,
  model,
  year,
}: {
  part: string;
  vehicle_make?: string | null;
  model?: string | null;
  year?: string | null;
}): Promise<PartItem[]> {
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
    FROM parts p
    JOIN suppliers s ON s.id = p.supplier_id
    JOIN compatibilities c ON c.part_id = p.id
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
 * Registers a waitlist entry when a part is out of stock.
 */
export async function addToWaitlist({
  phone,
  part,
  vehicle_make,
  model,
  year,
  engineNumber
}: {
  phone: string;
  part: string;
  vehicle_make?: string | null;
  model?: string | null;
  year?: string | null;
  engineNumber?: string | null;
}): Promise<void> {
  await db.query(
    `INSERT INTO waitlist_requests (phone, part_name, vehicle_make, vehicle_model, vehicle_year, engine_number, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
    [phone, part, vehicle_make || null, model || null, year || null, engineNumber || null]
  );
}

/**
 * Retrieves the customer's active vehicle session (expires after 4 hours).
 */
export async function getCustomerVehicle(phone: string): Promise<VehicleSession | null> {
  const { rows } = await db.query(
    `SELECT * FROM vehicle_sessions
     WHERE phone = $1
       AND updated_at > NOW() - INTERVAL '4 hours'`,
    [phone]
  );
  return rows.length ? rows[0] : null;
}

/**
 * Saves/updates a vehicle session for a customer.
 */
export async function saveVehicleSession(
  phone: string,
  data: Partial<VehicleSession>
): Promise<void> {
  await db.query(
    `INSERT INTO vehicle_sessions
       (phone, vin, make, model, year, engine_number, license_plate, engine_size, fuel_type, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
     ON CONFLICT (phone)
     DO UPDATE SET
       vin = COALESCE($2, vehicle_sessions.vin),
       make = COALESCE($3, vehicle_sessions.make),
       model = COALESCE($4, vehicle_sessions.model),
       year = COALESCE($5, vehicle_sessions.year),
       engine_number = COALESCE($6, vehicle_sessions.engine_number),
       license_plate = COALESCE($7, vehicle_sessions.license_plate),
       engine_size = COALESCE($8, vehicle_sessions.engine_size),
       fuel_type = COALESCE($9, vehicle_sessions.fuel_type),
       updated_at = NOW()`,
    [
      phone,
      data.vin || null,
      data.make || null,
      data.model || null,
      data.year || null,
      data.engine_number || null,
      data.license_plate || null,
      data.engine_size || null,
      data.fuel_type || null,
    ]
  );
}

/**
 * Deletes vehicle session.
 */
export async function clearVehicleSession(phone: string): Promise<void> {
  await db.query("DELETE FROM vehicle_sessions WHERE phone = $1", [phone]);
}

/**
 * Saves a decoded VIN response in cache.
 */
export async function saveVinCache(
  vin: string,
  data: {
    make: string;
    model: string;
    year: string;
    vehicle_type?: string | null;
    engine?: string | null;
    fuel_type?: string | null;
    manufacture_country?: string | null;
  }
): Promise<void> {
  await db.query(
    `INSERT INTO vin_cache (vin, make, model, year, vehicle_type, engine, fuel_type, manufacture_country)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (vin) DO NOTHING`,
    [
      vin.toUpperCase(),
      data.make,
      data.model,
      data.year,
      data.vehicle_type || null,
      data.engine || null,
      data.fuel_type || null,
      data.manufacture_country || null,
    ]
  );
}

/**
 * Fetches cached VIN response.
 */
export async function getVinCache(vin: string): Promise<any | null> {
  const { rows } = await db.query(
    "SELECT * FROM vin_cache WHERE vin = $1",
    [vin.toUpperCase()]
  );
  return rows.length ? rows[0] : null;
}

/**
 * Begins a manual vehicle details collection process.
 */
export async function startManualCollection(phone: string, status: string, attemptedVin: string | null = null): Promise<void> {
  await db.query(
    `INSERT INTO manual_vehicle_collections (phone, status, attempted_vin, created_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (phone)
     DO UPDATE SET status = $2, attempted_vin = $3, make = NULL,
                   model = NULL, year = NULL, engine_number = NULL,
                   created_at = NOW()`,
    [phone, status, attemptedVin]
  );
}

/**
 * Returns ongoing manual details collection process state.
 */
export async function getActiveManualCollection(phone: string): Promise<ManualCollection | null> {
  const { rows } = await db.query(
    `SELECT * FROM manual_vehicle_collections
     WHERE phone = $1
       AND status != 'complete'
       AND created_at > NOW() - INTERVAL '30 minutes'`,
    [phone]
  );
  return rows.length ? rows[0] : null;
}

/**
 * Updates manual collection state values.
 */
export async function updateManualCollection(phone: string, fields: Partial<ManualCollection>): Promise<void> {
  const keys = Object.keys(fields);
  if (!keys.length) return;

  const setClauses = keys.map((key, index) => `"${key}" = $${index + 2}`).join(', ');
  const values = keys.map((key) => (fields as any)[key]);

  await db.query(
    `UPDATE manual_vehicle_collections SET ${setClauses} WHERE phone = $1`,
    [phone, ...values]
  );
}

/**
 * Inserts a new order into the orders log.
 */
export async function createOrder(
  orderNumber: string,
  phone: string,
  item: PartItem
): Promise<void> {
  await db.query(
    `INSERT INTO orders (number, customer_phone, part_id, supplier_id, quantity, unit_price, status, created_at)
     VALUES ($1, $2, $3, $4, 1, $5, 'awaiting_payment', NOW())`,
    [orderNumber, phone, item.id, item.supplier_id, item.price]
  );
}

/**
 * Fetches last pending order waiting for billing selection or verification.
 */
export async function getLatestOrderByStatus(phone: string, statuses: string[]): Promise<any | null> {
  const { rows } = await db.query(
    `SELECT * FROM orders
     WHERE customer_phone = $1
       AND status = ANY($2::text[])
     ORDER BY created_at DESC LIMIT 1`,
    [phone, statuses]
  );
  return rows.length ? rows[0] : null;
}

/**
 * Updates status of a given order.
 */
export async function updateOrderStatus(orderNumber: string, status: string, additionalFields: any = {}): Promise<void> {
  const setClauses = [`status = $2`, `updated_at = NOW()`];
  const params: any[] = [orderNumber, status];

  if (additionalFields.approved_by) {
    setClauses.push(`approved_by = $${setClauses.length + 2}`);
    params.push(additionalFields.approved_by);
    setClauses.push(`approved_at = NOW()`);
  }

  if (additionalFields.payment_method) {
    setClauses.push(`payment_method = $${setClauses.length + 2}`);
    params.push(additionalFields.payment_method);
  }

  await db.query(
    `UPDATE orders SET ${setClauses.join(', ')} WHERE number = $1`,
    params
  );
}

/**
 * Registers customer payment proof metadata.
 */
export async function savePaymentProof(orderNumber: string, mediaId: string, mediaType: string | null = null): Promise<void> {
  await db.query(
    `INSERT INTO payment_proofs (order_number, media_id, media_type, created_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (order_number) DO UPDATE SET media_id = $2, media_type = $3`,
    [orderNumber, mediaId, mediaType]
  );
}

/**
 * Increments and issues a unique order document serial (RP-YYYY-XXXXX).
 */
export async function generateOrderNumber(): Promise<string> {
  const year = new Date().getFullYear();
  const result = await db.query(
    `INSERT INTO order_counters (year, last_number)
     VALUES ($1, 1)
     ON CONFLICT (year)
     DO UPDATE SET last_number = order_counters.last_number + 1
     RETURNING last_number`,
    [year]
  );
  const sequence = result.rows[0].last_number;
  return `RP-${year}-${String(sequence).padStart(5, "0")}`;
}

/**
 * Retrieves orders awaiting approval.
 */
export async function getOrdersPendingApproval(): Promise<AdminOrderInfo[]> {
  const { rows } = await db.query(`
    SELECT
      o.number, o.customer_phone AS customer,
      o.unit_price AS price, o.created_at,
      p.name AS part, p.reference,
      s.name AS supplier,
      o.payment_method,
      to_char(o.created_at, 'HH24:MI') AS time,
      EXISTS (
        SELECT 1 FROM payment_proofs pp WHERE pp.order_number = o.number
      ) AS has_proof,
      (o.payment_method = 'bank_transfer' OR o.payment_method = 'bank_deposit' OR o.payment_method = 'multicaixa_express') AS requires_proof
    FROM orders o
    JOIN parts p ON p.id = o.part_id
    JOIN suppliers s ON s.id = o.supplier_id
    WHERE o.status IN ('awaiting_payment', 'payment_proof_received', 'awaiting_payment_proof', 'awaiting_agent_confirmation')
    ORDER BY o.created_at DESC
  `);
  return rows;
}

/**
 * Retrieves orders approved on the current date.
 */
export async function getOrdersApprovedToday(): Promise<any[]> {
  const { rows } = await db.query(`
    SELECT
      o.number, o.customer_phone AS customer,
      o.unit_price AS price,
      p.name AS part,
      to_char(o.approved_at, 'HH24:MI') AS time
    FROM orders o
    JOIN parts p ON p.id = o.part_id
    WHERE o.status = 'approved'
      AND o.approved_at::date = CURRENT_DATE
    ORDER BY o.approved_at DESC
  `);
  return rows;
}

/**
 * Details of a single order.
 */
export async function getOrderByNumber(number: string): Promise<any | null> {
  const { rows } = await db.query(
    `SELECT o.*, p.name AS part_name, p.reference, s.name AS supplier_name
     FROM orders o
     JOIN parts p ON p.id = o.part_id
     JOIN suppliers s ON s.id = o.supplier_id
     WHERE o.number = $1`,
    [number]
  );
  return rows.length ? rows[0] : null;
}

/**
 * Core operation: Batch updates of parsed Excel shop items.
 * Performs clean upsert mapping to supplier_id and SKU reference.
 */
export async function importPartsBatch(
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
        `INSERT INTO parts (supplier_id, reference, name, price, quantity, active, updated_at)
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
      `UPDATE parts
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
