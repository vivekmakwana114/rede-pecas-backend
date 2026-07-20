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
INSERT INTO products (supplier_id, name, brand, reference, price, quantity, synonyms, category_keywords)
VALUES
  ((SELECT id FROM suppliers WHERE name = 'Luanda Auto Parts'), 'Mann Oil Filter W712/75',    'Mann',   'W712/75',    2500,  8, 'oil filter lubricant filter', 'oil filter engine'),
  ((SELECT id FROM suppliers WHERE name = 'Angola Moto Parts'), 'Bosch Oil Filter P7153',     'Bosch',  'P7153',      3100, 12, 'oil filter lubricant filter', 'oil filter engine'),
  ((SELECT id FROM suppliers WHERE name = 'Luanda Auto Parts'), 'Mahle Oil Filter OC611',     'Mahle',  'OC611',      3800,  5, 'oil filter original oem',     'oil filter engine'),
  ((SELECT id FROM suppliers WHERE name = 'Import Car Parts'),  'Original VW Oil Filter',     'VW OEM', '06J115403Q', 5200,  2, 'oil filter original oem',     'oil filter engine'),
  ((SELECT id FROM suppliers WHERE name = 'Luanda Auto Parts'), 'Hilux Front Shock Absorber', 'KYB',    'KYB334816', 18500,  4, 'shock absorber front strut',  'suspension shock absorber'),
  ((SELECT id FROM suppliers WHERE name = 'Angola Moto Parts'), 'Golf Front Brake Pads',      'Textar', 'TEX2369201', 7200, 10, 'brake pads brake shoes',      'brakes brake pads')
ON CONFLICT (supplier_id, reference) DO UPDATE SET
  name = EXCLUDED.name, brand = EXCLUDED.brand, price = EXCLUDED.price, quantity = EXCLUDED.quantity,
  synonyms = EXCLUDED.synonyms, category_keywords = EXCLUDED.category_keywords,
  active = true;

-- Sample product with an attached service, to exercise the WhatsApp
-- service-offer follow-up (see CLAUDE.md message pipeline / product.service.ts).
INSERT INTO products (supplier_id, name, brand, reference, price, quantity, synonyms, category_keywords, service_offered, service_name, service_price)
VALUES
  ((SELECT id FROM suppliers WHERE name = 'Luanda Auto Parts'), 'Mann Oil Filter W712/75 Kit', 'Mann', 'W712/75-KIT', 2500, 6, 'oil filter lubricant filter', 'oil filter engine', true, 'Oil filter installation and oil change', 4500)
ON CONFLICT (supplier_id, reference) DO UPDATE SET
  name = EXCLUDED.name, price = EXCLUDED.price, quantity = EXCLUDED.quantity,
  service_offered = EXCLUDED.service_offered, service_name = EXCLUDED.service_name, service_price = EXCLUDED.service_price,
  active = true;

-- ============================================================
-- Out-of-stock products (quantity = 0) — exercise the waitlist →
-- restock-notification → "Order now" chain (see TESTING.md). One carries an
-- attached service so the restock "Order now" path also re-exercises the
-- service-offer step; the other is plain, for a simpler restock test.
-- ============================================================
INSERT INTO products (supplier_id, name, brand, reference, price, quantity, synonyms, category_keywords, service_offered, service_name, service_price)
VALUES
  ((SELECT id FROM suppliers WHERE name = 'Angola Moto Parts'), 'Continental Timing Belt CT1028', 'Continental', 'CT1028', 9800, 0, 'timing belt distribution belt', 'timing belt engine', true, 'Timing belt installation', 6000)
ON CONFLICT (supplier_id, reference) DO UPDATE SET
  name = EXCLUDED.name, price = EXCLUDED.price, quantity = EXCLUDED.quantity,
  service_offered = EXCLUDED.service_offered, service_name = EXCLUDED.service_name, service_price = EXCLUDED.service_price,
  active = true;

INSERT INTO products (supplier_id, name, brand, reference, price, quantity, synonyms, category_keywords)
VALUES
  ((SELECT id FROM suppliers WHERE name = 'Import Car Parts'), 'Fram Air Filter CA1234', 'Fram', 'CA1234', 4200, 0, 'air filter engine filter', 'air filter engine')
ON CONFLICT (supplier_id, reference) DO UPDATE SET
  name = EXCLUDED.name, price = EXCLUDED.price, quantity = EXCLUDED.quantity, active = true;
