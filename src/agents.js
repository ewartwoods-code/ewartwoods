// AI agentu registrs: katram savs modelis, sistemas prompts, budzets un
// (ja ir provisioning atslega) sava OpenRouter atslega ar cieto limitu.
const { pool } = require('./db');
const ai = require('./ai');

const PROV = process.env.OPENROUTER_PROVISIONING_KEY || '';
const PROV_BASE = 'https://openrouter.ai/api/v1/keys';
const DEF_MAX_TOK = Number(process.env.AGENT_MAX_TOKENS || 1200);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS agents (
vards text PRIMARY KEY,
apraksts text,
modelis text,
sys_prompt text,
budzets numeric,
periods text DEFAULT 'monthly',
max_tok integer,
or_key text,
or_hash text,
aktivs boolean DEFAULT true,
created timestamptz DEFAULT now()
);
CREATE TABLE IF NOT EXISTS ai_log (
id bigserial PRIMARY KEY,
ts timestamptz DEFAULT now(),
date date DEFAULT CURRENT_DATE,
agents text,
modelis text,
pt integer,
ct integer,
tt integer,
cost numeric,
ms integer,
ok boolean,
kluda text
);
CREATE INDEX IF NOT EXISTS ai_log_agent_idx ON ai_log (agents, date);
`;

let ready = false;
async function init() {
  if (ready) return;
  await pool.query(SCHEMA);
  ready = true;
}

const slug = (s) => String(s || '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

// Cik jau iztereets budzeta perioda. 'total' = kops sakuma.
function windowSql(periods) {
  if (periods === 'daily') return "date = CURRENT_DATE";
  if (periods === 'weekly') return "date > CURRENT_DATE - 7";
  if (periods === 'total') return "true";
  return "date >= date_trunc('month', CURRENT_DATE)::date"; // monthly
}

async function spent(vards, periods) {
  const r = await pool.query('SELECT COALESCE(SUM(cost),0)::numeric AS c, COALESCE(SUM(tt),0)::int AS tk, COUNT(*)::int AS n FROM ai_log WHERE agents = $1 AND ok = true AND ' + windowSql(periods), [vards]);
  return { cost: Number(r.rows[0].c), tokeni: r.rows[0].tk, izsaukumi: r.rows[0].n };
}

// --- OpenRouter atslegu parvaldiba (nav obligata) -------------------------

async function provCall(path, init) {
  if (!PROV) throw new Error('nav OPENROUTER_PROVISIONING_KEY');
  const r = await fetch(PROV_BASE + path, {
    ...init,
    headers: { Authorization: 'Bearer ' + PROV, 'Content-Type': 'application/json' },
  });
  const text = await r.text();
  let d = null;
  try { d = text ? JSON.parse(text) : null; } catch (_) {}
  if (!r.ok) throw new Error('OpenRouter keys ' + r.status + ': ' + ((d && d.error && d.error.message) || text.slice(0, 250)));
  return d;
}

// Izveido atsevisku atslegu ar cieto limitu. OpenRouter dokumentacija rada
// gan snake_case, gan camelCase lauku, tapec neveiksmes gadijuma meginam otru.
async function makeKey(vards, limit, reset) {
  const base = { name: 'agent:' + vards };
  if (limit != null) base.limit = Number(limit);
  const variants = [];
  if (reset && reset !== 'total') {
    variants.push({ ...base, limit_reset: reset });
    variants.push({ ...base, limitReset: reset });
  }
  variants.push(base);

  let last;
  for (const body of variants) {
    try {
      const d = await provCall('', { method: 'POST', body: JSON.stringify(body) });
      const key = d && (d.key || (d.data && d.data.key));
      const hash = d && ((d.data && d.data.hash) || d.hash);
      if (!key) throw new Error('atbilde bez atslegas: ' + JSON.stringify(d).slice(0, 200));
      return { key, hash };
    } catch (e) {
      last = e;
    }
  }
  throw last;
}

async function dropKey(hash) {
  if (!hash) return false;
  await provCall('/' + encodeURIComponent(hash), { method: 'DELETE' });
  return true;
}

// --- Registrs -------------------------------------------------------------

async function list() {
  await init();
  const { rows } = await pool.query('SELECT vards, apraksts, modelis, budzets, periods, max_tok, aktivs, (or_key IS NOT NULL) AS sava_atslega, created FROM agents ORDER BY vards');
  const out = [];
  for (const a of rows) {
    const s = await spent(a.vards, a.periods);
    out.push({
      ...a,
      budzets: a.budzets == null ? null : Number(a.budzets),
      izterets: Number(s.cost.toFixed(6)),
      tokeni: s.tokeni,
      izsaukumi: s.izsaukumi,
      atlicis: a.budzets == null ? null : Number((Number(a.budzets) - s.cost).toFixed(6)),
      limits: a.sava_atslega ? 'ciets (OpenRouter)' : a.budzets == null ? 'nav' : 'mikstais (kods)',
    });
  }
  return out;
}

async function get(vards) {
  await init();
  const r = await pool.query('SELECT * FROM agents WHERE vards = $1', [slug(vards)]);
  return r.rows[0] || null;
}

// Izveido vai atjauno agentu. provision:true meegina uztaisit tam savu
// OpenRouter atslegu ar cieto limitu (vajag OPENROUTER_PROVISIONING_KEY).
async function save(inp) {
  await init();
  const vards = slug(inp.vards || inp.name);
  if (!vards) throw new Error('vajag vardu');
  const esosais = await get(vards);

  const periods = ['daily', 'weekly', 'monthly', 'total'].includes(inp.periods) ? inp.periods : (esosais && esosais.periods) || 'monthly';
  const budzets = inp.budzets == null ? (esosais ? esosais.budzets : null) : Number(inp.budzets);

  let orKey = esosais ? esosais.or_key : null;
  let orHash = esosais ? esosais.or_hash : null;
  let piezime = null;

  if (inp.provision && !orKey) {
    try {
      const k = await makeKey(vards, budzets, periods);
      orKey = k.key;
      orHash = k.hash;
      piezime = 'izveidota sava OpenRouter atslega ar cieto limitu';
    } catch (e) {
      piezime = 'cieto limitu neizdevas uzlikt (' + e.message + '), paliek mikstais budzets';
    }
  }

  await pool.query(
    `INSERT INTO agents (vards, apraksts, modelis, sys_prompt, budzets, periods, max_tok, or_key, or_hash, aktivs)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (vards) DO UPDATE SET
       apraksts = COALESCE(EXCLUDED.apraksts, agents.apraksts),
       modelis = COALESCE(EXCLUDED.modelis, agents.modelis),
       sys_prompt = COALESCE(EXCLUDED.sys_prompt, agents.sys_prompt),
       budzets = EXCLUDED.budzets,
       periods = EXCLUDED.periods,
       max_tok = COALESCE(EXCLUDED.max_tok, agents.max_tok),
       or_key = COALESCE(EXCLUDED.or_key, agents.or_key),
       or_hash = COALESCE(EXCLUDED.or_hash, agents.or_hash),
       aktivs = EXCLUDED.aktivs`,
    [vards, inp.apraksts || null, inp.modelis || null, inp.sys || inp.sys_prompt || null, budzets, periods,
     inp.max_tok == null ? null : Number(inp.max_tok), orKey, orHash, inp.aktivs == null ? true : Boolean(inp.aktivs)]
  );

  const a = await get(vards);
  const s = await spent(vards, a.periods);
  return {
    vards, modelis: a.modelis || ai.MODEL, budzets: a.budzets == null ? null : Number(a.budzets),
    periods: a.periods, aktivs: a.aktivs, sava_atslega: Boolean(a.or_key),
    izterets: Number(s.cost.toFixed(6)), piezime,
  };
}

async function remove(vards) {
  await init();
  const a = await get(vards);
  if (!a) return { dzests: false, iemesls: 'nav tada agenta' };
  let atslega = 'nebija';
  if (a.or_hash) {
    try { await dropKey(a.or_hash); atslega = 'dzesta ari OpenRouter puse'; }
    catch (e) { atslega = 'OpenRouter atslegu nedzesa: ' + e.message; }
  }
  await pool.query('DELETE FROM agents WHERE vards = $1', [a.vards]);
  return { dzests: true, vards: a.vards, atslega };
}

// --- Palaisana ------------------------------------------------------------

async function run(vards, q, opts = {}) {
  await init();
  const a = await get(vards);
  if (!a) throw new Error('nav agenta "' + slug(vards) + '"');
  if (!a.aktivs) throw new Error('agents "' + a.vards + '" ir izslegts');

  // Mikstais budzets: nolasam pirms izsaukuma. Cietais (ja ir sava atslega)
  // strada OpenRouter puse un turas ari tad, ja sis kods klustu.
  const s = await spent(a.vards, a.periods);
  if (a.budzets != null && s.cost >= Number(a.budzets)) {
    const e = new Error('budzets izsmelts: ' + s.cost.toFixed(4) + ' no ' + Number(a.budzets).toFixed(4) + ' USD (' + a.periods + ')');
    e.budzets = true;
    throw e;
  }

  const t0 = Date.now();
  const modelis = opts.model || a.modelis || ai.MODEL;
  try {
    const out = await ai.chat(q, {
      model: modelis,
      system: a.sys_prompt || undefined,
      maxTokens: opts.maxTokens || a.max_tok || DEF_MAX_TOK,
      apiKey: a.or_key || undefined,
    });
    const u = out.lietojums || {};
    await pool.query('INSERT INTO ai_log (agents, modelis, pt, ct, tt, cost, ms, ok) VALUES ($1,$2,$3,$4,$5,$6,$7,true)',
      [a.vards, out.modelis, u.prompt_tokens || 0, u.completion_tokens || 0, u.total_tokens || 0, u.cost || 0, Date.now() - t0]);

    const pec = s.cost + Number(u.cost || 0);
    return {
      agents: a.vards, teksts: out.teksts, modelis: out.modelis, lietojums: u,
      budzets: a.budzets == null ? null : Number(a.budzets),
      izterets: Number(pec.toFixed(6)),
      atlicis: a.budzets == null ? null : Number((Number(a.budzets) - pec).toFixed(6)),
    };
  } catch (e) {
    await pool.query('INSERT INTO ai_log (agents, modelis, cost, ms, ok, kluda) VALUES ($1,$2,0,$3,false,$4)',
      [a.vards, modelis, Date.now() - t0, String(e.message).slice(0, 300)]);
    throw e;
  }
}

// Kopsavilkums panelim: 30 dienas un sodien, pa agentiem.
async function usage() {
  await init();
  const r = await pool.query(`
    SELECT COALESCE(agents,'(bez agenta)') AS agents,
           COUNT(*) FILTER (WHERE ok)::int AS izsaukumi,
           COUNT(*) FILTER (WHERE NOT ok)::int AS kludas,
           COALESCE(SUM(tt) FILTER (WHERE ok),0)::int AS tokeni,
           COALESCE(SUM(cost) FILTER (WHERE ok),0)::numeric AS cost,
           COALESCE(SUM(cost) FILTER (WHERE ok AND date = CURRENT_DATE),0)::numeric AS cost_sodien,
           MAX(ts) AS pedejais
    FROM ai_log WHERE date > CURRENT_DATE - 31
    GROUP BY 1 ORDER BY cost DESC`);
  return r.rows.map((x) => ({ ...x, cost: Number(x.cost), cost_sodien: Number(x.cost_sodien) }));
}

module.exports = { init, list, get, save, remove, run, usage, spent, slug };
