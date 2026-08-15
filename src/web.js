const http = require('http');
const { pool, cfgGet } = require('./db');
const sync = require('./sync');
const analyze = require('./analyze');
const store = require('./store');
const fx = require('./fx');
const ai = require('./ai');
const agents = require('./agents');

const ADMIN = process.env.ADMIN_TOKEN || '';

async function summary() {
  const last = await cfgGet('pedeja_darbiba');
  const day = await cfgGet('pedeja_diena');

const perPlatform = await pool.query('SELECT m.platform, COUNT(DISTINCT m.date)::int AS dienas, SUM(COALESCE(m.pv_d,0))::int AS pv, SUM(COALESCE(m.ord,0))::int AS ord, SUM(COALESCE(m.rev,0))::numeric AS rev, SUM(COALESCE(m.spend,0))::numeric AS spend, (SELECT COUNT(*) FROM items i WHERE i.platform = m.platform)::int AS preces, (SELECT COUNT(*) FROM chlog c WHERE c.platform = m.platform)::int AS izmainas FROM metrics m WHERE m.date > CURRENT_DATE - 31 GROUP BY m.platform ORDER BY m.platform');

const days = await pool.query('SELECT date, platform, SUM(COALESCE(pv_d,0))::int AS pv, SUM(COALESCE(ord,0))::int AS ord, SUM(COALESCE(rev,0))::numeric AS rev FROM metrics WHERE date > CURRENT_DATE - 15 GROUP BY date, platform ORDER BY date DESC, platform');

const changes = await pool.query('SELECT c.id, c.date, c.platform, c.ext_id, c.lauks, c.statuss, c.spriedums, c.url, i.title FROM chlog c LEFT JOIN items i ON i.platform = c.platform AND i.ext_id = c.ext_id ORDER BY c.date DESC, c.id DESC LIMIT 40');

// AI terins nedrikst nogazt paneli, ja tabulas vel nav.
let ai_agenti = [], ai_pedejie = [], ai_dienas = [];
try {
  ai_agenti = await agents.list();
  const p = await pool.query("SELECT ts, agents, modelis, pt, ct, tt, cost, ms, ok, kluda FROM ai_log ORDER BY id DESC LIMIT 20");
  ai_pedejie = p.rows;
  const dd = await pool.query("SELECT date, COALESCE(SUM(tt) FILTER (WHERE ok),0)::int AS tokeni, COALESCE(SUM(cost) FILTER (WHERE ok),0)::numeric AS cost, COUNT(*) FILTER (WHERE ok)::int AS izsaukumi FROM ai_log WHERE date > CURRENT_DATE - 15 GROUP BY date ORDER BY date DESC");
  ai_dienas = dd.rows;
} catch (_) {}

return { pedeja_darbiba: last, pedeja_diena: day, platformas: perPlatform.rows, dienas: days.rows, izmainas: changes.rows, ai_agenti, ai_pedejie, ai_dienas };
}

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const d10 = (v) => (v && v.toISOString ? v.toISOString().slice(0, 10) : String(v == null ? '' : v));
const money = (v) => Number(v || 0).toFixed(2);

const CSS = ':root{color-scheme:dark}body{margin:0;padding:20px;background:#14141c;color:#e8e8ee;font:15px/1.5 system-ui,sans-serif}h1{font-size:20px;letter-spacing:2px;margin:0 0 4px}h2{font-size:13px;text-transform:uppercase;letter-spacing:1px;opacity:.5;margin:28px 0 8px}.note{opacity:.55;font-size:13px}table{border-collapse:collapse;width:100%;max-width:1000px;font-size:14px}th,td{text-align:left;padding:6px 10px;border-bottom:1px solid #2a2a36;vertical-align:top}th{opacity:.5;font-weight:500;font-size:12px;text-transform:uppercase}td:nth-child(n+3),th:nth-child(n+3){text-align:right}table.chg td,table.chg th{text-align:left}a{color:#9db8ff;text-decoration:none}.bar{display:inline-block;width:70px;height:7px;background:#2a2a36;border-radius:4px;overflow:hidden;vertical-align:middle}.bar i{display:block;height:100%}.bad{color:#ff8b8b}td.bcell{white-space:nowrap}';

function page(d) {
  const plat = d.platformas.map((r) => '<tr><td>' + esc(r.platform) + '</td><td>' + esc(r.preces) + '</td><td>' + esc(r.dienas) + '</td><td>' + esc(r.pv) + '</td><td>' + esc(r.ord) + '</td><td>' + money(r.rev) + '</td><td>' + money(r.spend) + '</td><td>' + esc(r.izmainas) + '</td></tr>').join('');

const days = d.dienas.map((r) => '<tr><td>' + esc(d10(r.date)) + '</td><td>' + esc(r.platform) + '</td><td>' + esc(r.pv) + '</td><td>' + esc(r.ord) + '</td><td>' + money(r.rev) + '</td></tr>').join('');

const chg = d.izmainas.map((r) => {
  const name = esc(String(r.title || r.ext_id).slice(0, 55));
  const link = r.url ? '<a href="' + esc(r.url) + '">' + name + '</a>' : name;
  return '<tr><td>' + esc(d10(r.date)) + '</td><td>' + esc(r.platform) + '</td><td>' + link + '</td><td>' + esc(r.lauks) + '</td><td>' + esc(r.spriedums || r.statuss) + '</td></tr>';
}).join('');

const empty = (n) => '<tr><td colspan=' + n + ' class=note>nav datu</td></tr>';

const usd = (v) => '$' + Number(v || 0).toFixed(4);
const tk = (v) => Number(v || 0).toLocaleString('lv-LV');
const hhmm = (v) => (v && v.toISOString ? v.toISOString().slice(5, 16).replace('T', ' ') : String(v || ''));

// Agenti: cik apeests no budzeta, ar joslu, lai uzreiz redz, kurs tuvojas griestiem.
const agn = d.ai_agenti || [];
const ai_rows = agn.map((r) => {
  const pct = r.budzets ? Math.min(100, (r.izterets / r.budzets) * 100) : null;
  const josla = pct == null ? '<span class=note>bez budzeta</span>'
    : '<span class="bar"><i style="width:' + pct.toFixed(0) + '%;background:' + (pct >= 90 ? '#ff6b6b' : pct >= 60 ? '#e0b341' : '#6ec07a') + '"></i></span> ' + pct.toFixed(0) + '%';
  return '<tr><td>' + esc(r.vards) + (r.aktivs ? '' : ' <span class=note>(izslegts)</span>') + '</td>' +
    '<td>' + esc(r.modelis || '-') + '</td>' +
    '<td>' + esc(r.izsaukumi) + '</td>' +
    '<td>' + tk(r.tokeni) + '</td>' +
    '<td>' + usd(r.izterets) + '</td>' +
    '<td>' + (r.budzets == null ? '-' : usd(r.budzets)) + '</td>' +
    '<td>' + (r.atlicis == null ? '-' : usd(r.atlicis)) + '</td>' +
    '<td class=bcell>' + josla + '</td></tr>';
}).join('');

const ai_last = (d.ai_pedejie || []).map((r) => '<tr><td>' + esc(hhmm(r.ts)) + '</td><td>' + esc(r.agents || '-') + '</td><td>' + esc(r.modelis || '') + '</td><td>' + tk(r.pt) + '</td><td>' + tk(r.ct) + '</td><td>' + tk(r.tt) + '</td><td>' + usd(r.cost) + '</td><td>' + (r.ok ? esc(r.ms) + ' ms' : '<span class=bad>' + esc(String(r.kluda || 'kluda').slice(0, 60)) + '</span>') + '</td></tr>').join('');

const ai_dd = (d.ai_dienas || []).map((r) => '<tr><td>' + esc(d10(r.date)) + '</td><td>' + esc(r.izsaukumi) + '</td><td>' + tk(r.tokeni) + '</td><td>' + usd(r.cost) + '</td></tr>').join('');

const ai_kopa = agn.length
  ? '<div class="note">Kopa budzeta perioda: ' + tk(agn.reduce((a, r) => a + Number(r.tokeni || 0), 0)) + ' tokeni, ' + usd(agn.reduce((a, r) => a + Number(r.izterets || 0), 0)) + '</div>'
  : '';

return '<!doctype html><meta charset="utf-8"><title>EWART WOODS - dati</title>' +
  '<meta name="viewport" content="width=device-width,initial-scale=1">' +
  '<style>' + CSS + '</style>' +
  '<h1>EWART WOODS</h1>' +
  '<div class="note">Pedeja darbiba: ' + esc(d.pedeja_darbiba || 'vel nav palaista') + '</div>' +
  '<h2>Platformas (30 dienas)</h2>' +
  '<table><tr><th>Platforma</th><th>Preces</th><th>Dienas</th><th>PV</th><th>ORD</th><th>REV</th><th>Reklama</th><th>Izmainas</th></tr>' + (plat || empty(8)) + '</table>' +
  '<h2>Pedejas 14 dienas</h2>' +
  '<table><tr><th>Diena</th><th>Platforma</th><th>PV</th><th>ORD</th><th>REV</th></tr>' + (days || empty(5)) + '</table>' +
  '<h2>Izmainas un spriedumi</h2>' +
  '<table class="chg"><tr><th>Diena</th><th>Platforma</th><th>Prece</th><th>Lauks</th><th>Spriedums</th></tr>' + (chg || empty(5)) + '</table>' +
  '<h2>AI agenti - budzeta perioda</h2>' +
  '<table><tr><th>Agents</th><th>Modelis</th><th>Izsauk.</th><th>Tokeni</th><th>Izterets</th><th>Budzets</th><th>Atlicis</th><th>Apeests</th></tr>' + (ai_rows || empty(8)) + '</table>' +
  ai_kopa +
  '<h2>AI pa dienam (14 dienas)</h2>' +
  '<table><tr><th>Diena</th><th>Izsaukumi</th><th>Tokeni</th><th>Izmaksa</th></tr>' + (ai_dd || empty(4)) + '</table>' +
  '<h2>Pedejie AI izsaukumi</h2>' +
  '<table><tr><th>Laiks</th><th>Agents</th><th>Modelis</th><th>Ievade</th><th>Izvade</th><th>Kopa</th><th>Izmaksa</th><th>Ilgums</th></tr>' + (ai_last || empty(8)) + '</table>';
}

// Pienem gan ADMIN_TOKEN, gan servisa ingest_token.
async function ok(req, url) {
  const given = url.searchParams.get('token') || req.headers['x-admin-token'] || '';
  if (!given) return false;
  if (ADMIN && given === ADMIN) return true;
  const t = await cfgGet('ingest_token');
  return Boolean(t) && given === t;
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
      if (!(await ok(req, url))) return send(403, 'text/plain', 'nav atlaujas');
      return send(200, 'application/json', JSON.stringify(await summary(), null, 2));
    }

    if (url.pathname === '/run') {
      if (!(await ok(req, url))) return send(403, 'text/plain', 'nav atlaujas');
      const out = await sync.runDaily(url.searchParams.get('date') || undefined);
      return send(200, 'application/json', JSON.stringify(out, null, 2));
    }

    if (url.pathname === '/analyze') {
      if (!(await ok(req, url))) return send(403, 'text/plain', 'nav atlaujas');
      return send(200, 'application/json', JSON.stringify(await analyze.runAnalysis(), null, 2));
    }

    // Datiem, ko Railway pats nevar dabut (piem. Amazon caur Seller Labs).
    if (url.pathname === '/ingest' && req.method === 'POST') {
      if (!(await ok(req, url))) return send(403, 'text/plain', 'nav atlaujas');
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      const platform = String(body.platform || '').trim();
      const date = String(body.date || '').slice(0, 10);
      if (!platform || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(date)) {
        return send(400, 'text/plain', 'vajag platform un date');
      }
      const out = { platform, date };
      if (Array.isArray(body.items) && body.items.length) {
        Object.assign(out, await store.saveItems(platform, date, body.items));
      }
      if (Array.isArray(body.metrics) && body.metrics.length) {
        Object.assign(out, await store.saveMetrics(platform, date, body.metrics, Boolean(body.cumulativeViews)));
      }
      if (typeof body.mcsv === 'string' && body.mcsv.length) Object.assign(out, await store.saveMetrics(platform, date, body.mcsv.split(';').filter(Boolean).map((s) => { const p = s.split('|'); return { ext_id: p[0], date: p[1], pv_d: p[2] === '' ? null : Number(p[2]), ord: p[3] === '' ? null : Number(p[3]), rev: p[4] === '' ? null : Number(p[4]), spend: p[5] ? Number(p[5]) : null, clicks: p[6] ? Number(p[6]) : null, impr: p[7] ? Number(p[7]) : null, oos: p[8] === '1' ? true : (p[8] === '0' ? false : null), src: 'sl' }; })));
      if (Array.isArray(body.changes)) {
        for (const c of body.changes) {
          await pool.query("INSERT INTO chlog (date, platform, ext_id, lauks, tips, vecais, jaunais, apraksts, avots, statuss, url) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'manual','gaida',$9)", [date, platform, String(c.ext_id), c.lauks || null, c.tips || null, c.vecais || null, c.jaunais || null, c.apraksts || null, c.url || null]);
        }
        out.changes_manual = body.changes.length;
      }
      return send(200, 'application/json', JSON.stringify(out, null, 2));
    }
      // OpenRouter parbaude: vai atslega deriga, kads modelis, cik kredita.
      if (url.pathname === '/ai/status') {
        if (!(await ok(req, url))) return send(403, 'text/plain', 'nav atlaujas');
        return send(200, 'application/json', JSON.stringify(await ai.status(), null, 2));
      }

      // Viens jautajums modelim. GET: /ai?q=...  POST: {"q":"...","system":"...","model":"..."}
      if (url.pathname === '/ai') {
        if (!(await ok(req, url))) return send(403, 'text/plain', 'nav atlaujas');
        let b = {};
        if (req.method === 'POST') {
          const chunks = [];
          for await (const c of req) chunks.push(c);
          b = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        }
        const q = String(b.q || url.searchParams.get('q') || '').trim();
        if (!q) return send(400, 'text/plain', 'vajag q');
        const out = await ai.chat(q, {
          system: b.system || url.searchParams.get('system') || undefined,
          model: b.model || url.searchParams.get('model') || undefined,
          maxTokens: b.maxTokens || url.searchParams.get('maxTokens') || undefined,
        });
        return send(200, 'application/json', JSON.stringify(out, null, 2));
      }

      // Agentu saraksts ar teerinu, un izveide/atjaunosana.
      // POST /agents {"vards":"seo","modelis":"...","sys":"...","budzets":5,"periods":"monthly","provision":true}
      if (url.pathname === '/agents') {
        if (!(await ok(req, url))) return send(403, 'text/plain', 'nav atlaujas');
        if (req.method === 'POST') {
          const chunks = [];
          for await (const c of req) chunks.push(c);
          const b = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
          return send(200, 'application/json', JSON.stringify(await agents.save(b), null, 2));
        }
        return send(200, 'application/json', JSON.stringify(await agents.list(), null, 2));
      }

      if (url.pathname === '/agents/usage') {
        if (!(await ok(req, url))) return send(403, 'text/plain', 'nav atlaujas');
        return send(200, 'application/json', JSON.stringify(await agents.usage(), null, 2));
      }

      // Agenta palaisana: /agent/<vards>?q=...  vai DELETE tam pasam celam.
      if (url.pathname.startsWith('/agent/')) {
        if (!(await ok(req, url))) return send(403, 'text/plain', 'nav atlaujas');
        const vards = decodeURIComponent(url.pathname.slice('/agent/'.length));
        if (req.method === 'DELETE') {
          return send(200, 'application/json', JSON.stringify(await agents.remove(vards), null, 2));
        }
        let b = {};
        if (req.method === 'POST') {
          const chunks = [];
          for await (const c of req) chunks.push(c);
          b = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        }
        const q = String(b.q || url.searchParams.get('q') || '').trim();
        if (!q) return send(400, 'text/plain', 'vajag q');
        try {
          const out = await agents.run(vards, q, { model: b.model || undefined, maxTokens: b.maxTokens || undefined });
          return send(200, 'application/json', JSON.stringify(out, null, 2));
        } catch (e) {
          // Budzeta pieturu atdodam ka 429, lai izsaucejs to atskir no istas kludas.
          return send(e.budzets ? 429 : 500, 'application/json', JSON.stringify({ kluda: String(e.message) }, null, 2));
        }
      }

      if (url.pathname === '/api/fx') return send(200, 'application/json', JSON.stringify(await fx.monthly(url.searchParams.get('from') || '2024-01-01', url.searchParams.get('to') || '2030-01-01')));
      if (url.pathname === '/fx') { if (!(await ok(req, url))) return send(403, 'text/plain', 'nav atlaujas'); return send(200, 'application/json', JSON.stringify(await fx.refresh(url.searchParams.get('full') === '1'))); }
      if (url.pathname === '/mcreg') { if (!(await ok(req, url))) return send(403, 'text/plain', 'nav atlaujas'); const g = require('./google'); const t = await g.token('https://www.googleapis.com/auth/content'); const out = []; for (const a of ['5802772116', '191177237', '5802814146']) { const rr = await fetch('https://merchantapi.googleapis.com/accounts/v1/accounts/' + a + '/developerRegistration:registerGcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + t }, body: JSON.stringify({ developerEmail: url.searchParams.get('email') || '' }) }); out.push({ konts: a, st: rr.status, atbilde: (await rr.text()).slice(0, 250) }); } return send(200, 'application/json', JSON.stringify(out, null, 2)); }

    // Panelis rada pardosanas un AI terina datus, tapec ari tas ir aiz tokena.
    if (!(await ok(req, url))) {
      return send(403, 'text/html', '<!doctype html><meta charset="utf-8"><title>EWART WOODS</title>' +
        '<meta name="viewport" content="width=device-width,initial-scale=1">' +
        '<style>' + CSS + '</style><h1>EWART WOODS</h1>' +
        '<p class="note">Sim panelim vajag tokenu: pievieno adresei <code>?token=...</code></p>');
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
