const crypto = require('crypto');
const { pool } = require('./db');

const hash = (s) => crypto.createHash('sha256').update(String(s || '')).digest('base64url').slice(0, 16);

// Lauki, ko salidzinam. Viena rinda CHLOG uz vienu preci viena diena.
const FIELDS = [
['title', 'TITLE', 'Nosaukums'],
['tags', 'TAGS', 'Tagi'],
['price', 'PRICE', 'Cena'],
['img', 'IMG', 'Bildes'],
['desc_h', 'DESC_H', 'Apraksts'],
['seo_h', 'SEO', 'SEO teksti'],
['st8', 'ST8', 'Statuss']
];

function diff(prev, next) {
if (!prev) return null;
const tips = [], lauks = [], vecais = [], jaunais = [];
for (const [key, code, human] of FIELDS) {
const a = prev[key] == null ? '' : String(prev[key]);
const b = next[key] == null ? '' : String(next[key]);
if (a === b) continue;
tips.push(code);
lauks.push(human);
vecais.push(code + ': ' + a.slice(0, 120));
jaunais.push(code + ': ' + b.slice(0, 120));
}
if (!tips.length) return null;
return { tips: tips.join(','), lauks: lauks.join(', '), vecais: vecais.join(' | '), jaunais: jaunais.join(' | ') };
}

async function saveItems(platform, dateIso, rows) {
const prevRes = await pool.query('SELECT * FROM items WHERE platform = $1', [platform]);
const prev = new Map(prevRes.rows.map((r) => [String(r.ext_id), r]));

let changes = 0;
const client = await pool.connect();
try {
await client.query('BEGIN');
for (const r of rows) {
const id = String(r.ext_id);
const d = diff(prev.get(id), r);
if (d) {
changes++;
await client.query('INSERT INTO chlog (date, platform, ext_id, lid, tips, lauks, vecais, jaunais, avots, statuss, url) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)', [dateIso, platform, id, /^[0-9]+$/.test(id) ? Number(id) : null, d.tips, d.lauks, d.vecais, d.jaunais, 'auto', 'gaida', r.url]);
}
await client.query('INSERT INTO items (platform,ext_id,url,title,sku,st8,price,ccy,tags,img,desc_h,seo_h,extra,lastmod,created,last_seen) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) ON CONFLICT (platform, ext_id) DO UPDATE SET url=EXCLUDED.url, title=EXCLUDED.title, sku=EXCLUDED.sku, st8=EXCLUDED.st8, price=EXCLUDED.price, ccy=EXCLUDED.ccy, tags=EXCLUDED.tags, img=EXCLUDED.img, desc_h=EXCLUDED.desc_h, seo_h=EXCLUDED.seo_h, extra=EXCLUDED.extra, lastmod=EXCLUDED.lastmod, created=EXCLUDED.created, last_seen=EXCLUDED.last_seen', [platform, id, r.url, r.title, r.sku, r.st8, r.price, r.ccy, r.tags, r.img, r.desc_h, r.seo_h, r.extra ? JSON.stringify(r.extra) : null, r.lastmod, r.created, dateIso]);
}
await client.query('COMMIT');
} catch (e) {
await client.query('ROLLBACK');
throw e;
} finally {
client.release();
}
return { items: rows.length, changes };
}

// pv_d rekina pret ieprieksejo dienu, ja pv_tot ir kumulativs (Etsy).
async function saveMetrics(platform, dateIso, list, cumulativeViews = false) {
let pvPrev = new Map();
if (cumulativeViews) {
const prevDay = new Date(dateIso + 'T12:00:00Z');
prevDay.setUTCDate(prevDay.getUTCDate() - 1);
const r = await pool.query('SELECT ext_id, pv_tot FROM metrics WHERE platform = $1 AND date = $2', [platform, prevDay.toISOString().slice(0, 10)]);
pvPrev = new Map(r.rows.map((x) => [String(x.ext_id), x.pv_tot]));
}

for (const m of list) {
  if (m.date) dateIso = m.date;
const id = String(m.ext_id);
const y = pvPrev.get(id);
const pvD = m.pv_d != null ? m.pv_d : (cumulativeViews && m.pv_tot != null && y != null ? m.pv_tot - Number(y) : null);
await pool.query('INSERT INTO metrics (date,platform,ext_id,pv_tot,pv_d,fav,ord,rev,ccy,spend,clicks,impr,src,oos) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT (date,platform,ext_id) DO UPDATE SET pv_tot=COALESCE(EXCLUDED.pv_tot, metrics.pv_tot), pv_d=COALESCE(EXCLUDED.pv_d, metrics.pv_d), fav=COALESCE(EXCLUDED.fav, metrics.fav), ord=COALESCE(EXCLUDED.ord, metrics.ord), rev=COALESCE(EXCLUDED.rev, metrics.rev), ccy=COALESCE(EXCLUDED.ccy, metrics.ccy), spend=COALESCE(EXCLUDED.spend, metrics.spend), clicks=COALESCE(EXCLUDED.clicks, metrics.clicks), impr=COALESCE(EXCLUDED.impr, metrics.impr), oos=COALESCE(EXCLUDED.oos, metrics.oos)', [dateIso, platform, id, m.pv_tot == null ? null : m.pv_tot, pvD, m.fav == null ? null : m.fav, m.ord == null ? null : m.ord, m.rev == null ? null : m.rev, m.ccy || null, m.spend == null ? null : m.spend, m.clicks == null ? null : m.clicks, m.impr == null ? null : m.impr, m.src || 'api', m.oos == null ? null : Boolean(m.oos)]);
}
return { metrics: list.length };
}

module.exports = { hash, diff, saveItems, saveMetrics, FIELDS };
