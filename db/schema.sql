-- ============================================================
-- Rede Peças — Database Schema (PostgreSQL)
-- Ported from the original prototype (rede-pecas-agent/schema.sql)
-- with identifiers translated to English. Data content (part names,
-- synonyms) was originally Portuguese, hence the original 'portuguese'
-- full-text search configuration — as of 2026-07-14 the project is being
-- built/tested in English for now (see CLAUDE.md "Language split"), so
-- search_vector below uses the 'english' config to match.
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
-- MINIFICATION: categories, the static vehicle-compatibility catalog
-- (formerly "vehicles"), and its join table "compatibilities" have zero
-- code references anywhere in the app (nothing populates or reads them
-- outside seed data) and are dropped entirely. Guarded so a database
-- already migrated to the new schema — where "vehicles" is the new
-- phone-keyed table created later in this file — is never affected.
-- ============================================================
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'vehicles' AND column_name = 'year_from'
  ) THEN
    DROP TABLE IF EXISTS compatibilities;
    DROP TABLE vehicles;
  END IF;
END $$;

DROP TABLE IF EXISTS compatibilities;

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

  -- Optional attached service (e.g. installation), offered as a follow-up
  -- when a customer picks this product — see CLAUDE.md message pipeline.
  service_offered  BOOLEAN DEFAULT false,
  service_name     TEXT,
  service_price    NUMERIC(12,2),

  -- Control
  active           BOOLEAN DEFAULT true,
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW(),

  -- Required by the supplier batch-import upsert
  UNIQUE (supplier_id, reference),

  -- Full-text search index (auto-generated). Config is 'english' for now
  -- (2026-07-14) while catalog data is being entered in English — see the
  -- file header comment and CLAUDE.md "Language split".
  search_vector    TSVECTOR GENERATED ALWAYS AS (
    to_tsvector('english',
      immutable_unaccent(name) || ' ' ||
      immutable_unaccent(COALESCE(brand, '')) || ' ' ||
      immutable_unaccent(COALESCE(reference, '')) || ' ' ||
      immutable_unaccent(COALESCE(oem_reference, '')) || ' ' ||
      immutable_unaccent(COALESCE(synonyms, '')) || ' ' ||
      immutable_unaccent(COALESCE(category_keywords, ''))
    )
  ) STORED
);

ALTER TABLE products DROP COLUMN IF EXISTS category_id;
-- Replaced by the waitlist_requests table below — a real table records who
-- joined and when, which an opaque array column couldn't.
ALTER TABLE products DROP COLUMN IF EXISTS waitlist_phones;
ALTER TABLE products ADD COLUMN IF NOT EXISTS service_offered BOOLEAN DEFAULT false;
ALTER TABLE products ADD COLUMN IF NOT EXISTS service_name TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS service_price NUMERIC(12,2);

-- A generated column's expression can't be changed via ALTER COLUMN, so an
-- existing database (created before the 'portuguese' -> 'english' switch
-- above) needs search_vector dropped and re-added to pick up the new config.
-- Safe to re-run: once it matches, this whole block is a same-definition
-- drop+recreate (wasteful but harmless), not a no-op skip.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'products' AND column_name = 'search_vector'
  ) AND (
    SELECT pg_get_expr(adbin, adrelid) FROM pg_attrdef
    WHERE adrelid = 'products'::regclass
      AND adnum = (SELECT attnum FROM pg_attribute WHERE attrelid = 'products'::regclass AND attname = 'search_vector')
  ) NOT LIKE '%english%' THEN
    ALTER TABLE products DROP COLUMN search_vector;
    ALTER TABLE products ADD COLUMN search_vector TSVECTOR GENERATED ALWAYS AS (
      to_tsvector('english',
        immutable_unaccent(name) || ' ' ||
        immutable_unaccent(COALESCE(brand, '')) || ' ' ||
        immutable_unaccent(COALESCE(reference, '')) || ' ' ||
        immutable_unaccent(COALESCE(oem_reference, '')) || ' ' ||
        immutable_unaccent(COALESCE(synonyms, '')) || ' ' ||
        immutable_unaccent(COALESCE(category_keywords, ''))
      )
    ) STORED;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_products_fts ON products USING GIN (search_vector);
CREATE INDEX IF NOT EXISTS idx_products_supplier ON products (supplier_id);
CREATE INDEX IF NOT EXISTS idx_products_price ON products (price);
CREATE INDEX IF NOT EXISTS idx_products_active ON products (active) WHERE active = true;

DROP TABLE IF EXISTS categories;

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
  -- Status state machine: awaiting_payment (placeholder while the customer is
  -- still deciding on an attached service, if any — see product.service.ts)
  -- → awaiting_stock_confirmation (admin confirms availability with the
  -- supplier via the admin panel, not WhatsApp) → stock_unavailable (terminal,
  -- admin declines) | awaiting_payment_method → awaiting_bank_subtype |
  -- awaiting_in_person_subtype → awaiting_payment_proof |
  -- awaiting_agent_confirmation → payment_proof_received → approved | rejected.
  -- cancelled is a separate terminal status set by the admin panel's DELETE
  -- /orders/:number (order.controller.ts) — only reachable from a non-terminal
  -- status (an approved/rejected/already-cancelled order can't be cancelled).
  status                  TEXT DEFAULT 'awaiting_payment',
  payment_method          TEXT,
  approved_by             TEXT,
  approved_at             TIMESTAMPTZ,
  customer_engine_number  TEXT,
  -- Payment proof (folded in from the former payment_proofs table —
  -- always a strict 1:1 with the order, so no benefit to a separate table)
  payment_proof_media_id  TEXT,
  payment_proof_media_type TEXT,
  -- Snapshot of the attached service accepted on this order (see
  -- products.service_offered) — copied at accept-time, same idiom as
  -- unit_price, so a later catalog price change never alters a placed order.
  -- NULL means no service was offered or the customer declined it.
  service_name            TEXT,
  service_price           NUMERIC(12,2),
  -- Set once the 20-minute "still confirming with the supplier" courtesy
  -- message has gone out, so the sweep in product.service.ts never resends it.
  stock_confirmation_courtesy_sent BOOLEAN DEFAULT false,
  -- Set once the 15-minute admin-reminder WhatsApp nudge has gone out for this
  -- order, so the sweep in product.service.ts never resends it.
  stock_confirmation_admin_reminder_sent BOOLEAN DEFAULT false,
  created_at              TIMESTAMPTZ DEFAULT NOW(),
  updated_at              TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_proof_media_id TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_proof_media_type TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS service_name TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS service_price NUMERIC(12,2);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS stock_confirmation_courtesy_sent BOOLEAN DEFAULT false;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS stock_confirmation_admin_reminder_sent BOOLEAN DEFAULT false;

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
-- WAITLIST_REQUESTS — customers waiting for a restocked product. A real
-- table (not the earlier products.waitlist_phones array) so the admin panel
-- can list requests with who/which product/when, and notified_at tracks
-- whether the restock notification already went out for that request.
-- ============================================================
CREATE TABLE IF NOT EXISTS waitlist_requests (
  id             SERIAL PRIMARY KEY,
  product_id     INT NOT NULL REFERENCES products(id),
  customer_phone TEXT NOT NULL,
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  notified_at    TIMESTAMPTZ,
  UNIQUE (product_id, customer_phone)
);

CREATE INDEX IF NOT EXISTS idx_waitlist_requests_product ON waitlist_requests (product_id);
CREATE INDEX IF NOT EXISTS idx_waitlist_requests_notified ON waitlist_requests (notified_at);

-- ============================================================
-- ADMIN_ALERTS — replaces the old "push a WhatsApp message to the admin's
-- own phone" pattern for payment-proof-received and in-person-payment-
-- requested events. Every SYSTEM → ADMIN notification now lives in the admin
-- panel as a queue the admin reads/marks read, not a WhatsApp push.
-- ============================================================
CREATE TABLE IF NOT EXISTS admin_alerts (
  id            SERIAL PRIMARY KEY,
  type          TEXT NOT NULL,              -- 'payment_proof' | 'in_person_payment'
  order_number  TEXT REFERENCES orders(number),
  message       TEXT NOT NULL,
  read_at       TIMESTAMPTZ,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_admin_alerts_read ON admin_alerts (read_at);
CREATE INDEX IF NOT EXISTS idx_admin_alerts_created ON admin_alerts (created_at);

-- ============================================================
-- NHTSA vehicle cache (avoids repeated NHTSA API calls for the same VIN)
-- ============================================================
ALTER TABLE IF EXISTS vin_cache RENAME TO nhtsa_vehicles;

CREATE TABLE IF NOT EXISTS nhtsa_vehicles (
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
-- ADMIN_USERS — individual admin-panel accounts (replaces the single shared
-- ADMIN_PASSWORD login). `phone` is required so a forgotten password can be
-- reset via a WhatsApp-delivered code — no email/SMTP service exists in this
-- project. reset_code_hash/reset_code_expires_at hold a single pending reset
-- code at a time (bcrypt-hashed, not stored plain); NULL when none pending.
-- ============================================================
CREATE TABLE IF NOT EXISTS admin_users (
  id                      SERIAL PRIMARY KEY,
  name                    TEXT NOT NULL,
  email                   TEXT NOT NULL UNIQUE,
  phone                   TEXT NOT NULL,
  password_hash           TEXT NOT NULL,
  reset_code_hash         TEXT,
  reset_code_expires_at   TIMESTAMPTZ,
  created_at              TIMESTAMPTZ DEFAULT NOW(),
  updated_at              TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_admin_users_email ON admin_users (email);

-- ============================================================
-- CRM
-- ============================================================
CREATE TABLE IF NOT EXISTS customers (
  phone                TEXT PRIMARY KEY,
  name                 TEXT,
  nif                  TEXT,                    -- Angolan tax ID
  address              TEXT,
  email                TEXT,
  registration_status  TEXT DEFAULT 'new',      -- new, awaiting_name, awaiting_nif, awaiting_nif_number, awaiting_address, complete (profile only — vehicle ID is tracked independently via the `vehicles` table)
  -- Detected once from the customer's very first message (detectGreetingLocale in
  -- src/utils/greeting.ts) and never re-evaluated afterward — sticky per customer,
  -- not re-detected per message. NULL for rows created before this column existed;
  -- the app resolves NULL to DEFAULT_LOCALE (src/i18n/messages.ts — the environment's
  -- configured MESSAGE_LOCALE, not a hardcoded language) at read time (no reliable
  -- backfill — the original greeting text was never stored).
  locale               TEXT,                    -- 'pt' | 'en'
  first_contact_at     TIMESTAMPTZ DEFAULT NOW(),
  last_contact_at      TIMESTAMPTZ DEFAULT NOW(),
  registered_at        TIMESTAMPTZ,
  contact_count        INT DEFAULT 1,
  active               BOOLEAN DEFAULT true
);

ALTER TABLE customers ADD COLUMN IF NOT EXISTS locale TEXT;

CREATE INDEX IF NOT EXISTS idx_customers_status ON customers (registration_status);
CREATE INDEX IF NOT EXISTS idx_customers_last_contact ON customers (last_contact_at);
CREATE INDEX IF NOT EXISTS idx_customers_registered_at ON customers (registered_at);

DROP TABLE IF EXISTS campaign_sends;

-- ============================================================
-- VEHICLES — a customer can have multiple identified vehicles (see "add
-- another vehicle" in the message pipeline), so `id` is the primary key and
-- `phone` is a plain FK, not unique. `status` distinguishes a confirmed
-- vehicle (NULL/'complete', permanent — no expiry) from an in-progress
-- manual-entry wizard step (30-minute TTL via created_at) on that specific
-- row — at most one in-progress row per phone is enforced by application
-- logic, not a DB constraint. Must be created after `customers` (FK
-- dependency).
-- ============================================================
CREATE TABLE IF NOT EXISTS vehicles (
  id              SERIAL PRIMARY KEY,
  phone           TEXT NOT NULL REFERENCES customers(phone),
  vin             CHAR(17),
  make            TEXT,
  model           TEXT,
  year            TEXT,
  engine_number   TEXT,
  license_plate   TEXT,
  engine_size     TEXT,
  fuel_type       TEXT,
  source          TEXT,               -- 'vin' | 'manual' | 'document'
  status          TEXT,               -- NULL/'complete' = confirmed vehicle; other = in-progress manual wizard step
  attempted_vin   CHAR(17),           -- VIN that failed NHTSA decode before falling back to manual entry
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_vehicles_phone ON vehicles (phone);
CREATE INDEX IF NOT EXISTS idx_vehicles_updated_at ON vehicles (updated_at);
CREATE INDEX IF NOT EXISTS idx_vehicles_status_created ON vehicles (status, created_at);

-- One-time shape migration: `vehicles.phone` used to be the primary key (one
-- vehicle per customer) before multi-vehicle support. Idempotent — a no-op
-- once the `id` column exists.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'vehicles')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'vehicles' AND column_name = 'id') THEN
    ALTER TABLE vehicles ADD COLUMN id SERIAL;
    ALTER TABLE vehicles DROP CONSTRAINT vehicles_pkey;
    ALTER TABLE vehicles ADD PRIMARY KEY (id);
  END IF;
END $$;

-- Customer registration and vehicle ID are now independent state machines (see
-- CLAUDE.md "The message pipeline") — 'awaiting_vehicle_id' no longer exists as a
-- registration_status value. Idempotent: a no-op once every row has been migrated.
UPDATE customers SET registration_status = 'complete' WHERE registration_status = 'awaiting_vehicle_id';

DROP TABLE IF EXISTS vehicle_sessions;
DROP TABLE IF EXISTS manual_vehicle_collections;
