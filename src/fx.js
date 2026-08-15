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

// Iet cauri visiem <Cube> tagiem sec1ba. Dienas tags uzstada datumu, valutas tags pieliek kursu.
function parse(xml) {
  const out = [];
  let cur = null;
  const re = /<Cube([^>]*?)\/?>/g;
  let m;
  while ((m = re.exec(String(xml))) !== null) {
    const a = m[1];
    const t = a.match(/time=['"]([0-9]{4}-[0-9]{2}-[0-9]{2})['"]/);
    if (t) { cur = t[1]; continue; }
    const c = a.match(/currency=['"]([A-Z]{3})['"]/);
    const r = a.match(/rate=['"]([0-9.]+)['"]/);
    if (cur && c && r) out.push({ date: cur, ccy: c[1], rate: Number(r[1]) });
  }
  return out;
}

async function refresh(full) {
  await pool.query(SCHEMA);
  const have = await pool.query('SELECT COUNT(*)::int AS n FROM fx');
  const pilns = full || have.rows[0].n === 0;
  const res = await fetch(pilns ? URLALL : URL90);
  if (!res.ok) throw new Error('ECB ' + res.status);
  const teksts = await res.text();
  const rows = parse(teksts);
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
  return { pilns: Boolean(pilns), rindas: rows.length, baiti: teksts.length };
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
