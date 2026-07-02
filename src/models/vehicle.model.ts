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
