-- ============================================================
-- Rede Peças — Database Schema (PostgreSQL)
-- Ported from the original prototype (rede-pecas-agent/schema.sql)
-- with identifiers translated to English. Data content (part
-- names, synonyms) remains Portuguese — hence the 'portuguese'
-- full-text search configuration.
-- ============================================================

-- REQUIRED EXTENSIONS
CREATE EXTENSION IF NOT EXISTS unaccent;       -- accent-insensitive search
CREATE EXTENSION IF NOT EXISTS pg_trgm;        -- text similarity (typos)

-- unaccent() is only STABLE, not IMMUTABLE, so Postgres refuses it inside a
-- GENERATED ALWAYS column expression. Wrap it so it can be declared IMMUTABLE
-- (safe here: the 'unaccent' dictionary is fixed, not session/config-dependent).
CREATE OR REPLACE FUNCTION immutable_unaccent(TEXT) RETURNS TEXT AS $$
  SELECT unaccent('unaccent', $1)
$$ LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT;

-- ============================================================
-- SUPPLIERS
-- ============================================================
CREATE TABLE IF NOT EXISTS suppliers (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  phone         TEXT,
  email         TEXT,
  nif           TEXT,                           -- Angolan tax ID
  province      TEXT,
  rating        NUMERIC(2,1) DEFAULT 5.0,       -- 0.0 to 5.0
  api_key       TEXT UNIQUE,
  active        BOOLEAN DEFAULT true,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- PART CATEGORIES
-- ============================================================
CREATE TABLE IF NOT EXISTS categories (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL,                  -- e.g. "Motor", "Suspensão"
  parent_id     INT REFERENCES categories(id)   -- subcategories
);

-- ============================================================
-- VEHICLES (compatibility table)
-- ============================================================
CREATE TABLE IF NOT EXISTS vehicles (
  id            SERIAL PRIMARY KEY,
  make          TEXT NOT NULL,                  -- e.g. "Toyota"
  model         TEXT NOT NULL,                  -- e.g. "Hilux"
  generation    TEXT,                           -- e.g. "AN10/AN20"
  year_from     INT NOT NULL,                   -- e.g. 2005
  year_to       INT NOT NULL,                   -- e.g. 2015
  engine        TEXT,                           -- e.g. "2.5D 4D"
  fuel_type     TEXT                            -- "diesel", "gasolina", "híbrido"
);

CREATE INDEX IF NOT EXISTS idx_vehicles_make_model ON vehicles (make, model);
CREATE INDEX IF NOT EXISTS idx_vehicles_years ON vehicles (year_from, year_to);

-- ============================================================
-- PRODUCTS (formerly "parts" — renamed for clarity; the auto-parts
-- domain vocabulary still calls them "peças" everywhere else)
-- ============================================================
ALTER TABLE IF EXISTS parts RENAME TO products;
ALTER INDEX IF EXISTS idx_parts_fts RENAME TO idx_products_fts;
ALTER INDEX IF EXISTS idx_parts_supplier RENAME TO idx_products_supplier;
ALTER INDEX IF EXISTS idx_parts_price RENAME TO idx_products_price;
ALTER INDEX IF EXISTS idx_parts_active RENAME TO idx_products_active;

CREATE TABLE IF NOT EXISTS products (
  id               SERIAL PRIMARY KEY,
  supplier_id      INT NOT NULL REFERENCES suppliers(id),
  category_id      INT REFERENCES categories(id),

  -- Identification
  name             TEXT NOT NULL,               -- e.g. "Filtro de óleo Mann W712/75"
  brand            TEXT,                        -- e.g. "Mann", "Bosch", "Original"
  reference        TEXT NOT NULL,               -- e.g. "W712/75"
  oem_reference    TEXT,                        -- original manufacturer reference
  synonyms         TEXT,                        -- e.g. "filtro oleo, oil filter"
  category_keywords TEXT,                       -- free text for search
  description      TEXT,

  -- Price and stock
  price            NUMERIC(12,2) NOT NULL,      -- in Kwanzas (AOA)
  quantity         INT NOT NULL DEFAULT 0,
  unit             TEXT DEFAULT 'unidade',

  -- Delivery
  delivery_time    TEXT DEFAULT 'Em stock',     -- e.g. "Hoje", "2 dias", "Sob encomenda"

  -- Control
  active           BOOLEAN DEFAULT true,
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW(),

  -- Required by the supplier batch-import upsert
  UNIQUE (supplier_id, reference),

  -- Full-text search index (auto-generated). Config stays
  -- 'portuguese' because part data is in Portuguese.
  search_vector    TSVECTOR GENERATED ALWAYS AS (
    to_tsvector('portuguese',
      immutable_unaccent(name) || ' ' ||
      immutable_unaccent(COALESCE(brand, '')) || ' ' ||
      immutable_unaccent(COALESCE(reference, '')) || ' ' ||
      immutable_unaccent(COALESCE(oem_reference, '')) || ' ' ||
      immutable_unaccent(COALESCE(synonyms, '')) || ' ' ||
      immutable_unaccent(COALESCE(category_keywords, ''))
    )
  ) STORED
);

CREATE INDEX IF NOT EXISTS idx_products_fts ON products USING GIN (search_vector);
CREATE INDEX IF NOT EXISTS idx_products_supplier ON products (supplier_id);
CREATE INDEX IF NOT EXISTS idx_products_price ON products (price);
CREATE INDEX IF NOT EXISTS idx_products_active ON products (active) WHERE active = true;

-- ============================================================
-- COMPATIBILITIES (product ↔ vehicle)
-- ============================================================
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'compatibilities' AND column_name = 'part_id'
  ) THEN
    ALTER TABLE compatibilities RENAME COLUMN part_id TO product_id;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS compatibilities (
  id          SERIAL PRIMARY KEY,
  product_id  INT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  vehicle_id  INT NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  UNIQUE (product_id, vehicle_id)
);

ALTER INDEX IF EXISTS idx_compat_part RENAME TO idx_compat_product;
CREATE INDEX IF NOT EXISTS idx_compat_product ON compatibilities (product_id);
CREATE INDEX IF NOT EXISTS idx_compat_vehicle ON compatibilities (vehicle_id);

-- ============================================================
-- ORDERS
-- ============================================================
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'orders' AND column_name = 'part_id'
  ) THEN
    ALTER TABLE orders RENAME COLUMN part_id TO product_id;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS orders (
  id                      SERIAL PRIMARY KEY,
  number                  TEXT UNIQUE NOT NULL,  -- e.g. "RP-2026-00123"
  customer_phone          TEXT NOT NULL,
  product_id              INT REFERENCES products(id),
  supplier_id             INT REFERENCES suppliers(id),
  quantity                INT DEFAULT 1,
  unit_price              NUMERIC(12,2),
  -- Status state machine: awaiting_payment → awaiting_payment_method
  -- → awaiting_bank_subtype | awaiting_in_person_subtype
  -- → awaiting_payment_proof | awaiting_agent_confirmation
  -- → payment_proof_received → approved | rejected
  status                  TEXT DEFAULT 'awaiting_payment',
  payment_method          TEXT,
  approved_by             TEXT,
  approved_at             TIMESTAMPTZ,
  customer_engine_number  TEXT,
  -- Payment proof (folded in from the former payment_proofs table —
  -- always a strict 1:1 with the order, so no benefit to a separate table)
  payment_proof_media_id  TEXT,
  payment_proof_media_type TEXT,
  created_at              TIMESTAMPTZ DEFAULT NOW(),
  updated_at              TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_proof_media_id TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_proof_media_type TEXT;

CREATE INDEX IF NOT EXISTS idx_orders_customer_phone ON orders (customer_phone);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders (status);

-- One-time data migration from payment_proofs, then drop it (idempotent: no-op once dropped)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'payment_proofs') THEN
    UPDATE orders o
    SET payment_proof_media_id = pp.media_id,
        payment_proof_media_type = pp.media_type
    FROM payment_proofs pp
    WHERE pp.order_number = o.number;
  END IF;
END $$;

DROP TABLE IF EXISTS payment_proofs;

-- ============================================================
-- WAITLIST (products not found — notify when available)
-- ============================================================
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'waitlist_requests' AND column_name = 'part_name'
  ) THEN
    ALTER TABLE waitlist_requests RENAME COLUMN part_name TO product_name;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS waitlist_requests (
  id             SERIAL PRIMARY KEY,
  phone          TEXT NOT NULL,
  product_name   TEXT NOT NULL,
  vehicle_make   TEXT,
  vehicle_model  TEXT,
  vehicle_year   TEXT,
  engine_number  TEXT,
  notified       BOOLEAN DEFAULT false,
  created_at     TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- VIN cache (avoids repeated NHTSA API calls)
-- ============================================================
CREATE TABLE IF NOT EXISTS vin_cache (
  vin                 CHAR(17) PRIMARY KEY,
  make                TEXT NOT NULL,
  model               TEXT NOT NULL,
  year                TEXT NOT NULL,
  vehicle_type        TEXT,
  engine              TEXT,
  fuel_type           TEXT,
  manufacture_country TEXT,
  created_at          TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- Per-customer vehicle session (4-hour working context)
-- ============================================================
CREATE TABLE IF NOT EXISTS vehicle_sessions (
  phone           TEXT PRIMARY KEY,
  vin             CHAR(17),
  make            TEXT,
  model           TEXT,
  year            TEXT,
  engine_number   TEXT,
  license_plate   TEXT,
  engine_size     TEXT,
  fuel_type       TEXT,
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_vehicle_sessions_time ON vehicle_sessions (updated_at);

-- ============================================================
-- Manual vehicle data collection (VIN failed or unavailable)
-- ============================================================
CREATE TABLE IF NOT EXISTS manual_vehicle_collections (
  phone           TEXT PRIMARY KEY,
  status          TEXT NOT NULL,
  attempted_vin   CHAR(17),
  make            TEXT,
  model           TEXT,
  year            TEXT,
  engine_number   TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- Order number counter per year (generates RP-2026-00001)
-- ============================================================
CREATE TABLE IF NOT EXISTS order_counters (
  year            INT PRIMARY KEY,
  last_number     INT NOT NULL DEFAULT 0
);

-- ============================================================
-- Supplier inventory sync log
-- ============================================================
CREATE TABLE IF NOT EXISTS sync_logs (
  id                 SERIAL PRIMARY KEY,
  supplier_id        INT REFERENCES suppliers(id),
  inserted_count     INT DEFAULT 0,
  updated_count      INT DEFAULT 0,
  deactivated_count  INT DEFAULT 0,
  created_at         TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sync_logs_supplier ON sync_logs (supplier_id);

-- ============================================================
-- CRM
-- ============================================================
CREATE TABLE IF NOT EXISTS customers (
  phone                TEXT PRIMARY KEY,
  name                 TEXT,
  nif                  TEXT,                    -- Angolan tax ID
  address              TEXT,
  email                TEXT,
  registration_status  TEXT DEFAULT 'new',      -- new, awaiting_name, awaiting_nif, awaiting_address, complete
  first_contact_at     TIMESTAMPTZ DEFAULT NOW(),
  last_contact_at      TIMESTAMPTZ DEFAULT NOW(),
  registered_at        TIMESTAMPTZ,
  contact_count        INT DEFAULT 1,
  active               BOOLEAN DEFAULT true
);

CREATE INDEX IF NOT EXISTS idx_customers_status ON customers (registration_status);
CREATE INDEX IF NOT EXISTS idx_customers_last_contact ON customers (last_contact_at);
CREATE INDEX IF NOT EXISTS idx_customers_registered_at ON customers (registered_at);

CREATE TABLE IF NOT EXISTS campaign_sends (
  id          SERIAL PRIMARY KEY,
  phone       TEXT REFERENCES customers(phone),
  segment     TEXT,
  sent_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_campaign_sends_phone ON campaign_sends (phone);
