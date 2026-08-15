const { pool } = require('./db');

const WINDOW = Number(process.env.WINDOW_DAYS || 14);
const MIN_DAYS = Number(process.env.MIN_DAYS_FOR_VERDICT || 10);
const MIN_PRE_PV = 30;
const NEW_ITEM_DAYS = 30;

const HIST = `
CREATE TABLE IF NOT EXISTS analize (
id bigserial PRIMARY KEY,
run_at timestamptz DEFAULT now(),
chlog_id bigint,
platform text,
ext_id text,
date date,
n_pre integer,
n_post integer,
pv_pre integer,
pv_post integer,
ord_pre integer,
ord_post integer,
cvr_pre numeric,
cvr_post numeric,
spriedums text
);
ALTER TABLE analize ADD COLUMN IF NOT EXISTS platform text;
ALTER TABLE analize ADD COLUMN IF NOT EXISTS ext_id text;
CREATE INDEX IF NOT EXISTS analize_chlog_idx ON analize (chlog_id, run_at);
`;

const addDays = (iso, n) => {
  const d = new Date(iso + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

const daysBetween = (a, b) => Math.round((Date.parse(b + 'T12:00:00Z') - Date.parse(a + 'T12:00:00Z')) / 86400000);

const iso = (v) => (v && v.toISOString ? v.toISOString().slice(0, 10) : String(v));

const pp = (x) => (x >= 0 ? '+' : '') + x.toFixed(2).replace('.', ',') + 'pp';
const pc = (x) => (x >= 0 ? '+' : '') + Math.round(x) + '%';

function touchesSeason(fromIso, toIso) {
  for (let d = fromIso; daysBetween(d, toIso) >= 0; d = addDays(d, 1)) {
    const m = Number(d.slice(5, 7));
    const day = Number(d.slice(8, 10));
    if ((m === 11 && day >= 15) || m === 12 || (m === 1 && day <= 10)) return true;
  }
  return false;
}

async function judge(c, today) {
  const date = iso(c.date);
  const platform = c.platform || 'etsy';
  const extId = String(c.ext_id);
  const age = daysBetween(date, today);

if (age < WINDOW + 1) {
  return { statuss: 'testee', spriedums: 'gaida: pagajusas ' + age + ' no ' + (WINDOW + 1) + ' dienam' };
}

const preFrom = addDays(date, -WINDOW);
  const preTo = addDays(date, -1);
  const postFrom = addDays(date, 1);
  const postTo = addDays(date, WINDOW);

const other = await pool.query('SELECT COUNT(*)::int AS n FROM chlog WHERE platform = $1 AND ext_id = $2 AND id <> $3 AND date >= $4 AND date <= $5', [platform, extId, c.id, preFrom, postTo]);
  if (other.rows[0].n > 0) {
    return { statuss: 'novertets', spriedums: 'piesarnots: loga vel viena izmaina tai pasai precei' };
  }

const m = await pool.query('SELECT COUNT(*) FILTER (WHERE date BETWEEN $3 AND $4 AND (pv_d IS NOT NULL OR ord IS NOT NULL))::int AS n_pre, COUNT(*) FILTER (WHERE date BETWEEN $5 AND $6 AND (pv_d IS NOT NULL OR ord IS NOT NULL))::int AS n_post, COALESCE(SUM(pv_d) FILTER (WHERE date BETWEEN $3 AND $4), 0)::int AS pv_pre, COALESCE(SUM(pv_d) FILTER (WHERE date BETWEEN $5 AND $6), 0)::int AS pv_post, COALESCE(SUM(ord) FILTER (WHERE date BETWEEN $3 AND $4), 0)::int AS ord_pre, COALESCE(SUM(ord) FILTER (WHERE date BETWEEN $5 AND $6), 0)::int AS ord_post FROM metrics WHERE platform = $1 AND ext_id = $2', [platform, extId, preFrom, preTo, postFrom, postTo]);
  const s = m.rows[0];

const warn = [];
  if (s.n_pre < MIN_DAYS || s.n_post < MIN_DAYS) {
    warn.push('nedross: dienas ar datiem ' + s.n_pre + '/' + s.n_post);
  }

// Shopify neatdod skatijumus, tapec tur spriezam tikai pec pasutijumiem.
const hasViews = s.pv_pre > 0 || s.pv_post > 0;
  if (hasViews && s.pv_pre < MIN_PRE_PV) {
    return { statuss: 'novertets', spriedums: 'par maz datu: pre loga tikai ' + s.pv_pre + ' skatijumi', stats: s };
  }
  if (!hasViews && s.ord_pre === 0 && s.ord_post === 0) {
    return { statuss: 'novertets', spriedums: 'par maz datu: neviena pardosana ne pirms, ne pec', stats: s };
  }

const it = await pool.query('SELECT created FROM items WHERE platform = $1 AND ext_id = $2', [platform, extId]);
  const createdTs = it.rows[0] ? Number(it.rows[0].created || 0) : 0;
  if (createdTs) {
    const createdIso = new Date(createdTs * 1000).toISOString().slice(0, 10);
    if (daysBetween(createdIso, date) < NEW_ITEM_DAYS) {
      warn.push('jauna prece: pirmajas 30 dienas platforma pastiprina, spriedums vajs');
    }
  }
  if (touchesSeason(preFrom, postTo)) warn.push('sezona: logs skar svetku periodu');

const cvrPre = s.pv_pre ? s.ord_pre / s.pv_pre : 0;
  const cvrPost = s.pv_post ? s.ord_post / s.pv_post : 0;
  const dCvr = (cvrPost - cvrPre) * 100;
  const dOrd = s.ord_pre > 0 ? ((s.ord_post - s.ord_pre) / s.ord_pre) * 100 : s.ord_post > 0 ? 100 : 0;

let head;
  if (hasViews) {
    if (s.ord_post > s.ord_pre && cvrPost >= cvrPre) head = 'nostradaja';
    else if (s.ord_post < s.ord_pre && cvrPost <= cvrPre) head = 'pasliktinaja';
    else if (s.ord_post === s.ord_pre && Math.abs(dCvr) < 0.01) head = 'bez izmainam';
    else head = 'neskaidrs';
  } else {
    if (s.ord_post > s.ord_pre) head = 'nostradaja';
    else if (s.ord_post < s.ord_pre) head = 'pasliktinaja';
    else head = 'bez izmainam';
    warn.push('bez skatijumiem: platforma nedod PV, spriedums tikai pec ORD');
  }

const body = hasViews ? 'CVR ' + pp(dCvr) + ', ORD ' + pc(dOrd) + ' (N ' + s.n_pre + '/' + s.n_post + ', PV ' + s.pv_pre + '->' + s.pv_post + ')' : 'ORD ' + pc(dOrd) + ' (' + s.ord_pre + '->' + s.ord_post + ', N ' + s.n_pre + '/' + s.n_post + ')';

return { statuss: 'novertets', spriedums: [head + ': ' + body, ...warn].join(' | '), stats: { ...s, cvrPre, cvrPost } };
}

async function runAnalysis(todayIso) {
  await pool.query(HIST);
  const today = todayIso || new Date().toISOString().slice(0, 10);

const { rows } = await pool.query("SELECT id, date, platform, ext_id FROM chlog WHERE statuss <> 'atcelts' AND ext_id IS NOT NULL ORDER BY date DESC LIMIT 2000");

let judged = 0;
  for (const c of rows) {
    const r = await judge(c, today);
    await pool.query('UPDATE chlog SET statuss = $2, spriedums = $3, spried_date = $4 WHERE id = $1', [c.id, r.statuss, r.spriedums, today]);
    if (r.statuss === 'novertets') {
      judged++;
      const s = r.stats || {};
      await pool.query('INSERT INTO analize (chlog_id, platform, ext_id, date, n_pre, n_post, pv_pre, pv_post, ord_pre, ord_post, cvr_pre, cvr_post, spriedums) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)', [c.id, c.platform, String(c.ext_id), iso(c.date), s.n_pre == null ? null : s.n_pre, s.n_post == null ? null : s.n_post, s.pv_pre == null ? null : s.pv_pre, s.pv_post == null ? null : s.pv_post, s.ord_pre == null ? null : s.ord_pre, s.ord_post == null ? null : s.ord_post, s.cvrPre == null ? null : s.cvrPre, s.cvrPost == null ? null : s.cvrPost, r.spriedums]);
    }
  }
  return { skatitas: rows.length, novertetas: judged };
}

module.exports = { runAnalysis };
