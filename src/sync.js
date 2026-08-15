const crypto = require('crypto');
const { pool, cfgSet } = require('./db');
const etsy = require('./etsy');

const TZ = process.env.TZ_NAME || 'Europe/Riga';

// YYYY-MM-DD konkreta laika josla
function dayStr(d = new Date(), offsetDays = 0) {
  const t = new Date(d.getTime() + offsetDays * 86400000);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(t);
}

function addDays(iso, n) {
  const d = new Date(iso + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Dienas robezas unix sekundes, TZ nobidi nemot no pasas dienas
function dayBounds(iso) {
  const probe = new Date(iso + 'T12:00:00Z');
  const local = new Date(probe.toLocaleString('en-US', { timeZone: TZ }));
  const utc = new Date(probe.toLocaleString('en-US', { timeZone: 'UTC' }));
  const offsetMs = local.getTime() - utc.getTime();
  const start = Date.parse(iso + 'T00:00:00Z') - offsetMs;
  return { from: Math.floor(start / 1000), to: Math.floor(start / 1000) + 86399 };
}

const hash = (s) =>
  crypto.createHash('sha256').update(String(s || '')).digest('base64url').slice(0, 16);

function shapeListing(l) {
  const p = l.price || {};
  const imgs = (l.images || []).map((i) => i.listing_image_id).join(',');
  return {
    lid: Number(l.listing_id),
    url: l.url || `https://www.etsy.com/listing/${l.listing_id}`,
    title: l.title || '',
    sku: (l.skus || []).join(','),
    st8: l.state || '',
    price: p.amount != null && p.divisor ? Number(p.amount) / Number(p.divisor) : null,
    ccy: p.currency_code || null,
    tags: (l.tags || []).join(', '),
    img: hash(imgs),
    desc_h: hash(l.description),
    lastmod: Number(l.last_modified_timestamp || 0),
    created: Number(l.original_creation_timestamp || 0),
    pv_tot: l.views == null ? null : Number(l.views),
    fav: l.num_favorers == null ? null : Number(l.num_favorers)
  };
}

// Kas mainijies pret vakardienas stavokli. Viena rinda uz listingu diena.
const FIELDS = [
  ['title', 'TITLE', 'Nosaukums'],
  ['tags', 'TAGS', 'Tagi'],
  ['price', 'PRICE', 'Cena'],
  ['img', 'IMG', 'Bildes'],
  ['desc_h', 'DESC_H', 'Apraksts'],
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
    vecais.push(`${code}: ${a.slice(0, 120)}`);
    jaunais.push(`${code}: ${b.slice(0, 120)}`);
  }
  if (!tips.length) return null;
  return {
    tips: tips.join(','),
    lauks: lauks.join(', '),
    vecais: vecais.join(' | '),
    jaunais: jaunais.join(' | ')
  };
}

async function syncListings(dateIso) {
  const shop = await etsy.shopId();
  const raw = await etsy.all(`/shops/${shop}/listings`, { state: 'active', includes: 'Images' });
  const rows = raw.map(shapeListing);

  const prevRes = await pool.query('SELECT * FROM listings');
  const prev = new Map(prevRes.rows.map((r) => [Number(r.lid), r]));
  const prevDay = addDays(dateIso, -1);
  const pvRes = await pool.query('SELECT lid, pv_tot FROM snap_d WHERE date = $1', [prevDay]);
  const pvPrev = new Map(pvRes.rows.map((r) => [Number(r.lid), r.pv_tot]));

  let changes = 0;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const r of rows) {
      const before = prev.get(r.lid);
      const d = diff(before, r);
      if (d) {
        changes++;
        await client.query(
          `INSERT INTO chlog (date, lid, tips, lauks, vecais, jaunais, avots, statuss, url)
           VALUES ($1,$2,$3,$4,$5,$6,'auto','gaida',$7)`,
          [dateIso, r.lid, d.tips, d.lauks, d.vecais, d.jaunais, r.url]
        );
      }
      await client.query(
        `INSERT INTO listings (lid,url,title,sku,st8,price,ccy,tags,img,desc_h,lastmod,created,last_seen)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         ON CONFLICT (lid) DO UPDATE SET
           url=EXCLUDED.url, title=EXCLUDED.title, sku=EXCLUDED.sku, st8=EXCLUDED.st8,
           price=EXCLUDED.price, ccy=EXCLUDED.ccy, tags=EXCLUDED.tags, img=EXCLUDED.img,
           desc_h=EXCLUDED.desc_h, lastmod=EXCLUDED.lastmod, created=EXCLUDED.created,
           last_seen=EXCLUDED.last_seen`,
        [r.lid, r.url, r.title, r.sku, r.st8, r.price, r.ccy, r.tags, r.img, r.desc_h,
         r.lastmod, r.created, dateIso]
      );

      const pvYesterday = pvPrev.get(r.lid);
      const pvD = r.pv_tot != null && pvYesterday != null ? r.pv_tot - Number(pvYesterday) : null;
      await client.query(
        `INSERT INTO snap_d (date, lid, pv_tot, pv_d, fav, ccy)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (date, lid) DO UPDATE SET
           pv_tot=EXCLUDED.pv_tot, pv_d=EXCLUDED.pv_d, fav=EXCLUDED.fav`,
        [dateIso, r.lid, r.pv_tot, pvD, r.fav, r.ccy]
      );
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  return { listings: rows.length, changes };
}

async function syncReceipts(dateIso) {
  const shop = await etsy.shopId();
  const { from, to } = dayBounds(dateIso);
  const receipts = await etsy.all(`/shops/${shop}/receipts`, { min_created: from, max_created: to });

  const agg = new Map();
  for (const rc of receipts) {
    for (const t of rc.transactions || []) {
      const lid = Number(t.listing_id);
      if (!lid) continue;
      const p = t.price || {};
      const unit = p.amount != null && p.divisor ? Number(p.amount) / Number(p.divisor) : 0;
      const qty = Number(t.quantity || 0);
      const cur = agg.get(lid) || { ord: 0, rev: 0, ccy: p.currency_code || null };
      cur.ord += qty;
      cur.rev += unit * qty;
      agg.set(lid, cur);
    }
  }

  for (const [lid, v] of agg) {
    await pool.query(
      `INSERT INTO snap_d (date, lid, ord, rev, ccy) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (date, lid) DO UPDATE SET
         ord=EXCLUDED.ord, rev=EXCLUDED.rev, ccy=COALESCE(snap_d.ccy, EXCLUDED.ccy)`,
      [dateIso, lid, v.ord, v.rev.toFixed(2), v.ccy]
    );
  }
  const orders = [...agg.values()].reduce((s, v) => s + v.ord, 0);
  const revenue = [...agg.values()].reduce((s, v) => s + v.rev, 0);
  return { receipts: receipts.length, orders, revenue: Number(revenue.toFixed(2)) };
}

async function runDaily(dateIso) {
  const date = dateIso || dayStr(new Date(), -1);
  const run = await pool.query('INSERT INTO runs DEFAULT VALUES RETURNING id');
  const runId = run.rows[0].id;
  try {
    const a = await syncListings(date);
    const b = await syncReceipts(date);
    const summary =
      `${date}: ${a.listings} listingi, ${a.changes} izmainas, ` +
      `${b.receipts} rekini, ${b.orders} vienibas, ${b.revenue}`;
    await pool.query('UPDATE runs SET ended = now(), ok = true, summary = $2 WHERE id = $1',
      [runId, summary]);
    await cfgSet('pedeja_darbiba', summary);
    await cfgSet('pedeja_diena', date);
    return { ok: true, date, ...a, ...b, summary };
  } catch (e) {
    const msg = String(e.message || e).slice(0, 500);
    await pool.query('UPDATE runs SET ended = now(), ok = false, summary = $2 WHERE id = $1',
      [runId, msg]);
    await cfgSet('pedeja_darbiba', `KLUDA ${date}: ${msg}`);
    throw e;
  }
}

module.exports = { runDaily, syncListings, syncReceipts, dayStr, addDays };
