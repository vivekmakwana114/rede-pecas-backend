-- ============================================================
-- Rede Peças — Sample data for development
-- Data values are in English for this dev/demo seed.
--
-- Safe to run repeatedly (npm run db:seed) — every statement is a guarded
-- insert or an upsert, so re-running always resets products back to their
-- canonical seed state instead of accumulating duplicates or leaving behind
-- whatever quantity a previous manual test left a row at.
-- ============================================================

-- Dev admin login: admin@redepecas.ao / admin123 (bcrypt hash below — change
-- the password immediately in any environment this seed reaches beyond local dev).
-- npm run db:seed
INSERT INTO admin_users (name, email, phone, password_hash) VALUES
  ('Admin', 'admin@redepecas.ao', '917987760774', '$2a$10$UVANI9fapZOKB5T8opdS4.FtEkSYk42ISUp0NQhSAeNvxQIrGZLt6')
ON CONFLICT (email) DO NOTHING;

-- suppliers.name has no unique constraint (a real supplier name isn't
-- guaranteed unique, and getOrCreateSupplierByName only does a plain ILIKE
-- lookup) — guard each seed row with NOT EXISTS instead so re-running this
-- file doesn't pile up duplicate rows the way a bare INSERT would.
INSERT INTO suppliers (name, province, rating)
SELECT 'Luanda Auto Parts', 'Luanda', 4.8
WHERE NOT EXISTS (SELECT 1 FROM suppliers WHERE name = 'Luanda Auto Parts');

INSERT INTO suppliers (name, province, rating)
SELECT 'Angola Moto Parts', 'Luanda', 4.5
WHERE NOT EXISTS (SELECT 1 FROM suppliers WHERE name = 'Angola Moto Parts');

INSERT INTO suppliers (name, province, rating)
SELECT 'Import Car Parts', 'Benguela', 4.2
WHERE NOT EXISTS (SELECT 1 FROM suppliers WHERE name = 'Import Car Parts');

-- Looked up by name (not hardcoded ids) so this file works regardless of
-- what ids the suppliers above ended up with on a given database.
-- category/subcategory/service_category/vehicle_make/delivery_time/synonyms/
-- description are all NOT NULL as of the products-catalog schema extension —
-- see db/schema.sql. service_category is the derived
-- SUBCATEGORY_TO_SERVICE_CATEGORY grouping (src/constants/serviceCategory.ts).
INSERT INTO products (supplier_id, name, brand, reference, price, quantity, synonyms, category_keywords, category, subcategory, service_category, vehicle_make, delivery_time, description)
VALUES
  ((SELECT id FROM suppliers WHERE name = 'Luanda Auto Parts'), 'Mann Oil Filter W712/75',    'Mann',   'W712/75',    2500,  8, 'oil filter lubricant filter', 'oil filter engine', 'lubricant', 'Filtration', 'maintenance',      'Various',    'Today', 'Mann Oil Filter W712/75'),
  ((SELECT id FROM suppliers WHERE name = 'Angola Moto Parts'), 'Bosch Oil Filter P7153',     'Bosch',  'P7153',      3100, 12, 'oil filter lubricant filter', 'oil filter engine', 'lubricant', 'Filtration', 'maintenance',      'Various',    'Today', 'Bosch Oil Filter P7153'),
  ((SELECT id FROM suppliers WHERE name = 'Luanda Auto Parts'), 'Mahle Oil Filter OC611',     'Mahle',  'OC611',      3800,  5, 'oil filter original oem',     'oil filter engine', 'lubricant', 'Filtration', 'maintenance',      'Various',    'Today', 'Mahle Oil Filter OC611'),
  ((SELECT id FROM suppliers WHERE name = 'Import Car Parts'),  'Original VW Oil Filter',     'VW OEM', '06J115403Q', 5200,  2, 'oil filter original oem',     'oil filter engine', 'lubricant', 'Filtration', 'maintenance',      'Volkswagen', 'Today', 'Original VW Oil Filter'),
  ((SELECT id FROM suppliers WHERE name = 'Luanda Auto Parts'), 'Hilux Front Shock Absorber', 'KYB',    'KYB334816', 18500,  4, 'shock absorber front strut',  'suspension shock absorber', 'part', 'Suspension', 'general_mechanics', 'Toyota',     'Today', 'Hilux Front Shock Absorber'),
  ((SELECT id FROM suppliers WHERE name = 'Angola Moto Parts'), 'Golf Front Brake Pads',      'Textar', 'TEX2369201', 7200, 10, 'brake pads brake shoes',      'brakes brake pads', 'part', 'Brakes', 'general_mechanics', 'Volkswagen', 'Today', 'Golf Front Brake Pads')
ON CONFLICT (supplier_id, reference) DO UPDATE SET
  name = EXCLUDED.name, brand = EXCLUDED.brand, price = EXCLUDED.price, quantity = EXCLUDED.quantity,
  synonyms = EXCLUDED.synonyms, category_keywords = EXCLUDED.category_keywords,
  category = EXCLUDED.category, subcategory = EXCLUDED.subcategory, service_category = EXCLUDED.service_category,
  vehicle_make = EXCLUDED.vehicle_make, delivery_time = EXCLUDED.delivery_time, description = EXCLUDED.description,
  active = true;

-- Sample product whose service_category has matching seeded services below
-- (Filtration -> maintenance), to exercise the WhatsApp service-matching
-- follow-up (see CLAUDE.md message pipeline / product.service.ts's
-- startOrderForProduct -> getMatchingServicesForProduct).
INSERT INTO products (supplier_id, name, brand, reference, price, quantity, synonyms, category_keywords, category, subcategory, service_category, vehicle_make, delivery_time, description)
VALUES
  ((SELECT id FROM suppliers WHERE name = 'Luanda Auto Parts'), 'Mann Oil Filter W712/75 Kit', 'Mann', 'W712/75-KIT', 2500, 6, 'oil filter lubricant filter', 'oil filter engine', 'lubricant', 'Filtration', 'maintenance', 'Various', 'Today', 'Mann Oil Filter W712/75 Kit')
ON CONFLICT (supplier_id, reference) DO UPDATE SET
  name = EXCLUDED.name, price = EXCLUDED.price, quantity = EXCLUDED.quantity,
  category = EXCLUDED.category, subcategory = EXCLUDED.subcategory, service_category = EXCLUDED.service_category,
  vehicle_make = EXCLUDED.vehicle_make, delivery_time = EXCLUDED.delivery_time, description = EXCLUDED.description,
  active = true;

-- ============================================================
-- Out-of-stock products (quantity = 0) — exercise the waitlist →
-- restock-notification → "Order now" chain (see TESTING.md).
-- ============================================================
INSERT INTO products (supplier_id, name, brand, reference, price, quantity, synonyms, category_keywords, category, subcategory, service_category, vehicle_make, delivery_time, description)
VALUES
  ((SELECT id FROM suppliers WHERE name = 'Angola Moto Parts'), 'Continental Timing Belt CT1028', 'Continental', 'CT1028', 9800, 0, 'timing belt distribution belt', 'timing belt engine', 'part', 'Engine', 'general_mechanics', 'Various', 'Today', 'Continental Timing Belt CT1028')
ON CONFLICT (supplier_id, reference) DO UPDATE SET
  name = EXCLUDED.name, price = EXCLUDED.price, quantity = EXCLUDED.quantity,
  category = EXCLUDED.category, subcategory = EXCLUDED.subcategory, service_category = EXCLUDED.service_category,
  vehicle_make = EXCLUDED.vehicle_make, delivery_time = EXCLUDED.delivery_time, description = EXCLUDED.description,
  active = true;

INSERT INTO products (supplier_id, name, brand, reference, price, quantity, synonyms, category_keywords, category, subcategory, service_category, vehicle_make, delivery_time, description)
VALUES
  ((SELECT id FROM suppliers WHERE name = 'Import Car Parts'), 'Fram Air Filter CA1234', 'Fram', 'CA1234', 4200, 0, 'air filter engine filter', 'air filter engine', 'part', 'Filtration', 'maintenance', 'Various', 'Today', 'Fram Air Filter CA1234')
ON CONFLICT (supplier_id, reference) DO UPDATE SET
  name = EXCLUDED.name, price = EXCLUDED.price, quantity = EXCLUDED.quantity,
  category = EXCLUDED.category, subcategory = EXCLUDED.subcategory, service_category = EXCLUDED.service_category,
  vehicle_make = EXCLUDED.vehicle_make, delivery_time = EXCLUDED.delivery_time, description = EXCLUDED.description,
  active = true;

-- ============================================================
-- Services domain (new 2026-07 catalog) — one provider + a few services
-- spanning maintenance/general_mechanics, so local dev/TESTING.md has
-- something to exercise the products.service_category <-> services join
-- against (see db/schema.sql services table).
-- ============================================================
INSERT INTO service_providers (name, address, province, phone, specialties, rating, response_time)
SELECT 'Auto Drex', 'Home Maintenance Services', 'Luanda', '244923000000', 'Multi-brand, Preventive Maintenance at Home', 4.9, 'Today'
WHERE NOT EXISTS (SELECT 1 FROM service_providers WHERE name = 'Auto Drex');

INSERT INTO services (provider_id, service_name, service_category, service_base_price, service_duration_h, available_at_home, base_travel_fee, logistics_fee_notes)
VALUES
  ((SELECT id FROM service_providers WHERE name = 'Auto Drex'), 'Engine Oil and Filter Change (Oil, Air, AC) - Petrol Engines', 'maintenance', 15000, 1.0, true, 5000, 'Zone 1 (Talatona/Kilamba/Benfica): 5000 Kz | Zone 2 (Maianga/Alvalade/Viana): 8000 Kz | Zone 3 (Baixa/Mutamba/Cacuaco): 12000 Kz'),
  ((SELECT id FROM service_providers WHERE name = 'Auto Drex'), 'Front Brake Pad Replacement', 'general_mechanics', 15000, 1.0, true, 5000, 'Zone 1 (Talatona/Kilamba/Benfica): 5000 Kz | Zone 2 (Maianga/Alvalade/Viana): 8000 Kz | Zone 3 (Baixa/Mutamba/Cacuaco): 12000 Kz'),
  ((SELECT id FROM service_providers WHERE name = 'Auto Drex'), 'Computerized Electronic Diagnostics (Scanner)', 'diagnostics', 15000, 0.5, true, 5000, 'Zone 1 (Talatona/Kilamba/Benfica): 5000 Kz | Zone 2 (Maianga/Alvalade/Viana): 8000 Kz | Zone 3 (Baixa/Mutamba/Cacuaco): 12000 Kz')
ON CONFLICT (provider_id, service_name) DO UPDATE SET
  service_category = EXCLUDED.service_category, service_base_price = EXCLUDED.service_base_price,
  service_duration_h = EXCLUDED.service_duration_h, available_at_home = EXCLUDED.available_at_home,
  base_travel_fee = EXCLUDED.base_travel_fee, logistics_fee_notes = EXCLUDED.logistics_fee_notes,
  active = true;
