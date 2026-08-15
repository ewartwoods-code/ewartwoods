const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,
  ssl: process.env.PGSSL === 'require' ? { rejectUnauthorized: false } : false
});

// Viena shema visam platformam. Atslega ir (platform, ext_id).
const SCHEMA = `
CREATE TABLE IF NOT EXISTS config (
key text PRIMARY KEY,
value text,
updated_at timestamptz DEFAULT now()
);
CREATE TABLE IF NOT EXISTS items (
platform text NOT NULL,
ext_id text NOT NULL,
url text,
title text,
sku text,
st8 text,
price numeric,
ccy text,
tags text,
img text,
desc_h text,
seo_h text,
extra jsonb,
lastmod bigint,
created bigint,
last_seen date,
PRIMARY KEY (platform, ext_id)
);
CREATE TABLE IF NOT EXISTS metrics (
date date NOT NULL,
platform text NOT NULL,
ext_id text NOT NULL,
pv_tot integer,
pv_d integer,
fav integer,
ord integer,
rev numeric,
ccy text,
spend numeric,
clicks integer,
impr integer,
src text DEFAULT 'api',
PRIMARY KEY (date, platform, ext_id)
);
CREATE TABLE IF NOT EXISTS chlog (
id bigserial PRIMARY KEY,
date date NOT NULL,
lid bigint,
tips text,
lauks text,
vecais text,
jaunais text,
apraksts text,
avots text DEFAULT 'auto',
statuss text DEFAULT 'gaida',
spried_date date,
spriedums text,
url text
);
CREATE TABLE IF NOT EXISTS runs (
id bigserial PRIMARY KEY,
started timestamptz DEFAULT now(),
ended timestamptz,
ok boolean,
summary text
);
ALTER TABLE chlog ADD COLUMN IF NOT EXISTS platform text;
ALTER TABLE chlog ADD COLUMN IF NOT EXISTS ext_id text;
ALTER TABLE metrics ADD COLUMN IF NOT EXISTS oos boolean;
CREATE INDEX IF NOT EXISTS metrics_item_idx ON metrics (platform, ext_id, date);
CREATE INDEX IF NOT EXISTS chlog_item_idx ON chlog (platform, ext_id, date);
`;

// Vecas Etsy tabulas parnesam vienreiz, ja tadas ir.
const MIGRATE = `
DO $$
BEGIN
IF to_regclass('public.listings') IS NOT NULL THEN
INSERT INTO items (platform, ext_id, url, title, sku, st8, price, ccy, tags, img, desc_h, lastmod, created, last_seen)
SELECT 'etsy', lid::text, url, title, sku, st8, price, ccy, tags, img, desc_h, lastmod, created, last_seen
FROM listings
ON CONFLICT (platform, ext_id) DO NOTHING;
END IF;
IF to_regclass('public.snap_d') IS NOT NULL THEN
INSERT INTO metrics (date, platform, ext_id, pv_tot, pv_d, fav, ord, rev, ccy)
SELECT date, 'etsy', lid::text, pv_tot, pv_d, fav, ord, rev, ccy
FROM snap_d
ON CONFLICT (date, platform, ext_id) DO NOTHING;
END IF;
UPDATE chlog SET platform = 'etsy' WHERE platform IS NULL;
UPDATE chlog SET ext_id = lid::text WHERE ext_id IS NULL AND lid IS NOT NULL;
END $$;
`;

async function init() {
  await pool.query(SCHEMA);
  await pool.query(MIGRATE);
}

async function cfgGet(key) {
  const r = await pool.query('SELECT value FROM config WHERE key = $1', [key]);
  return r.rows[0] ? r.rows[0].value : null;
}

async function cfgSet(key, value) {
  await pool.query('INSERT INTO config (key, value, updated_at) VALUES ($1, $2, now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()', [key, value == null ? null : String(value)]);
}

module.exports = { pool, init, cfgGet, cfgSet };
