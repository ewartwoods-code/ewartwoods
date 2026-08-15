const { pool } = require('./db');

// ECB dienas kursi. rate = cik valutas vienibu par 1 EUR.
const URL90 = 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist-90d.xml';
const URLALL = 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist.xml';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS fx (
date date NOT NULL,
ccy text NOT NULL,
rate numeric NOT NULL,
PRIMARY KEY (date, ccy)
);
CREATE INDEX IF NOT EXISTS fx_ccy_idx ON fx (ccy, date);
`;

function parse(xml) {
  const out = [];
  const bloki = String(xml).split('<Cube time=');
  for (let i = 1; i < bloki.length; i++) {
    const b = bloki[i];
    const date = b.slice(1, 11);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const re = /currency='([A-Z]{3})'\s+rate='([0-9.]+)'/g;
    let m;
    while ((m = re.exec(b)) !== null) out.push({ date, ccy: m[1], rate: Number(m[2]) });
  }
  return out;
}

async function refresh(full) {
  await pool.query(SCHEMA);
  const have = await pool.query('SELECT COUNT(*)::int AS n FROM fx');
  const pilns = full || have.rows[0].n === 0;
  const res = await fetch(pilns ? URLALL : URL90);
  if (!res.ok) throw new Error('ECB ' + res.status);
  const rows = parse(await res.text());
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const r of rows) {
      await client.query('INSERT INTO fx (date, ccy, rate) VALUES ($1,$2,$3) ON CONFLICT (date, ccy) DO UPDATE SET rate = EXCLUDED.rate', [r.date, r.ccy, r.rate]);
    }
    await client.query("INSERT INTO fx (date, ccy, rate) VALUES ('1999-01-01','EUR',1) ON CONFLICT DO NOTHING");
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  return { pilns: Boolean(pilns), rindas: rows.length };
}

// Menesa videjais kurss katrai valutai.
async function monthly(fromIso, toIso) {
  const r = await pool.query("SELECT to_char(date, 'YYYY-MM') AS men, ccy, ROUND(AVG(rate)::numeric, 6) AS rate FROM fx WHERE date >= $1 AND date <= $2 GROUP BY 1, 2 ORDER BY 1, 2", [fromIso, toIso]);
  return r.rows;
}

// Tuvakais kurss uz doto dienu (nedelas nogales ECB kursu nedod).
async function rate(dateIso, ccy) {
  const c = String(ccy || '').toUpperCase();
  if (!c || c === 'EUR') return 1;
  const r = await pool.query('SELECT rate FROM fx WHERE ccy = $1 AND date <= $2 ORDER BY date DESC LIMIT 1', [c, dateIso]);
  return r.rows[0] ? Number(r.rows[0].rate) : null;
}

async function eur(amount, ccy, dateIso) {
  const k = await rate(dateIso, ccy);
  if (!k) return null;
  return Number((Number(amount || 0) / k).toFixed(2));
}

module.exports = { refresh, monthly, rate, eur, parse };
