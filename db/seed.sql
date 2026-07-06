-- ============================================================
-- Rede Peças — Sample data for development
-- Data values stay Portuguese (real product/domain language).
-- ============================================================

INSERT INTO suppliers (name, province, rating) VALUES
  ('Auto Peças Luanda', 'Luanda', 4.8),
  ('Moto Parts Angola', 'Luanda', 4.5),
  ('Import Car Parts', 'Benguela', 4.2);

INSERT INTO products (supplier_id, name, brand, reference, price, quantity, delivery_time, synonyms, category_keywords)
VALUES
  (1, 'Filtro de óleo Mann W712/75',    'Mann',   'W712/75',     2500,  8, 'Amanhã', 'filtro oleo oil filter',    'filtro óleo motor'),
  (2, 'Filtro de óleo Bosch P7153',     'Bosch',  'P7153',       3100, 12, 'Hoje',   'filtro oleo oil filter',    'filtro óleo motor'),
  (1, 'Filtro de óleo Mahle OC611',     'Mahle',  'OC611',       3800,  5, '2 dias', 'filtro oleo oil filter',    'filtro óleo motor'),
  (3, 'Filtro de óleo Original VW',     'VW OEM', '06J115403Q',  5200,  2, '5 dias', 'filtro oleo original oem',  'filtro óleo motor'),
  (1, 'Amortecedor dianteiro Hilux',    'KYB',    'KYB334816',  18500,  4, 'Amanhã', 'amortecedor frente choque', 'suspensão amortecimento'),
  (2, 'Pastilhas travão Golf dianteiro','Textar', 'TEX2369201',  7200, 10, 'Hoje',   'pastilhas freio travoes',   'travões freio pastilhas');
