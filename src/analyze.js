const { pool } = require('./db');

const WINDOW = Number(process.env.WINDOW_DAYS || 14);
const MIN_DAYS = Number(process.env.MIN_DAYS_FOR_VERDICT || 10);
const MIN_PRE_PV = 30;
const NEW_LISTING_DAYS = 30;

const HIST = `
CREATE TABLE IF NOT EXISTS analize (
  id        bigserial PRIMARY KEY,
  run_at    timestamptz DEFAULT now(),
  chlog_id  bigint,
  lid       bigint,
  date      date,
  n_pre     integer,
  n_post    integer,
  pv_pre    integer,
  pv_post   integer,
  ord_pre   integer,
  ord_post  integer,
  cvr_pre   numeric,
  cvr_post  numeric,
  spriedums text
);
CREATE INDEX IF NOT EXISTS analize_chlog_idx ON analize (chlog_id, run_at);
`;

const addDays = (iso, n) => {
  const d = new Date(iso + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

const daysBetween = (a, b) =>
  Math.round((Date.parse(b + 'T12:00:00Z') - Date.parse(a + 'T12:00:00Z')) / 86400000);

const iso = (v) => (v && v.toISOString ? v.toISOString().slice(0, 10) : String(v));

const num = (x) => (x == null ? 0 : Number(x));

// Procentpunkti un procenti, latviski ar komatu
const pp = (x) => (x >= 0 ? '+' : '') + x.toFixed(2).replace('.', ',') + 'pp';
const pc = (x) => (x >= 0 ? '+' : '') + Math.round(x) + '%';

// Sezona: ja logs skar novembra otro pusi lidz janvara sakumam
function touchesSeason(fromIso, toIso) {
  for (let d = fromIso; daysBetween(d, toIso) >= 0; d = addDays(d, 1)) {
    const m = Number(d.slice(5, 7));
    const day = Number(d.slice(8, 10));
    if ((m === 11 && day >= 15) || m === 12 || (m === 1 && day <= 10)) return true;
  }
  return false;
}

async function judge(change, today) {
  const date = iso(change.date);
  const lid = Number(change.lid);
  const age = daysBetween(date, today);

  // Izmaina jaunaka par 15 dienam - spriedumu nesniedz vispar
  if (age < WINDOW + 1) {
    return { statuss: 'testee', spriedums: `gaida: pagajusas ${age} no ${WINDOW + 1} dienam` };
  }

  const preFrom = addDays(date, -WINDOW);
  const preTo = addDays(date, -1);
  const postFrom = addDays(date, 1);
  const postTo = addDays(date, WINDOW);

  const other = await pool.query(
    `SELECT COUNT(*)::int AS n FROM chlog
      WHERE lid = $1 AND id <> $2 AND date >= $3 AND date <= $4`,
    [lid, change.id, preFrom, postTo]
  );
  if (other.rows[0].n > 0) {
    return { statuss: 'novertets', spriedums: 'piesarnots: loga vel viena izmaina tam pasam listingam' };
  }

  const m = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE date BETWEEN $2 AND $3 AND pv_d IS NOT NULL)::int AS n_pre,
       COUNT(*) FILTER (WHERE date BETWEEN $4 AND $5 AND pv_d IS NOT NULL)::int AS n_post,
       COALESCE(SUM(pv_d) FILTER (WHERE date BETWEEN $2 AND $3), 0)::int AS pv_pre,
       COALESCE(SUM(pv_d) FILTER (WHERE date BETWEEN $4 AND $5), 0)::int AS pv_post,
       COALESCE(SUM(ord) FILTER (WHERE date BETWEEN $2 AND $3), 0)::int AS ord_pre,
       COALESCE(SUM(ord) FILTER (WHERE date BETWEEN $4 AND $5), 0)::int AS ord_post
     FROM snap_d WHERE lid = $1`,
    [lid, preFrom, preTo, postFrom, postTo]
  );
  const s = m.rows[0];

  const warn = [];
  if (s.n_pre < MIN_DAYS || s.n_post < MIN_DAYS) {
    warn.push(`nedross: dienas ar datiem ${s.n_pre}/${s.n_post}`);
  }
  if (s.pv_pre < MIN_PRE_PV) {
    return {
      statuss: 'novertets',
      spriedums: `par maz datu: pre loga tikai ${s.pv_pre} skatijumi`,
      stats: s
    };
  }

  const created = await pool.query('SELECT created FROM listings WHERE lid = $1', [lid]);
  const createdTs = created.rows[0] ? num(created.rows[0].created) : 0;
  if (createdTs) {
    const createdIso = new Date(createdTs * 1000).toISOString().slice(0, 10);
    if (daysBetween(createdIso, date) < NEW_LISTING_DAYS) {
      warn.push('jauns listings: pirmajas 30 dienas Etsy pastiprina, spriedums vajs');
    }
  }
  if (touchesSeason(preFrom, postTo)) warn.push('sezona: logs skar svetku periodu');

  const cvrPre = s.pv_pre ? s.ord_pre / s.pv_pre : 0;
  const cvrPost = s.pv_post ? s.ord_post / s.pv_post : 0;
  const dCvr = (cvrPost - cvrPre) * 100;
  const dOrd = s.ord_pre > 0 ? ((s.ord_post - s.ord_pre) / s.ord_pre) * 100 : s.ord_post > 0 ? 100 : 0;

  let head;
  if (s.ord_post > s.ord_pre && cvrPost >= cvrPre) head = 'nostradaja';
  else if (s.ord_post < s.ord_pre && cvrPost <= cvrPre) head = 'pasliktinaja';
  else if (s.ord_post === s.ord_pre && Math.abs(dCvr) < 0.01) head = 'bez izmainam';
  else head = 'neskaidrs';

  const body = `CVR ${pp(dCvr)}, ORD ${pc(dOrd)} (N ${s.n_pre}/${s.n_post}, PV ${s.pv_pre}->${s.pv_post})`;
  const spriedums = [`${head}: ${body}`, ...warn].join(' | ');

  return { statuss: 'novertets', spriedums, stats: { ...s, cvrPre, cvrPost } };
}

async function runAnalysis(todayIso) {
  await pool.query(HIST);
  const today = todayIso || new Date().toISOString().slice(0, 10);

  const { rows } = await pool.query(
    `SELECT id, date, lid FROM chlog
      WHERE statuss <> 'atcelts'
      ORDER BY date DESC LIMIT 1000`
  );

  let judged = 0;
  for (const c of rows) {
    const r = await judge(c, today);
    await pool.query(
      `UPDATE chlog SET statuss = $2, spriedums = $3, spried_date = $4 WHERE id = $1`,
      [c.id, r.statuss, r.spriedums, today]
    );
    if (r.statuss === 'novertets') {
      judged++;
      const s = r.stats || {};
      await pool.query(
        `INSERT INTO analize
           (chlog_id, lid, date, n_pre, n_post, pv_pre, pv_post, ord_pre, ord_post, cvr_pre, cvr_post, spriedums)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [c.id, Number(c.lid), iso(c.date), s.n_pre ?? null, s.n_post ?? null,
         s.pv_pre ?? null, s.pv_post ?? null, s.ord_pre ?? null, s.ord_post ?? null,
         s.cvrPre ?? null, s.cvrPost ?? null, r.spriedums]
      );
    }
  }
  return { skatitas: rows.length, novertetas: judged };
}

module.exports = { runAnalysis };
