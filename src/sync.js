const { pool, cfgSet } = require('./db');
const store = require('./store');
const etsy = require('./etsy');
const shopify = require('./shopify');
const google = require('./google');

const TZ = process.env.TZ_NAME || 'Europe/Riga';
const ETSY_STATES = ['active', 'inactive', 'draft', 'sold_out', 'expired'];

function dayStr(d = new Date(), offsetDays = 0) {
  const t = new Date(d.getTime() + offsetDays * 86400000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(t);
}

function addDays(iso, n) {
  const d = new Date(iso + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function dayBounds(iso) {
  const probe = new Date(iso + 'T12:00:00Z');
  const local = new Date(probe.toLocaleString('en-US', { timeZone: TZ }));
  const utc = new Date(probe.toLocaleString('en-US', { timeZone: 'UTC' }));
  const offsetMs = local.getTime() - utc.getTime();
  const start = Date.parse(iso + 'T00:00:00Z') - offsetMs;
  return { from: Math.floor(start / 1000), to: Math.floor(start / 1000) + 86399 };
}

// ETSY
function shapeEtsy(l) {
  const p = l.price || {};
  const imgs = (l.images || []).map((i) => i.listing_image_id).join(',');
  return {
    ext_id: String(l.listing_id),
    url: l.url || 'https://www.etsy.com/listing/' + l.listing_id,
    title: l.title || '',
    sku: (l.skus || []).join(','),
    st8: l.state || '',
    price: p.amount != null && p.divisor ? Number(p.amount) / Number(p.divisor) : null,
    ccy: p.currency_code || null,
    tags: (l.tags || []).join(', '),
    img: store.hash(imgs),
    desc_h: store.hash(l.description),
    seo_h: null,
    extra: { materials: l.materials || [], quantity: l.quantity == null ? null : l.quantity },
    lastmod: Number(l.last_modified_timestamp || 0),
    created: Number(l.original_creation_timestamp || 0),
    pv_tot: l.views == null ? null : Number(l.views),
    fav: l.num_favorers == null ? null : Number(l.num_favorers)
  };
}

async function etsyListings(shop) {
  const seen = new Map();
  for (const st of ETSY_STATES) {
    const rows = await etsy.all('/shops/' + shop + '/listings', { state: st, includes: 'Images' });
    for (const l of rows) seen.set(String(l.listing_id), l);
  }
  return [...seen.values()].map(shapeEtsy);
}

async function syncEtsy(dateIso) {
  const shop = await etsy.shopId();
  const rows = await etsyListings(shop);
  const a = await store.saveItems('etsy', dateIso, rows);
  await store.saveMetrics('etsy', dateIso, rows.map((r) => ({ ext_id: r.ext_id, pv_tot: r.pv_tot, fav: r.fav, ccy: r.ccy })), true);

const { from, to } = dayBounds(dateIso);
  const receipts = await etsy.all('/shops/' + shop + '/receipts', { min_created: from, max_created: to });
  const agg = new Map();
  for (const rc of receipts) {
    for (const t of rc.transactions || []) {
      const id = String(t.listing_id || '');
      if (!id || id === 'null') continue;
      const p = t.price || {};
      const unit = p.amount != null && p.divisor ? Number(p.amount) / Number(p.divisor) : 0;
      const qty = Number(t.quantity || 0);
      const cur = agg.get(id) || { ext_id: id, ord: 0, rev: 0, ccy: p.currency_code || null };
      cur.ord += qty;
      cur.rev += unit * qty;
      agg.set(id, cur);
    }
  }
  const sales = [...agg.values()].map((v) => ({ ...v, rev: Number(v.rev.toFixed(2)) }));
  await store.saveMetrics('etsy', dateIso, sales);

return { platform: 'etsy', items: a.items, changes: a.changes, orders: sales.reduce((s, v) => s + v.ord, 0), revenue: Number(sales.reduce((s, v) => s + v.rev, 0).toFixed(2)) };
}

// SHOPIFY
async function syncShopify(dateIso) {
  const rows = await shopify.products();
  const a = await store.saveItems('shopify', dateIso, rows);
  const { list } = await shopify.dayOrders(dateIso);
  await store.saveMetrics('shopify', dateIso, list);
  return { platform: 'shopify', items: a.items, changes: a.changes, orders: list.reduce((s, v) => s + v.ord, 0), revenue: Number(list.reduce((s, v) => s + v.rev, 0).toFixed(2)) };
}

// GOOGLE: Search Console lapu dati un GA4 sesijas.
// GA4 sesijas rakstam Shopify precem, jo Shopify pats skatijumus nedod.
async function syncGoogle(dateIso) {
  const res = await pool.query("SELECT ext_id, extra->>'handle' AS handle FROM items WHERE platform = 'shopify'");
  const byHandle = new Map(res.rows.filter((r) => r.handle).map((r) => [String(r.handle).toLowerCase(), String(r.ext_id)]));

const gscRows = await google.gsc(dateIso);
  const ga4Rows = await google.ga4(dateIso);

const gmet = gscRows.map((r) => {
  const h = google.handleOf(r.page);
  const pid = h ? byHandle.get(h) : null;
  const path = String(r.page).replace(/^https?:\/\/[^/]+/, '') || '/';
  return { ext_id: pid || ('page:' + path), pv_d: r.clicks, clicks: r.clicks, impr: r.impressions, src: 'gsc' };
});
  if (gmet.length) await store.saveMetrics('google', dateIso, gmet);

const smet = [];
  for (const r of ga4Rows) {
    const h = google.handleOf(r.path);
    const pid = h ? byHandle.get(h) : null;
    if (pid) smet.push({ ext_id: pid, pv_d: r.sessions, src: 'ga4' });
  }
  if (smet.length) await store.saveMetrics('shopify', dateIso, smet);

return { platform: 'google', items: gmet.length, changes: 0, orders: 0, revenue: 0, ga4_lapas: smet.length };
}

// ORKESTRATORS
async function runDaily(dateIso) {
  const date = dateIso || dayStr(new Date(), -1);
  const run = await pool.query('INSERT INTO runs DEFAULT VALUES RETURNING id');
  const runId = run.rows[0].id;

const jobs = [['etsy', syncEtsy]];
  if (shopify.enabled()) jobs.push(['shopify', syncShopify]);
  if (google.enabled()) jobs.push(['google', syncGoogle]);

const done = [], failed = [];
  for (const [name, fn] of jobs) {
    try {
      done.push(await fn(date));
    } catch (e) {
      failed.push(name + ': ' + String(e.message || e).slice(0, 200));
    }
  }

const parts = done.map((r) => r.platform + ' ' + r.items + ' preces, ' + r.changes + ' izmainas, ' + r.orders + ' vien., ' + r.revenue);
  const summary = date + ' | ' + (parts.join(' | ') || 'nekas nesanaca') + (failed.length ? ' | KLUDAS: ' + failed.join('; ') : '');

await pool.query('UPDATE runs SET ended = now(), ok = $2, summary = $3 WHERE id = $1', [runId, done.length > 0, summary]);
  await cfgSet('pedeja_darbiba', summary);
  if (done.length) await cfgSet('pedeja_diena', date);
  if (!done.length) throw new Error(summary);

return { ok: true, date, platformas: done, kludas: failed, summary };
}

module.exports = { runDaily, syncEtsy, syncShopify, syncGoogle, dayStr, addDays };
