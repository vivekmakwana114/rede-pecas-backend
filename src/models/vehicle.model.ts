import { db } from '../config/db.js';

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
  source: string | null;
  status: string | null;
  attempted_vin: string | null;
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

/**
 * Retrieves the customer's confirmed vehicle (expires after 4 hours).
 * Excludes rows mid-way through the manual-entry wizard (status set to
 * something other than NULL/'complete') — those are in-progress, not confirmed.
 */
export async function getCustomerVehicle(phone: string): Promise<VehicleSession | null> {
  const { rows } = await db.query(
    `SELECT * FROM vehicles
     WHERE phone = $1
       AND (status IS NULL OR status = 'complete')
       AND updated_at > NOW() - INTERVAL '4 hours'`,
    [phone]
  );
  return rows.length ? rows[0] : null;
}

/**
 * Saves/updates a customer's confirmed vehicle (via VIN decode, manual entry
 * completion, or document photo). Always marks status 'complete', which is
 * what distinguishes a confirmed vehicle from an in-progress manual wizard
 * step on the same row.
 */
export async function saveVehicleSession(
  phone: string,
  data: Partial<VehicleSession>
): Promise<void> {
  // Non-functional/descriptive field, nothing branches on it — a document scan
  // with neither a legible plate nor VIN falls back to 'manual', which is fine.
  const source = data.license_plate ? 'document' : (data.vin ? 'vin' : 'manual');

  await db.query(
    `INSERT INTO vehicles
       (phone, vin, make, model, year, engine_number, license_plate, engine_size, fuel_type, source, status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'complete', NOW(), NOW())
     ON CONFLICT (phone)
     DO UPDATE SET
       vin = COALESCE($2, vehicles.vin),
       make = COALESCE($3, vehicles.make),
       model = COALESCE($4, vehicles.model),
       year = COALESCE($5, vehicles.year),
       engine_number = COALESCE($6, vehicles.engine_number),
       license_plate = COALESCE($7, vehicles.license_plate),
       engine_size = COALESCE($8, vehicles.engine_size),
       fuel_type = COALESCE($9, vehicles.fuel_type),
       source = COALESCE($10, vehicles.source),
       status = 'complete',
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
      source,
    ]
  );
}

/**
 * Deletes a customer's vehicle row entirely (confirmed vehicle or in-progress wizard).
 */
export async function clearVehicleSession(phone: string): Promise<void> {
  await db.query("DELETE FROM vehicles WHERE phone = $1", [phone]);
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
 * Begins a manual vehicle details collection process. Resets every
 * vehicle-data field to NULL — including the vin/plate/engine/fuel fields
 * from a possible prior confirmed vehicle on this same row — so a fresh
 * manual entry never inherits stale data from an earlier identification.
 */
export async function startManualCollection(phone: string, status: string, attemptedVin: string | null = null): Promise<void> {
  await db.query(
    `INSERT INTO vehicles (phone, status, attempted_vin, source, created_at, updated_at)
     VALUES ($1, $2, $3, 'manual', NOW(), NOW())
     ON CONFLICT (phone)
     DO UPDATE SET
       status = $2,
       attempted_vin = $3,
       make = NULL, model = NULL, year = NULL, engine_number = NULL,
       vin = NULL, license_plate = NULL, engine_size = NULL, fuel_type = NULL,
       source = 'manual',
       created_at = NOW(),
       updated_at = NOW()`,
    [phone, status, attemptedVin]
  );
}

/**
 * Returns the ongoing manual details collection process state, if any
 * (expires after 30 minutes of inactivity).
 */
export async function getActiveManualCollection(phone: string): Promise<ManualCollection | null> {
  const { rows } = await db.query(
    `SELECT * FROM vehicles
     WHERE phone = $1
       AND status IS NOT NULL AND status != 'complete'
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
    `UPDATE vehicles SET ${setClauses} WHERE phone = $1`,
    [phone, ...values]
  );
}
