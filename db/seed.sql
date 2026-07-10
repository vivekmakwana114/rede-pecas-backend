-- ============================================================
-- Rede Peças — Sample data for development
-- Data values are in English for this dev/demo seed.
-- ============================================================

-- Dev admin login: admin@redepecas.ao / admin123 (bcrypt hash below — change
-- the password immediately in any environment this seed reaches beyond local dev).
-- npm run db:seed
INSERT INTO admin_users (name, email, phone, password_hash) VALUES
  ('Admin', 'admin@redepecas.ao', '244900000001', '$2a$10$UVANI9fapZOKB5T8opdS4.FtEkSYk42ISUp0NQhSAeNvxQIrGZLt6')
ON CONFLICT (email) DO NOTHING;

INSERT INTO suppliers (name, province, rating) VALUES
  ('Luanda Auto Parts', 'Luanda', 4.8),
  ('Angola Moto Parts', 'Luanda', 4.5),
  ('Import Car Parts', 'Benguela', 4.2);

INSERT INTO products (supplier_id, name, brand, reference, price, quantity, delivery_time, synonyms, category_keywords)
VALUES
  (1, 'Mann Oil Filter W712/75',        'Mann',   'W712/75',     2500,  8, 'Tomorrow', 'oil filter lubricant filter', 'oil filter engine'),
  (2, 'Bosch Oil Filter P7153',         'Bosch',  'P7153',       3100, 12, 'Today',    'oil filter lubricant filter', 'oil filter engine'),
  (1, 'Mahle Oil Filter OC611',         'Mahle',  'OC611',       3800,  5, '2 days',   'oil filter original oem',     'oil filter engine'),
  (3, 'Original VW Oil Filter',         'VW OEM', '06J115403Q',  5200,  2, '5 days',   'oil filter original oem',     'oil filter engine'),
  (1, 'Hilux Front Shock Absorber',     'KYB',    'KYB334816',  18500,  4, 'Tomorrow', 'shock absorber front strut',  'suspension shock absorber'),
  (2, 'Golf Front Brake Pads',          'Textar', 'TEX2369201',  7200, 10, 'Today',    'brake pads brake shoes',      'brakes brake pads');

-- Sample product with an attached service, to exercise the WhatsApp
-- service-offer follow-up (see CLAUDE.md message pipeline / product.service.ts).
INSERT INTO products (supplier_id, name, brand, reference, price, quantity, delivery_time, synonyms, category_keywords, service_offered, service_name, service_price)
VALUES
  (1, 'Mann Oil Filter W712/75 Kit',    'Mann',   'W712/75-KIT', 2500,  6, 'Tomorrow', 'oil filter lubricant filter', 'oil filter engine', true, 'Instalação e troca de óleo', 4500);
