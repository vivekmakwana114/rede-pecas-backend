-- ============================================================
-- Rede Peças — Sample data for development
-- Data values stay Portuguese (real product/domain language).
-- ============================================================

INSERT INTO suppliers (name, province, rating) VALUES
  ('Auto Peças Luanda', 'Luanda', 4.8),
  ('Moto Parts Angola', 'Luanda', 4.5),
  ('Import Car Parts', 'Benguela', 4.2);

INSERT INTO vehicles (make, model, generation, year_from, year_to, fuel_type) VALUES
  ('Toyota',     'Hilux',  'AN10',  2005, 2015, 'diesel'),
  ('Toyota',     'Hilux',  'AN120', 2015, 2024, 'diesel'),
  ('Volkswagen', 'Golf',   'MK7',   2012, 2019, 'gasolina'),
  ('Volkswagen', 'Golf',   'MK8',   2019, 2024, 'gasolina'),
  ('Mitsubishi', 'L200',   'KB',    2006, 2015, 'diesel'),
  ('Ford',       'Ranger', 'T6',    2011, 2022, 'diesel');

INSERT INTO categories (name) VALUES
  ('Filtração'), ('Motor'), ('Suspensão'), ('Travões'), ('Transmissão'), ('Elétrico');

INSERT INTO parts (supplier_id, category_id, name, brand, reference, price, quantity, delivery_time, synonyms, category_keywords)
VALUES
  (1, 1, 'Filtro de óleo Mann W712/75',    'Mann',   'W712/75',     2500,  8, 'Amanhã', 'filtro oleo oil filter',    'filtro óleo motor'),
  (2, 1, 'Filtro de óleo Bosch P7153',     'Bosch',  'P7153',       3100, 12, 'Hoje',   'filtro oleo oil filter',    'filtro óleo motor'),
  (1, 1, 'Filtro de óleo Mahle OC611',     'Mahle',  'OC611',       3800,  5, '2 dias', 'filtro oleo oil filter',    'filtro óleo motor'),
  (3, 1, 'Filtro de óleo Original VW',     'VW OEM', '06J115403Q',  5200,  2, '5 dias', 'filtro oleo original oem',  'filtro óleo motor'),
  (1, 3, 'Amortecedor dianteiro Hilux',    'KYB',    'KYB334816',  18500,  4, 'Amanhã', 'amortecedor frente choque', 'suspensão amortecimento'),
  (2, 4, 'Pastilhas travão Golf dianteiro','Textar', 'TEX2369201',  7200, 10, 'Hoje',   'pastilhas freio travoes',   'travões freio pastilhas');

-- Link every seeded part to a plausible vehicle so compatibility
-- joins return results in development.
INSERT INTO compatibilities (part_id, vehicle_id) VALUES
  (1, 3), (1, 4),   -- Mann oil filter → VW Golf MK7/MK8
  (2, 3), (2, 4),   -- Bosch oil filter → VW Golf MK7/MK8
  (3, 1), (3, 2),   -- Mahle oil filter → Toyota Hilux
  (4, 3), (4, 4),   -- VW OEM filter → VW Golf
  (5, 1), (5, 2),   -- Front shock absorber → Toyota Hilux
  (6, 3), (6, 4);   -- Front brake pads → VW Golf
