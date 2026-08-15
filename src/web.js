const http = require('http');
const { pool, cfgGet } = require('./db');
const sync = require('./sync');

const ADMIN = process.env.ADMIN_TOKEN || '';

async function summary() {
  const day = await cfgGet('pedeja_diena');
  const last = await cfgGet('pedeja_darbiba');
  const shop = await cfgGet('etsy_shop_name');

  const totals = await pool.query(
    `SELECT date,
            SUM(COALESCE(pv_d,0))::int  AS pv,
            SUM(COALESCE(ord,0))::int   AS ord,
            SUM(COALESCE(rev,0))::numeric AS rev
       FROM snap_d
      WHERE date > CURRENT_DATE - 15
      GROUP BY date ORDER BY date DESC`
  );
  const top = await pool.query(
    `SELECT s.lid, l.title, l.url,
            SUM(COALESCE(s.pv_d,0))::int AS pv,
            SUM(COALESCE(s.ord,0))::int  AS ord,
            SUM(COALESCE(s.rev,0))::numeric AS rev
       FROM snap_d s LEFT JOIN listings l ON l.lid = s.lid
      WHERE s.date > CURRENT_DATE - 15
      GROUP BY s.lid, l.title, l.url
      ORDER BY ord DESC, pv DESC LIMIT 15`
  );
  const changes = await pool.query(
    `SELECT c.date, c.lid, c.lauks, c.statuss, c.spriedums, l.title
       FROM chlog c LEFT JOIN listings l ON l.lid = c.lid
      ORDER BY c.date DESC, c.id DESC LIMIT 25`
  );
  const counts = await pool.query(
    `SELECT (SELECT COUNT(*) FROM listings)::int AS listings,
            (SELECT COUNT(*) FROM chlog)::int    AS changes,
            (SELECT COUNT(DISTINCT date) FROM snap_d)::int AS days`
  );

  return {
    shop: shop || null,
    pedeja_diena: day,
    pedeja_darbiba: last,
    skaits: counts.rows[0],
    dienas: totals.rows,
    top: top.rows,
    izmainas: changes.rows
  };
}

const esc = (s) =>
  String(s == null ? '' : s).replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const d10 = (v) => (v && v.toISOString ? v.toISOString().slice(0, 10) : String(v == null ? '' : v));

function page(d) {
  const rowsDays = d.dienas
    .map((r) => `<tr><td>${esc(d10(r.date))}</td><td>${esc(r.pv)}</td><td>${esc(r.ord)}</td><td>${esc(Number(r.rev).toFixed(2))}</td></tr>`)
    .join('');
  const rowsTop = d.top
    .map((r) => `<tr><td><a href="${esc(r.url)}">${esc(String(r.title || r.lid).slice(0, 60))}</a></td><td>${esc(r.pv)}</td><td>${esc(r.ord)}</td><td>${esc(Number(r.rev).toFixed(2))}</td></tr>`)
    .join('');
  const rowsChg = d.izmainas
    .map((r) => `<tr><td>${esc(d10(r.date))}</td><td>${esc(String(r.title || r.lid).slice(0, 50))}</td><td>${esc(r.lauks)}</td><td>${esc(r.spriedums || r.statuss)}</td></tr>`)
    .join('');

  return `<!doctype html><meta charset="utf-8"><title>EWART WOODS - Etsy dati</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{color-scheme:dark}
body{margin:0;padding:20px;background:#14141c;color:#e8e8ee;font:15px/1.5 system-ui,sans-serif}
h1{font-size:20px;letter-spacing:2px;margin:0 0 4px}
h2{font-size:14px;text-transform:uppercase;letter-spacing:1px;opacity:.55;margin:28px 0 8px}
.note{opacity:.6;font-size:13px}
table{border-collapse:collapse;width:100%;max-width:900px;font-size:14px}
th,td{text-align:left;padding:6px 10px;border-bottom:1px solid #2a2a36}
th{opacity:.55;font-weight:500;font-size:12px;text-transform:uppercase}
td:nth-child(n+2),th:nth-child(n+2){text-align:right}
a{color:#9db8ff;text-decoration:none}
</style>
<h1>EWART WOODS</h1>
<div class="note">Etsy dienas dati${d.shop ? ' - ' + esc(d.shop) : ''} - ${esc(d.skaits.listings)} listingi, ${esc(d.skaits.days)} dienas, ${esc(d.skaits.changes)} izmainas</div>
<div class="note">Pedeja darbiba: ${esc(d.pedeja_darbiba || 'vel nav palaista')}</div>
<h2>Pedejas 14 dienas</h2>
<table><tr><th>Diena</th><th>PV</th><th>ORD</th><th>REV</th></tr>${rowsDays || '<tr><td colspan=4 class=note>nav datu</td></tr>'}</table>
<h2>Top listingi</h2>
<table><tr><th>Listings</th><th>PV</th><th>ORD</th><th>REV</th></tr>${rowsTop || '<tr><td colspan=4 class=note>nav datu</td></tr>'}</table>
<h2>Pedejas izmainas</h2>
<table><tr><th>Diena</th><th>Listings</th><th>Lauks</th><th>Statuss</th></tr>${rowsChg || '<tr><td colspan=4 class=note>nav datu</td></tr>'}</table>`;
}

function start(port) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const send = (code, type, body) => {
      res.writeHead(code, { 'Content-Type': type + '; charset=utf-8' });
      res.end(body);
    };
    try {
      if (url.pathname === '/health') return send(200, 'text/plain', 'ok');

      if (url.pathname === '/api/summary') {
        return send(200, 'application/json', JSON.stringify(await summary(), null, 2));
      }

      if (url.pathname === '/run') {
        const given = url.searchParams.get('token') || '';
        if (!ADMIN || given !== ADMIN) return send(403, 'text/plain', 'nav atlaujas');
        const date = url.searchParams.get('date') || undefined;
        const out = await sync.runDaily(date);
        return send(200, 'application/json', JSON.stringify(out, null, 2));
      }

      return send(200, 'text/html', page(await summary()));
    } catch (e) {
      send(500, 'text/plain', 'Kluda: ' + String(e.message || e));
    }
  });
  server.listen(port, () => console.log('web on', port));
  return server;
}

module.exports = { start, summary };
