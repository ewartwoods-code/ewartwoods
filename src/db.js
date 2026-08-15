const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,
  ssl: process.env.PGSSL === 'require' ? { rejectUnauthorized: false } : false
});

const SCHEMA = `
CREATE TABLE IF NOT EXISTS config (
  key   text PRIMARY KEY,
  value text,
  updated_at timestamptz DEFAULT now()
);
CREATE TABLE IF NOT EXISTS listings (
  lid      bigint PRIMARY KEY,
  url      text,
  title    text,
  sku      text,
  st8      text,
  price    numeric,
  ccy      text,
  tags     text,
  img      text,
  desc_h   text,
  lastmod  bigint,
  created  bigint,
  last_seen date
);
CREATE TABLE IF NOT EXISTS snap_d (
  date   date   NOT NULL,
  lid    bigint NOT NULL,
  pv_tot integer,
  pv_d   integer,
  fav    integer,
  ord    integer,
  rev    numeric,
  ccy    text,
  src_data text DEFAULT 'api',
  PRIMARY KEY (date, lid)
);
CREATE TABLE IF NOT EXISTS chlog (
  id       bigserial PRIMARY KEY,
  date     date NOT NULL,
  lid      bigint NOT NULL,
  tips     text,
  lauks    text,
  vecais   text,
  jaunais  text,
  apraksts text,
  avots    text DEFAULT 'auto',
  statuss  text DEFAULT 'gaida',
  spried_date date,
  spriedums   text,
  url      text
);
CREATE TABLE IF NOT EXISTS runs (
  id      bigserial PRIMARY KEY,
  started timestamptz DEFAULT now(),
  ended   timestamptz,
  ok      boolean,
  summary text
);
CREATE INDEX IF NOT EXISTS snap_d_lid_idx ON snap_d (lid, date);
CREATE INDEX IF NOT EXISTS chlog_lid_idx  ON chlog  (lid, date);
`;

async function init() {
  await pool.query(SCHEMA);
}

async function cfgGet(key) {
  const r = await pool.query('SELECT value FROM config WHERE key = $1', [key]);
  return r.rows[0] ? r.rows[0].value : null;
}

async function cfgSet(key, value) {
  await pool.query(
    `INSERT INTO config (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, value == null ? null : String(value)]
  );
}

module.exports = { pool, init, cfgGet, cfgSet };
