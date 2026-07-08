import { db } from '../config/db.js';

export interface VehicleSession {
  id: number;
  phone: string;
  vin: string | null;
  make: string;
  model: string;
  year: string;
  engine_number: string | null;
  license_plate: string | null;
  engine_size: string | null;
  fuel_type: string | null;
  source: string | null;
  status: string | null;
  attempted_vin: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface ManualCollection {
  id: number;
  phone: string;
  status: string;
  attempted_vin: string | null;
  make: string | null;
  model: string | null;
  year: string | null;
  engine_number: string | null;
  created_at: Date;
}

/**
 * Retrieves every confirmed vehicle on file for this customer — permanent records,
 * no expiry (a real vehicle doesn't stop existing because the customer went quiet
 * on WhatsApp). A customer can have more than one — see "add another vehicle" in
 * the message pipeline.
 */
export async function getCustomerVehicles(phone: string): Promise<VehicleSession[]> {
  const { rows } = await db.query(
    `SELECT * FROM vehicles
     WHERE phone = $1
       AND (status IS NULL OR status = 'complete')
     ORDER BY updated_at DESC`,
    [phone]
  );
  return rows;
}

/**
 * The single most-recently-confirmed vehicle, for callers right after a save (VIN/
 * photo decode, manual-entry completion) where there's no ambiguity about which row
 * they mean. Not for search-time vehicle selection when the customer has several —
 * use `getCustomerVehicles` + a picker there instead.
 */
export async function getMostRecentVehicle(phone: string): Promise<VehicleSession | null> {
  const { rows } = await db.query(
    `SELECT * FROM vehicles
     WHERE phone = $1
       AND (status IS NULL OR status = 'complete')
     ORDER BY updated_at DESC
     LIMIT 1`,
    [phone]
  );
  return rows.length ? rows[0] : null;
}

/**
 * Fetches one specific confirmed vehicle by id (still scoped to the phone it
 * belongs to). No freshness window — see getCustomerVehicles.
 */
export async function getVehicleById(phone: string, id: number): Promise<VehicleSession | null> {
  const { rows } = await db.query(
    `SELECT * FROM vehicles
     WHERE id = $1 AND phone = $2
       AND (status IS NULL OR status = 'complete')`,
    [id, phone]
  );
  return rows.length ? rows[0] : null;
}

/**
 * Saves a customer's confirmed vehicle (via VIN decode, manual entry completion, or
 * document photo). When `id` is given, updates that specific in-progress wizard row
 * (transitioning it to 'complete'); otherwise inserts a brand-new row — a customer
 * can have several confirmed vehicles, so this never upserts by phone alone.
 */
export async function saveVehicleSession(
  phone: string,
  data: Partial<VehicleSession>,
  id?: number
): Promise<void> {
  // Non-functional/descriptive field, nothing branches on it — a document scan
  // with neither a legible plate nor VIN falls back to 'manual', which is fine.
  const source = data.license_plate ? 'document' : (data.vin ? 'vin' : 'manual');

  const values = [
    data.vin || null,
    data.make || null,
    data.model || null,
    data.year || null,
    data.engine_number || null,
    data.license_plate || null,
    data.engine_size || null,
    data.fuel_type || null,
    source,
  ];

  if (id) {
    await db.query(
      `UPDATE vehicles SET
         vin = COALESCE($2, vin),
         make = COALESCE($3, make),
         model = COALESCE($4, model),
         year = COALESCE($5, year),
         engine_number = COALESCE($6, engine_number),
         license_plate = COALESCE($7, license_plate),
         engine_size = COALESCE($8, engine_size),
         fuel_type = COALESCE($9, fuel_type),
         source = COALESCE($10, source),
         status = 'complete',
         updated_at = NOW()
       WHERE id = $1`,
      [id, ...values]
    );
    return;
  }

  await db.query(
    `INSERT INTO vehicles
       (phone, vin, make, model, year, engine_number, license_plate, engine_size, fuel_type, source, status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'complete', NOW(), NOW())`,
    [phone, ...values]
  );
}

/**
 * Deletes one specific vehicle row (a rejected identification attempt, or an
 * in-progress wizard row) — never all of a customer's vehicles.
 */
export async function clearVehicleSession(id: number): Promise<void> {
  await db.query("DELETE FROM vehicles WHERE id = $1", [id]);
}

/**
 * Saves a decoded VIN response in the NHTSA cache.
 */
export async function saveNhtsaVehicle(
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
    `INSERT INTO nhtsa_vehicles (vin, make, model, year, vehicle_type, engine, fuel_type, manufacture_country)
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
 * Fetches a cached NHTSA VIN decode response.
 */
export async function getNhtsaVehicle(vin: string): Promise<any | null> {
  const { rows } = await db.query(
    "SELECT * FROM nhtsa_vehicles WHERE vin = $1",
    [vin.toUpperCase()]
  );
  return rows.length ? rows[0] : null;
}

/**
 * Begins a manual vehicle details collection process — always a new row (a customer
 * can have other confirmed vehicles already; this never touches them). Returns the
 * new row's id, which callers thread through updateManualCollection/saveVehicleSession
 * to keep mutating this same in-progress row.
 */
export async function startManualCollection(phone: string, status: string, attemptedVin: string | null = null): Promise<number> {
  const { rows } = await db.query(
    `INSERT INTO vehicles (phone, status, attempted_vin, source, created_at, updated_at)
     VALUES ($1, $2, $3, 'manual', NOW(), NOW())
     RETURNING id`,
    [phone, status, attemptedVin]
  );
  return rows[0].id;
}

/**
 * Returns the ongoing manual details collection process state, if any
 * (expires after 30 minutes of inactivity). At most one in-progress row per
 * phone is expected at a time — enforced by the message pipeline, not the DB.
 */
export async function getActiveManualCollection(phone: string): Promise<ManualCollection | null> {
  const { rows } = await db.query(
    `SELECT * FROM vehicles
     WHERE phone = $1
       AND status IS NOT NULL AND status != 'complete'
       AND created_at > NOW() - INTERVAL '30 minutes'
     ORDER BY created_at DESC
     LIMIT 1`,
    [phone]
  );
  return rows.length ? rows[0] : null;
}

/**
 * Updates manual collection state values for one specific in-progress row.
 */
export async function updateManualCollection(id: number, fields: Partial<ManualCollection>): Promise<void> {
  const keys = Object.keys(fields);
  if (!keys.length) return;

  const setClauses = keys.map((key, index) => `"${key}" = $${index + 2}`).join(', ');
  const values = keys.map((key) => (fields as any)[key]);

  await db.query(
    `UPDATE vehicles SET ${setClauses} WHERE id = $1`,
    [id, ...values]
  );
}
